package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Settle states (C11).
const (
	SettleSettling = "settling" // scoped, its payment open or being taken
	SettlePaid     = "paid"
	SettleClosed   = "closed" // not paid; its items went back to owed
)

// Settle payment display (C10 settle.payment_state).
const (
	SettleOpen       = "open"
	SettleInProgress = "in_progress"
)

// BatchSettling / PISettling: an owed group or run inside a live settle;
// every other collector skips them.
const (
	BatchSettling = "settling"
	PISettling    = "settling"
)

// SettleItem is one owed item a settle collects: a failed group or a run
// whose own charge failed.
type SettleItem struct {
	Kind          string   `firestore:"kind"` // group | run
	ID            string   `firestore:"id"`
	AmountCents   int64    `firestore:"amount_cents"`
	ConversionIDs []string `firestore:"conversion_ids,omitempty"`
	// PaymentIntentID: a per-run item's old PaymentIntent (cancelled
	// before the settle charges, C11 step 3).
	PaymentIntentID string `firestore:"payment_intent_id,omitempty"`
}

// Settle is one collection of everything an account owes (C11):
// settles_{env}/{uid}_{n}.
type Settle struct {
	ID              string       `firestore:"-" json:"settle_id"`
	UID             string       `firestore:"uid" json:"-"`
	State           string       `firestore:"state" json:"state"`
	Trigger         string       `firestore:"trigger" json:"trigger"`
	Items           []SettleItem `firestore:"items" json:"-"`
	AmountCents     int64        `firestore:"amount_cents" json:"amount_cents"`
	Currency        string       `firestore:"currency" json:"currency"`
	PaymentState    string       `firestore:"payment_state,omitempty" json:"payment_state,omitempty"`
	CurrentPayment  *Payment     `firestore:"current_payment,omitempty" json:"-"`
	Payments        []Payment    `firestore:"payments,omitempty" json:"-"`
	Lease           *Lease       `firestore:"lease,omitempty" json:"-"`
	PaymentIntentID string       `firestore:"payment_intent_id,omitempty" json:"-"`
	PaidWith        string       `firestore:"paid_with,omitempty" json:"-"`
	PaidCents       int64        `firestore:"paid_cents,omitempty" json:"-"`
	Error           string       `firestore:"error,omitempty" json:"-"`
	CreatedAt       time.Time    `firestore:"created_at" json:"created_at"`
	UpdatedAt       time.Time    `firestore:"updated_at" json:"-"`
	PaidAt          *time.Time   `firestore:"paid_at,omitempty" json:"paid_at,omitempty"`
}

// Runs counts the runs a settle pays for.
func (st *Settle) Runs() int {
	n := 0
	for _, it := range st.Items {
		if it.Kind == "run" {
			n++
		} else {
			n += len(it.ConversionIDs)
		}
	}
	return n
}

func settlesCol(env string) string { return "settles_" + env }

func (s *Store) settleDoc(id string) *firestore.DocumentRef {
	return s.fs.Collection(settlesCol(s.env)).Doc(id)
}

func snapToSettle(snap *firestore.DocumentSnapshot) (*Settle, error) {
	var st Settle
	if err := snap.DataTo(&st); err != nil {
		return nil, err
	}
	st.ID = snap.Ref.ID
	return &st, nil
}

// ErrSettleLive: the account already has a live settle (returned with it).
var ErrSettleLive = errors.New("a settle is live")

// ErrNothingOwed: the account owes nothing.
var ErrNothingOwed = errors.New("nothing owed")

func (s *Store) GetSettle(ctx context.Context, id string) (*Settle, error) {
	snap, err := s.settleDoc(id).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return snapToSettle(snap)
}

// LiveSettle is the account's live settle, nil when none.
func (s *Store) LiveSettle(ctx context.Context, uid string) (*Settle, error) {
	iter := s.fs.Collection(settlesCol(s.env)).Where("uid", "==", uid).Where("state", "==", SettleSettling).Limit(1).Documents(ctx)
	defer iter.Stop()
	snap, err := iter.Next()
	if isIterDone(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return snapToSettle(snap)
}

// ListSettlesByState lists settles (reconciler sweeps).
func (s *Store) ListSettlesByState(ctx context.Context, state string, limit int) ([]*Settle, error) {
	iter := s.fs.Collection(settlesCol(s.env)).Where("state", "==", state).Limit(limit).Documents(ctx)
	defer iter.Stop()
	var out []*Settle
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		st, err := snapToSettle(snap)
		if err != nil {
			return nil, err
		}
		out = append(out, st)
	}
}

