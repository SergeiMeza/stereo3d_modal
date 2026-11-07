package store

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"strings"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// A pay request is one debt's pay page (D7, owner 2026-11-07):
// pay_requests_{env}/{token}. The token is the page's link (SiteURL/pay/
// {token}); it is bound to one account and one debt, carries no account
// facts, and its amount is the server's alone.
type PayRequest struct {
	ID       string `firestore:"-" json:"token"`
	UID      string `firestore:"uid" json:"-"`
	Kind     string `firestore:"kind" json:"kind"`           // PayKindTopup | PayKindSettle | PayKindInvoice | PayKindStepUp
	SourceID string `firestore:"source_id" json:"source_id"` // the failed reload, the deletion, the invoice, the plan change
	// AmountCents: what it was for when made (USD); the page shows the
	// live amount (what is still owed, the invoice's amount due).
	AmountCents int64      `firestore:"amount_cents" json:"amount_cents"`
	Label       string     `firestore:"label" json:"label"`
	State       string     `firestore:"state" json:"state"` // PayOpen | PayPaid | PayVoid | PayApplying
	VoidReason  string     `firestore:"void_reason,omitempty" json:"void_reason,omitempty"`
	CreatedAt   time.Time  `firestore:"created_at" json:"created_at"`
	ExpiresAt   time.Time  `firestore:"expires_at" json:"expires_at"`
	ClosedAt    *time.Time `firestore:"closed_at,omitempty" json:"closed_at,omitempty"`
	// What the page made: the top-up it pays (kind topup), the last
	// checkout object.
	TopupID    string `firestore:"topup_id,omitempty" json:"-"`
	CheckoutID string `firestore:"checkout_id,omitempty" json:"-"`
	// Kind invoice: Stripe's hosted invoice page.
	HostedURL string `firestore:"hosted_url,omitempty" json:"-"`
	// Kind stepup: the plan the change goes to.
	PlanTo string `firestore:"plan_to,omitempty" json:"plan_to,omitempty"`
	// Kind stepup, paid (REV-01): the paying session's quote (plan_to,
	// quote_at, credit_cents), when it was claimed, and the change's
	// attempts. State stays PayApplying until the change is made (then
	// PayPaid) or refunded (PayVoid); ApplyLease keeps two attempts apart.
	Apply         map[string]string `firestore:"apply,omitempty" json:"-"`
	ClaimedAt     *time.Time        `firestore:"claimed_at,omitempty" json:"-"`
	ApplyLease    *time.Time        `firestore:"apply_lease,omitempty" json:"-"`
	ApplyAttempts int               `firestore:"apply_attempts,omitempty" json:"-"`
	ApplyError    string            `firestore:"apply_error,omitempty" json:"-"`
}

// Pay request kinds and states.
const (
	PayKindTopup   = "topup"   // a failed auto-reload: paying adds that amount to the balance
	PayKindSettle  = "settle"  // what the account owes (deletion dues): a settle
	PayKindInvoice = "invoice" // a plan renewal's open invoice: Stripe's hosted page
	PayKindStepUp  = "stepup"  // a plan step-up that didn't go through

	PayOpen     = "open"
	PayPaid     = "paid"
	PayVoid     = "void"
	PayApplying = "applying" // kind stepup: paid, the change not made yet (the page shows "paid")
)

// PayRequestTTL is how long a pay link works.
const PayRequestTTL = 30 * 24 * time.Hour

func payRequestsCol(env string) string { return "pay_requests_" + env }

func (s *Store) payRequestDoc(id string) *firestore.DocumentRef {
	return s.fs.Collection(payRequestsCol(s.env)).Doc(id)
}

// NewPayToken is an unguessable link token (160 random bits).
func NewPayToken() string {
	var b [20]byte
	_, _ = rand.Read(b[:])
	return "pr_" + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b[:]))
}

// Open reports whether the request can still be paid at now.
func (p *PayRequest) Open(now time.Time) bool { return p.State == PayOpen && now.Before(p.ExpiresAt) }

