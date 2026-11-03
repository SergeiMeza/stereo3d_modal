package store

import (
	"context"
	"fmt"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Charge kinds: one statement charge each (C6, C8): a run paid on its own,
// an after-done group, or a settle.
const (
	ChargeRun    = "run"
	ChargeGroup  = "group"
	ChargeSettle = "settle"
	ChargeTopup  = "topup" // a balance top-up (v7 N12): one invoice each
)

// Invoice job states (C6).
const (
	InvoicePending   = "pending"
	InvoiceInvoicing = "invoicing"
	InvoiceDone      = "done"
	InvoiceFailed    = "failed"
	// InvoiceSkipped: refunded in full before an invoice existed — refunded
	// runs never get one.
	InvoiceSkipped = "skipped"
)

// ChargeLine is one run on a statement charge (one invoice line).
type ChargeLine struct {
	ConversionID string `firestore:"conversion_id" json:"conversion_id"`
	ProjectID    string `firestore:"project_id,omitempty" json:"project_id,omitempty"`
	AmountCents  int64  `firestore:"amount_cents" json:"amount_cents"`
	Description  string `firestore:"description" json:"description"`
}

// CreditNoteRef records a credit note made for a refund (C6 step 5, C8
// step 4), keyed by the refund.
type CreditNoteRef struct {
	RefundID     string `firestore:"refund_id"`
	CreditNoteID string `firestore:"credit_note_id"`
	Number       string `firestore:"number,omitempty"`
	AmountCents  int64  `firestore:"amount_cents"`
	PDF          string `firestore:"pdf,omitempty"`
}

// Charge is charges_{env}/{charge_id}: a final PaymentIntent and its runs,
// the invoice job's state, and (with the refund layer) refund_seq.
// charge_id is {kind}_{source id}.
type Charge struct {
	ID              string       `firestore:"-" json:"charge_id"`
	UID             string       `firestore:"uid" json:"-"`
	Kind            string       `firestore:"kind" json:"kind"`
	SourceID        string       `firestore:"source_id" json:"-"`
	CustomerID      string       `firestore:"customer_id" json:"-"`
	PaymentIntentID string       `firestore:"payment_intent_id" json:"-"`
	AmountCents     int64        `firestore:"amount_cents" json:"amount_cents"`
	Currency        string       `firestore:"currency" json:"currency"`
	PaidWith        string       `firestore:"paid_with,omitempty" json:"-"`
	PaidAt          time.Time    `firestore:"paid_at" json:"paid_at"`
	Lines           []ChargeLine `firestore:"lines" json:"lines"`

	InvoiceState     string          `firestore:"invoice_state" json:"invoice_state"`
	InvoiceAttempt   int             `firestore:"invoice_attempt" json:"-"`
	InvoiceTries     int             `firestore:"invoice_tries,omitempty" json:"-"`
	InvoiceID        string          `firestore:"invoice_id,omitempty" json:"-"`
	InvoiceNumber    string          `firestore:"invoice_number,omitempty" json:"-"`
	HostedInvoiceURL string          `firestore:"hosted_invoice_url,omitempty" json:"-"`
	InvoicePDF       string          `firestore:"invoice_pdf,omitempty" json:"-"`
	InvoiceError     string          `firestore:"invoice_error,omitempty" json:"-"`
	InvoiceDoneAt    *time.Time      `firestore:"invoice_done_at,omitempty" json:"-"`
	CreditNotes      []CreditNoteRef `firestore:"credit_notes,omitempty" json:"-"`
	Lease            *Lease          `firestore:"lease,omitempty" json:"-"`
	// RefundSeq serializes refunds on this charge (C8 step 1, v6.1 W2).
	RefundSeq int       `firestore:"refund_seq,omitempty" json:"-"`
	CreatedAt time.Time `firestore:"created_at" json:"-"`
	UpdatedAt time.Time `firestore:"updated_at" json:"-"`
}

// ChargeID names a statement charge.
func ChargeID(kind, sourceID string) string { return kind + "_" + sourceID }

func chargesCol(env string) string { return "charges_" + env }

func (s *Store) chargeDoc(id string) *firestore.DocumentRef {
	return s.fs.Collection(chargesCol(s.env)).Doc(id)
}

func snapToCharge(snap *firestore.DocumentSnapshot) (*Charge, error) {
	var c Charge
	if err := snap.DataTo(&c); err != nil {
		return nil, err
	}
	c.ID = snap.Ref.ID
	return &c, nil
}

// RecordCharge writes a final charge once (pending invoice). A second
// call for the same charge is a no-op returning ErrAlreadyExists.
func (s *Store) RecordCharge(ctx context.Context, c *Charge) error {
	now := time.Now().UTC()
	c.ID = ChargeID(c.Kind, c.SourceID)
	if c.InvoiceState == "" {
		c.InvoiceState = InvoicePending
	}
	c.CreatedAt, c.UpdatedAt = now, now
	_, err := s.chargeDoc(c.ID).Create(ctx, c)
	if status.Code(err) == codes.AlreadyExists {
		return ErrAlreadyExists
	}
	return err
}

func (s *Store) GetCharge(ctx context.Context, id string) (*Charge, error) {
	snap, err := s.chargeDoc(id).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return snapToCharge(snap)
}

// GetCharges reads several charges by id; missing ones are left out.
func (s *Store) GetCharges(ctx context.Context, ids []string) (map[string]*Charge, error) {
	out := map[string]*Charge{}
	if len(ids) == 0 {
		return out, nil
	}
	refs := make([]*firestore.DocumentRef, 0, len(ids))
	for _, id := range ids {
		refs = append(refs, s.chargeDoc(id))
	}
	snaps, err := s.fs.GetAll(ctx, refs)
	if err != nil {
		return nil, err
	}
	for _, snap := range snaps {
		if !snap.Exists() {
			continue
		}
		c, err := snapToCharge(snap)
		if err != nil {
			return nil, err
		}
		out[c.ID] = c
	}
	return out, nil
}

// UpdateCharge mutates a charge in a transaction.
func (s *Store) UpdateCharge(ctx context.Context, id string, mutate func(c *Charge) error) (*Charge, error) {
	var out *Charge
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(s.chargeDoc(id))
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		c, err := snapToCharge(snap)
		if err != nil {
			return err
		}
		if err := mutate(c); err != nil {
			return err
		}
		c.UpdatedAt = time.Now().UTC()
		out = c
		return tx.Set(s.chargeDoc(id), c)
	})
	return out, err
}

