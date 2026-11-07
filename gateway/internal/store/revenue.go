package store

import (
	"context"
	"fmt"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Records the revenue report (GET /v1/admin/revenue/daily) reads, besides
// charges, refund rows, dispute cases and the balance ledger.

// PlanPayment is plan_payments_{env}/{invoice id}: a paid web plan
// invoice (Pro, Business, Studio), written from invoice.paid so the
// report never asks Stripe. Refunds of it are appended (by Stripe refund
// id, once each).
type PlanPayment struct {
	InvoiceID       string       `firestore:"-" json:"invoice_id"`
	UID             string       `firestore:"uid" json:"uid"`
	PlanID          string       `firestore:"plan_id" json:"plan_id"` // pro_weekly | pro_monthly | pro_yearly | business | studio
	AmountCents     int64        `firestore:"amount_cents" json:"amount_cents"`
	Currency        string       `firestore:"currency" json:"currency"`
	PaidAt          time.Time    `firestore:"paid_at" json:"paid_at"`
	PaymentIntentID string       `firestore:"payment_intent_id,omitempty" json:"-"`
	Presentment     *Presentment `firestore:"presentment,omitempty" json:"presentment,omitempty"`
	Refunds         []PlanRefund `firestore:"refunds,omitempty" json:"refunds,omitempty"`
	CreatedAt       time.Time    `firestore:"created_at" json:"-"`
}

// PlanRefund is money back on a plan invoice.
type PlanRefund struct {
	ID    string    `firestore:"id" json:"id"`
	Cents int64     `firestore:"cents" json:"cents"`
	At    time.Time `firestore:"at" json:"at"`
}

func planPaymentsCol(env string) string { return "plan_payments_" + env }

// RecordPlanPayment writes p once (a second invoice.paid changes nothing;
// false).
func (s *Store) RecordPlanPayment(ctx context.Context, p *PlanPayment) (bool, error) {
	if p.InvoiceID == "" {
		return false, fmt.Errorf("plan payment without an invoice id")
	}
	p.CreatedAt = time.Now().UTC()
	_, err := s.fs.Collection(planPaymentsCol(s.env)).Doc(p.InvoiceID).Create(ctx, p)
	if status.Code(err) == codes.AlreadyExists {
		return false, nil
	}
	return err == nil, err
}

// AddPlanRefund appends r to the plan payment pi paid, once per refund id;
// false when pi paid no plan invoice of ours or r is already there.
func (s *Store) AddPlanRefund(ctx context.Context, pi string, r PlanRefund) (bool, error) {
	if pi == "" || r.ID == "" {
		return false, nil
	}
	snaps, err := s.fs.Collection(planPaymentsCol(s.env)).Where("payment_intent_id", "==", pi).Limit(1).Documents(ctx).GetAll()
	if err != nil || len(snaps) == 0 {
		return false, err
	}
	ref := snaps[0].Ref
	added := false
	err = s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		added = false
		snap, err := tx.Get(ref)
		if err != nil {
			return err
		}
		var p PlanPayment
		if err := snap.DataTo(&p); err != nil {
			return err
		}
		for _, x := range p.Refunds {
			if x.ID == r.ID {
				return nil
			}
		}
		added = true
		return tx.Update(ref, []firestore.Update{{Path: "refunds", Value: append(p.Refunds, r)}})
	})
	return added, err
}

// ListPlanPayments lists every plan payment (at most limit).
func (s *Store) ListPlanPayments(ctx context.Context, limit int) ([]*PlanPayment, error) {
	snaps, err := s.fs.Collection(planPaymentsCol(s.env)).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]*PlanPayment, 0, len(snaps))
	for _, sn := range snaps {
		var p PlanPayment
		if sn.DataTo(&p) == nil {
			p.InvoiceID = sn.Ref.ID
			out = append(out, &p)
		}
	}
	return out, nil
}

// ListBalanceUIDs lists the accounts that have a balance document.
func (s *Store) ListBalanceUIDs(ctx context.Context, limit int) ([]string, error) {
	refs, err := s.fs.Collection(balancesCol(s.env)).Limit(limit).Select().Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(refs))
	for _, r := range refs {
		out = append(out, r.Ref.ID)
	}
	return out, nil
}

// ListEntriesBetween lists uid's ledger entries with from ≤ at < to.
func (s *Store) ListEntriesBetween(ctx context.Context, uid string, from, to time.Time) ([]Entry, error) {
	snaps, err := s.balanceDoc(uid).Collection("entries").Where("at", ">=", from).Where("at", "<", to).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(snaps))
	for _, sn := range snaps {
		var e Entry
		if sn.DataTo(&e) == nil {
			e.ID = sn.Ref.ID
			out = append(out, e)
		}
	}
	return out, nil
}