// OpenPayRequest returns the open request for (uid, kind, source), making
// it when there is none (one link per debt: a second failure mail reuses
// it). created reports a new one.
func (s *Store) OpenPayRequest(ctx context.Context, uid, kind, source string, amount int64, label string) (*PayRequest, bool, error) {
	now := time.Now().UTC()
	if got, err := s.findPayRequests(ctx, uid, kind, source); err == nil {
		for _, p := range got {
			if p.Open(now) {
				if p.AmountCents != amount || p.Label != label {
					p.AmountCents, p.Label = amount, label
					_, _ = s.payRequestDoc(p.ID).Update(ctx, []firestore.Update{{Path: "amount_cents", Value: amount}, {Path: "label", Value: label}})
				}
				return p, false, nil
			}
		}
	} else {
		return nil, false, err
	}
	p := &PayRequest{ID: NewPayToken(), UID: uid, Kind: kind, SourceID: source, AmountCents: amount, Label: label, State: PayOpen,
		CreatedAt: now, ExpiresAt: now.Add(PayRequestTTL)}
	if _, err := s.payRequestDoc(p.ID).Create(ctx, p); err != nil {
		return nil, false, err
	}
	return p, true, nil
}

func (s *Store) findPayRequests(ctx context.Context, uid, kind, source string) ([]*PayRequest, error) {
	q := s.fs.Collection(payRequestsCol(s.env)).Where("uid", "==", uid).Where("kind", "==", kind)
	if source != "" {
		q = q.Where("source_id", "==", source)
	}
	return s.collectPayRequests(q.Limit(50).Documents(ctx))
}

func (s *Store) collectPayRequests(iter *firestore.DocumentIterator) ([]*PayRequest, error) {
	defer iter.Stop()
	var out []*PayRequest
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		var p PayRequest
		if err := snap.DataTo(&p); err != nil {
			return nil, err
		}
		p.ID = snap.Ref.ID
		out = append(out, &p)
	}
}

// GetPayRequest reads one by token (ErrNotFound when there is none).
func (s *Store) GetPayRequest(ctx context.Context, token string) (*PayRequest, error) {
	if !strings.HasPrefix(token, "pr_") || len(token) > 64 {
		return nil, ErrNotFound
	}
	snap, err := s.payRequestDoc(token).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var p PayRequest
	if err := snap.DataTo(&p); err != nil {
		return nil, err
	}
	p.ID = token
	return &p, nil
}

// UpdatePayRequest applies mutate in a transaction.
func (s *Store) UpdatePayRequest(ctx context.Context, token string, mutate func(p *PayRequest) error) (*PayRequest, error) {
	var out *PayRequest
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(s.payRequestDoc(token))
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		var p PayRequest
		if err := snap.DataTo(&p); err != nil {
			return err
		}
		p.ID = token
		if err := mutate(&p); err != nil {
			return err
		}
		out = &p
		return tx.Set(s.payRequestDoc(token), &p)
	})
	return out, err
}

// ClosePayRequests ends every open request of (uid, kind[, source]) as
// state (paid: the debt was paid, by the page or another way; void: it
// no longer stands). It returns how many it closed.
func (s *Store) ClosePayRequests(ctx context.Context, uid, kind, source, state, reason string) (int, error) {
	got, err := s.findPayRequests(ctx, uid, kind, source)
	if err != nil {
		return 0, err
	}
	n := 0
	now := time.Now().UTC()
	for _, p := range got {
		if p.State != PayOpen {
			continue
		}
		if _, err := s.UpdatePayRequest(ctx, p.ID, func(x *PayRequest) error {
			if x.State != PayOpen {
				return nil
			}
			x.State, x.VoidReason, x.ClosedAt = state, reason, &now
			return nil
		}); err == nil {
			n++
		}
	}
	return n, nil
}

// ListPayRequests lists requests by state (admin), or one account's when
// uid is set.
func (s *Store) ListPayRequests(ctx context.Context, uid, state string, limit int) ([]*PayRequest, error) {
	q := s.fs.Collection(payRequestsCol(s.env)).Query
	if uid != "" {
		q = q.Where("uid", "==", uid)
	}
	if state != "" {
		q = q.Where("state", "==", state)
	}
	return s.collectPayRequests(q.Limit(limit).Documents(ctx))
}

// PlanChangeFails counts a step-up quote's failed payments (its
// idempotency key moves on with each, so the customer's own retry is never
// answered from Stripe's cache of the last 402).
func (s *Store) PlanChangeFails(ctx context.Context, base string) int {
	snap, err := s.fs.Collection("plan_change_tries_" + s.env).Doc(base).Get(ctx)
	if err != nil {
		return 0
	}
	n, _ := snap.DataAt("fails")
	if v, ok := n.(int64); ok {
		return int(v)
	}
	return 0
}

// AddPlanChangeFail records one more failed payment of base.
func (s *Store) AddPlanChangeFail(ctx context.Context, base string) {
	_, _ = s.fs.Collection("plan_change_tries_"+s.env).Doc(base).Set(ctx, map[string]any{"fails": firestore.Increment(1),
		"at": time.Now().UTC()}, firestore.MergeAll)
}