// OpenSettle scopes a settle in ONE transaction (C11 step 2): it fails
// with ErrSettleLive (and the live one) when the account has one, with
// ErrNothingOwed when nothing is owed; otherwise it writes the settle
// (settling, leased) and moves every owed item — failed groups and runs
// whose own charge failed — to settling, so no other collector touches
// them.
func (s *Store) OpenSettle(ctx context.Context, uid, trigger string, lease Lease) (*Settle, error) {
	var out *Settle
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		out = nil
		custRef := s.fs.Collection(customersCol(s.env)).Doc(uid)
		csnap, err := tx.Get(custRef)
		if err != nil {
			return err
		}
		var cust Customer
		if err := csnap.DataTo(&cust); err != nil {
			return err
		}
		if cust.LiveSettleID != "" {
			lsnap, lerr := tx.Get(s.settleDoc(cust.LiveSettleID))
			if lerr == nil {
				if live, derr := snapToSettle(lsnap); derr == nil && live.State == SettleSettling {
					out = live
					return ErrSettleLive
				}
			}
		}
		gsnaps, err := tx.Documents(s.fs.Collection(batchesCol(s.env)).Where("uid", "==", uid).Where("state", "==", BatchFailed)).GetAll()
		if err != nil {
			return err
		}
		rsnaps, err := tx.Documents(s.fs.Collection(conversionsCol(s.env)).Where("uid", "==", uid).Where("stripe.pi_status", "==", PIChargeFailed)).GetAll()
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		st := &Settle{UID: uid, State: SettleSettling, Trigger: trigger, Currency: "usd", Lease: &lease, CreatedAt: now, UpdatedAt: now}
		var groups []*Batch
		for _, gs := range gsnaps {
			b, berr := snapToBatch(gs)
			if berr != nil {
				return berr
			}
			ids := make([]string, 0, len(b.Items))
			for _, it := range b.Items {
				ids = append(ids, it.ConversionID)
			}
			st.Items = append(st.Items, SettleItem{Kind: "group", ID: b.ID, AmountCents: b.TotalCents, ConversionIDs: ids, PaymentIntentID: b.PaymentIntentID})
			st.AmountCents += b.TotalCents
			if b.Currency != "" {
				st.Currency = b.Currency
			}
			groups = append(groups, b)
		}
		var runs []*Conversion
		for _, rs := range rsnaps {
			c, cerr := snapToConversion(rs)
			if cerr != nil {
				return cerr
			}
			if c.Stripe.BatchID != "" {
				continue // part of a group above
			}
			st.Items = append(st.Items, SettleItem{Kind: "run", ID: c.ID, AmountCents: c.Quote.AmountCents, PaymentIntentID: c.Stripe.PaymentIntentID})
			st.AmountCents += c.Quote.AmountCents
			runs = append(runs, c)
		}
		if len(st.Items) == 0 {
			return ErrNothingOwed
		}
		cust.SettleSeq++
		st.ID = fmt.Sprintf("%s_%d", uid, cust.SettleSeq)
		cust.LiveSettleID = st.ID
		for _, b := range groups {
			b.State, b.SettleID, b.UpdatedAt = BatchSettling, st.ID, now
			if err := tx.Set(s.batchDoc(b.ID), b); err != nil {
				return err
			}
		}
		for _, c := range runs {
			c.Stripe.PIStatus, c.Stripe.SettleID, c.UpdatedAt = PISettling, st.ID, now
			if err := tx.Set(s.convDoc(c.ID), c); err != nil {
				return err
			}
		}
		if err := tx.Set(custRef, &cust); err != nil {
			return err
		}
		out = st
		return tx.Create(s.settleDoc(st.ID), st)
	})
	if errors.Is(err, ErrSettleLive) {
		return out, ErrSettleLive
	}
	if err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateSettle mutates a settling settle in a transaction.
func (s *Store) UpdateSettle(ctx context.Context, id string, mutate func(st *Settle) error) (*Settle, error) {
	var out *Settle
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(s.settleDoc(id))
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		st, err := snapToSettle(snap)
		if err != nil {
			return err
		}
		if err := mutate(st); err != nil {
			return err
		}
		st.UpdatedAt = time.Now().UTC()
		out = st
		return tx.Set(s.settleDoc(id), st)
	})
	return out, err
}

// SettleOutcome is how a settle ended.
type SettleOutcome struct {
	Paid            bool
	PaymentIntentID string
	PaidCents       int64
	PaidWith        string
}

