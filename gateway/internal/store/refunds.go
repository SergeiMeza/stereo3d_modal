package store

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Refund ledger (spec C8): refunds_{env}/{pi}_{case}_{k}, one row per
// refund, recorded per run. Rows are reserved in ONE transaction on the
// charge document (charges_{env}/{charge_id}, refund_seq), so refunds on
// a charge serialize and pending rows count (v6.1 W2).

// Refund row statuses.
const (
	RefundPending    = "pending"
	RefundSucceeded  = "succeeded"
	RefundFailed     = "failed"
	RefundCanceled   = "canceled"
	RefundOutOfBand  = "out_of_band"
	UnassignedRefund = "_unassigned"
)

// ErrNothingRefundable: the case's maximum is 0 (already covered).
var ErrNothingRefundable = errors.New("nothing left to refund")

// RefundRow is one ledger row.
type RefundRow struct {
	ID           string           `firestore:"-" json:"id"`
	CaseID       string           `firestore:"case_id" json:"case_id"`
	UID          string           `firestore:"uid" json:"-"`
	PI           string           `firestore:"pi" json:"pi"`
	ChargeID     string           `firestore:"charge_id" json:"charge_id"`
	ReID         string           `firestore:"re_id,omitempty" json:"re_id,omitempty"`
	Items        map[string]int64 `firestore:"items" json:"items"`
	TotalCents   int64            `firestore:"total_cents" json:"total_cents"`
	Status       string           `firestore:"status" json:"status"`
	Source       string           `firestore:"source" json:"source"` // gateway | dashboard
	K            int              `firestore:"k" json:"k"`
	Note         string           `firestore:"note,omitempty" json:"note,omitempty"`
	FailReason   string           `firestore:"fail_reason,omitempty" json:"fail_reason,omitempty"`
	CreditNoteID string           `firestore:"credit_note_id,omitempty" json:"credit_note_id,omitempty"`
	CreatedAt    time.Time        `firestore:"created_at" json:"created_at"`
	UpdatedAt    time.Time        `firestore:"updated_at" json:"updated_at"`
}

// Counts: pending, succeeded and out-of-band rows hold their cents.
func (r *RefundRow) Counts() bool {
	return r.Status == RefundPending || r.Status == RefundSucceeded || r.Status == RefundOutOfBand
}

func refundsCol(env string) string { return "refunds_" + env }

func (s *Store) refundDoc(id string) *firestore.DocumentRef {
	return s.fs.Collection(refundsCol(s.env)).Doc(id)
}

func snapToRefund(snap *firestore.DocumentSnapshot) (*RefundRow, error) {
	var r RefundRow
	if err := snap.DataTo(&r); err != nil {
		return nil, err
	}
	r.ID = snap.Ref.ID
	return &r, nil
}

// ChargeRefundable is the live picture of a charge (C8): per-run price,
// refunded so far (pending included) and refundable now; the charge
// remainder; the unassigned Dashboard cents.
type ChargeRefundable struct {
	Price      map[string]int64 `json:"price"`
	Refunded   map[string]int64 `json:"refunded"`
	Refundable map[string]int64 `json:"refundable"`
	Remainder  int64            `json:"remainder_cents"`
	Unassigned int64            `json:"unassigned_cents"`
}