// ClaimInvoiceJob leases a charge's invoice job: pending, or invoicing
// under a lapsed lease (a crashed run resumes).
func (s *Store) ClaimInvoiceJob(ctx context.Context, id string, lease Lease) (*Charge, error) {
	return s.UpdateCharge(ctx, id, func(c *Charge) error {
		now := time.Now().UTC()
		switch {
		case c.InvoiceState == InvoicePending:
		case c.InvoiceState == InvoiceInvoicing && !c.Lease.Held(now):
		default:
			return fmt.Errorf("%w: invoice job %s is %s", ErrStateConflict, c.ID, c.InvoiceState)
		}
		c.InvoiceState, c.Lease = InvoiceInvoicing, &lease
		return nil
	})
}

// ListChargesByInvoiceState lists charges for the invoice sweep.
func (s *Store) ListChargesByInvoiceState(ctx context.Context, state string, limit int) ([]*Charge, error) {
	iter := s.fs.Collection(chargesCol(s.env)).Where("invoice_state", "==", state).Limit(limit).Documents(ctx)
	defer iter.Stop()
	var out []*Charge
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		c, err := snapToCharge(snap)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
}

// ChargeByInvoice finds the charge an invoice belongs to (nil if none).
func (s *Store) ChargeByInvoice(ctx context.Context, invoiceID string) (*Charge, error) {
	iter := s.fs.Collection(chargesCol(s.env)).Where("invoice_id", "==", invoiceID).Limit(1).Documents(ctx)
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

// ListUserCharges lists an account's charge records.
func (s *Store) ListUserCharges(ctx context.Context, uid string, limit int) ([]*Charge, error) {
	iter := s.fs.Collection(chargesCol(s.env)).Where("uid", "==", uid).Limit(limit).Documents(ctx)
	defer iter.Stop()
	var out []*Charge
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		c, err := snapToCharge(snap)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
}

// ListAllCharges pages every charge record (A4's denominators).
func (s *Store) ListAllCharges(ctx context.Context, limit int) ([]*Charge, error) {
	iter := s.fs.Collection(chargesCol(s.env)).Limit(limit).Documents(ctx)
	defer iter.Stop()
	var out []*Charge
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		c, err := snapToCharge(snap)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
}