// FinishSettle ends a settling settle and every item in ONE transaction:
// paid → the settle, its groups and their runs, and its runs are paid with
// the settle's PaymentIntent; the account clears (lifetime credited, the
// last good method set, all_methods_failed cleared). Not paid → the items
// go back to owed and the settle closes. dropped lists per-run items that
// turned out paid on their own (C11 step 3): they leave the settle as
// they are. ErrStateConflict when the settle already ended.
func (s *Store) FinishSettle(ctx context.Context, id string, out SettleOutcome, dropped []string) (*Settle, error) {
	var result *Settle
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(s.settleDoc(id))
		if err != nil {
			return err
		}
		st, err := snapToSettle(snap)
		if err != nil {
			return err
		}
		if st.State != SettleSettling {
			return fmt.Errorf("%w: settle %s is %s", ErrStateConflict, id, st.State)
		}
		custRef := s.fs.Collection(customersCol(s.env)).Doc(st.UID)
		csnap, err := tx.Get(custRef)
		if err != nil {
			return err
		}
		var cust Customer
		if err := csnap.DataTo(&cust); err != nil {
			return err
		}
		var groupRefs, runRefs []*firestore.DocumentRef
		for _, it := range st.Items {
			if it.Kind == "group" {
				groupRefs = append(groupRefs, s.batchDoc(it.ID))
				for _, cid := range it.ConversionIDs {
					runRefs = append(runRefs, s.convDoc(cid))
				}
			} else {
				runRefs = append(runRefs, s.convDoc(it.ID))
			}
		}
		gsnaps, err := tx.GetAll(groupRefs)
		if err != nil {
			return err
		}
		rsnaps, err := tx.GetAll(runRefs)
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		for _, gs := range gsnaps {
			if !gs.Exists() {
				continue
			}
			b, berr := snapToBatch(gs)
			if berr != nil {
				return berr
			}
			if b.SettleID != id || b.State != BatchSettling {
				continue
			}
			if out.Paid {
				b.State, b.PaymentIntentID, b.ChargedCents, b.ChargedAt, b.PIStatus = BatchPaid, out.PaymentIntentID, b.TotalCents, &now, PISucceeded
				b.PaidWith, b.SettleError = out.PaidWith, ""
			} else {
				b.State = BatchFailed
			}
			b.UpdatedAt = now
			if err := tx.Set(s.batchDoc(b.ID), b); err != nil {
				return err
			}
		}
		for _, rs := range rsnaps {
			if !rs.Exists() {
				continue
			}
			c, cerr := snapToConversion(rs)
			if cerr != nil {
				return cerr
			}
			inGroup := c.Stripe.BatchID != "" && c.Stripe.PIStatus == PIChargeFailed
			own := c.Stripe.SettleID == id && c.Stripe.PIStatus == PISettling
			if !inGroup && !own {
				continue
			}
			if containsString(dropped, c.ID) {
				continue
			}
			switch {
			case out.Paid:
				c.Stripe.PIStatus, c.Stripe.PaymentIntentID = PISucceeded, out.PaymentIntentID
				c.Stripe.CapturedCents, c.Stripe.CapturedAt, c.Stripe.SettleError = c.Quote.AmountCents, &now, ""
				c.Stripe.SettleID = id
			case own:
				c.Stripe.PIStatus = PIChargeFailed
			default:
				continue // a group's run stays charge_failed
			}
			c.UpdatedAt = now
			if err := tx.Set(s.convDoc(c.ID), c); err != nil {
				return err
			}
		}
		if cust.LiveSettleID == id {
			cust.LiveSettleID = ""
		}
		if out.Paid {
			cust.LifetimePaidCents += out.PaidCents
			cust.AllMethodsFailed = false
			if out.PaidWith != "" {
				cust.LastGoodMethod = out.PaidWith
				if !containsString(cust.PaidMethods, out.PaidWith) {
					cust.PaidMethods = append(cust.PaidMethods, out.PaidWith)
				}
			}
			st.State, st.PaymentState, st.PaidAt = SettlePaid, SettlePaid, &now
			st.PaymentIntentID, st.PaidCents, st.PaidWith = out.PaymentIntentID, out.PaidCents, out.PaidWith
		} else {
			st.State = SettleClosed
		}
		st.Lease, st.UpdatedAt = nil, now
		if err := tx.Set(custRef, &cust); err != nil {
			return err
		}
		result = st
		return tx.Set(s.settleDoc(id), st)
	})
	return result, err
}

func containsString(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