// computeRefundable folds ledger rows into the per-run picture.
// stripeRemainder (amount_received − amount_refunded − lost disputes,
// read from Stripe) caps the charge; -1 = unknown.
func computeRefundable(ch *Charge, rows []*RefundRow, stripeRemainder int64) ChargeRefundable {
	out := ChargeRefundable{Price: map[string]int64{}, Refunded: map[string]int64{}, Refundable: map[string]int64{}}
	for _, l := range ch.Lines {
		out.Price[l.ConversionID] += l.AmountCents
	}
	var ledger int64
	for _, r := range rows {
		if !r.Counts() {
			continue
		}
		ledger += r.TotalCents
		for id, c := range r.Items {
			if id == UnassignedRefund {
				out.Unassigned += c
				continue
			}
			out.Refunded[id] += c
		}
	}
	out.Remainder = ch.AmountCents - ledger
	if stripeRemainder >= 0 {
		// Stripe's view, minus our pending rows it hasn't seen yet.
		var notYet int64
		for _, r := range rows {
			if r.Status == RefundPending && r.ReID == "" {
				notYet += r.TotalCents
			}
		}
		out.Remainder = min(out.Remainder, stripeRemainder-notYet)
	}
	out.Remainder = max(out.Remainder, 0)
	for id, p := range out.Price {
		out.Refundable[id] = max(p-out.Refunded[id], 0)
	}
	return out
}

// ReserveSpec is one refund to reserve.
type ReserveSpec struct {
	ChargeID        string
	UID             string
	PI              string
	CaseID          string
	Items           map[string]int64 // conversion → cents wanted
	StripeRemainder int64            // -1 unknown
	Source          string
	Note            string
	Status          string // "" = pending; out_of_band for C8's console action
	// Charge to create when the charge has no record yet (a late or
	// duplicate payment, a run charged before records existed).
	Fallback *Charge
	// Unassigned: a Dashboard refund that matched no single run (W1).
	Unassigned bool
}

// ReserveRefund recomputes the refundable amounts and writes the ledger
// row in ONE transaction on the charge document (C8 step 1, v6.1 W2):
// every run's cents capped at its refundable, the total at the charge
// remainder minus unassigned cents; 0 → ErrNothingRefundable.
func (s *Store) ReserveRefund(ctx context.Context, spec ReserveSpec) (*RefundRow, error) {
	var out *RefundRow
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		out = nil
		cref := s.chargeDoc(spec.ChargeID)
		csnap, err := tx.Get(cref)
		var ch *Charge
		switch {
		case status.Code(err) == codes.NotFound:
			if spec.Fallback == nil {
				return fmt.Errorf("charge %s: %w", spec.ChargeID, ErrNotFound)
			}
			fb := *spec.Fallback
			fb.ID = spec.ChargeID
			if fb.InvoiceState == "" {
				fb.InvoiceState = InvoiceSkipped
			}
			ch = &fb
		case err != nil:
			return err
		default:
			if ch, err = snapToCharge(csnap); err != nil {
				return err
			}
		}
		rsnaps, err := tx.Documents(s.fs.Collection(refundsCol(s.env)).Where("pi", "==", spec.PI)).GetAll()
		if err != nil {
			return err
		}
		var rows []*RefundRow
		k := 0
		for _, rs := range rsnaps {
			r, err := snapToRefund(rs)
			if err != nil {
				return err
			}
			rows = append(rows, r)
			if r.CaseID == spec.CaseID {
				k = max(k, r.K)
			}
		}
		live := computeRefundable(ch, rows, spec.StripeRemainder)
		items := map[string]int64{}
		var total int64
		if spec.Unassigned {
			for _, c := range spec.Items {
				total += c
			}
			total = min(total, live.Remainder-live.Unassigned)
			if total > 0 {
				items[UnassignedRefund] = total
			}
		} else {
			ids := make([]string, 0, len(spec.Items))
			for id := range spec.Items {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			room := live.Remainder - live.Unassigned
			for _, id := range ids {
				c := min(spec.Items[id], live.Refundable[id], max(room-total, 0))
				if c > 0 {
					items[id] = c
					total += c
				}
			}
		}
		if total <= 0 {
			return ErrNothingRefundable
		}
		now := time.Now().UTC()
		st := spec.Status
		if st == "" {
			st = RefundPending
		}
		row := &RefundRow{ID: fmt.Sprintf("%s_%s_%d", spec.PI, spec.CaseID, k+1), CaseID: spec.CaseID, UID: spec.UID, PI: spec.PI, ChargeID: spec.ChargeID,
			Items: items, TotalCents: total, Status: st, Source: spec.Source, K: k + 1, Note: spec.Note, CreatedAt: now, UpdatedAt: now}
		ch.RefundSeq++
		ch.UpdatedAt = now
		if err := tx.Set(cref, ch); err != nil {
			return err
		}
		out = row
		return tx.Create(s.refundDoc(row.ID), row)
	})
	return out, err
}

// UpdateRefundRow mutates a ledger row.
func (s *Store) UpdateRefundRow(ctx context.Context, id string, mutate func(r *RefundRow) error) (*RefundRow, error) {
	var out *RefundRow
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(s.refundDoc(id))
		if err != nil {
			return err
		}
		r, err := snapToRefund(snap)
		if err != nil {
			return err
		}
		if err := mutate(r); err != nil {
			return err
		}
		r.UpdatedAt = time.Now().UTC()
		out = r
		return tx.Set(s.refundDoc(id), r)
	})
	return out, err
}

// ListRefundRows lists a PaymentIntent's ledger rows.
func (s *Store) ListRefundRows(ctx context.Context, pi string) ([]*RefundRow, error) {
	iter := s.fs.Collection(refundsCol(s.env)).Where("pi", "==", pi).Documents(ctx)
	defer iter.Stop()
	var out []*RefundRow
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		r, err := snapToRefund(snap)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
}

// RefundRowByReID finds the row of a Stripe refund (nil if none).
func (s *Store) RefundRowByReID(ctx context.Context, reID string) (*RefundRow, error) {
	iter := s.fs.Collection(refundsCol(s.env)).Where("re_id", "==", reID).Limit(1).Documents(ctx)
	defer iter.Stop()
	snap, err := iter.Next()
	if isIterDone(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return snapToRefund(snap)
}

// Refundable reads a charge's live picture (no reservation).
func (s *Store) Refundable(ctx context.Context, chargeID, pi string, stripeRemainder int64) (*Charge, ChargeRefundable, error) {
	ch, err := s.GetCharge(ctx, chargeID)
	if err != nil {
		return nil, ChargeRefundable{}, err
	}
	rows, err := s.ListRefundRows(ctx, pi)
	if err != nil {
		return nil, ChargeRefundable{}, err
	}
	return ch, computeRefundable(ch, rows, stripeRemainder), nil
}

// FindChargeByPI finds a charge record by its PaymentIntent (nil if none).
func (s *Store) FindChargeByPI(ctx context.Context, pi string) (*Charge, error) {
	iter := s.fs.Collection(chargesCol(s.env)).Where("payment_intent_id", "==", pi).Limit(1).Documents(ctx)
	defer iter.Stop()
	snap, err := iter.Next()
	if isIterDone(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return snapToCharge(snap)
}

// ListUserRefundRows lists an account's ledger rows (history).
func (s *Store) ListUserRefundRows(ctx context.Context, uid string, limit int) ([]*RefundRow, error) {
	iter := s.fs.Collection(refundsCol(s.env)).Where("uid", "==", uid).Limit(limit).Documents(ctx)
	defer iter.Stop()
	var out []*RefundRow
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		r, err := snapToRefund(snap)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
}

// ListRefundRowsByStatus lists ledger rows in a status (the refund sweep).
func (s *Store) ListRefundRowsByStatus(ctx context.Context, st string, limit int) ([]*RefundRow, error) {
	iter := s.fs.Collection(refundsCol(s.env)).Where("status", "==", st).Limit(limit).Documents(ctx)
	defer iter.Stop()
	var out []*RefundRow
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		r, err := snapToRefund(snap)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
}

// ReadConfig reads config/{name} into out (ErrNotFound when absent).
func (s *Store) ReadConfig(ctx context.Context, name string, out any) error {
	snap, err := s.fs.Collection("config").Doc(name).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	return snap.DataTo(out)
}
