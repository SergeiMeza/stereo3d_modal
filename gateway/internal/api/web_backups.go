package api

import (
	"context"
	"fmt"

	"github.com/stripe/stripe-go/v78"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// cascadeResult is what the web's backup cascade (C5) ended with.
type cascadeResult struct {
	Paid     bool
	PI       *stripe.PaymentIntent // the one that paid (or is paying)
	PaidWith string
	// PIID is the PaymentIntent left to close when nothing paid ("" when
	// none was made).
	PIID string
	// Fail is the decision that ends it: the default's, or a stop code.
	Fail stripex.ChargeFailure
	// Transient: infrastructure trouble mid-way; the caller's lease lapses
	// and its sweep re-drives under the same keys.
	Transient bool
	// CardDecision: a bank answered at least once. False when every try
	// was refused by Stripe itself (B2: a configuration error, never the
	// customer's to fix).
	CardDecision bool
}

// webBackups runs the web's off-session backups after the default failed
// with first: the other saved methods in the customer's order, each once.
// A bank check (authentication_required) goes on to them like a decline;
// a stop code ends everything. When the default's charge made no
// PaymentIntent (Stripe refused the request, B3) each backup is charged
// with create (its own key) until one exists; after that the backups
// re-confirm it (confirm_{pi}_{pm}_1).
func (s *Service) webBackups(ctx context.Context, cust *store.Customer, first stripex.ChargeFailure,
	create func(pm string) (*stripe.PaymentIntent, error)) cascadeResult {
	r := cascadeResult{PIID: first.PaymentIntentID, Fail: first, CardDecision: !first.Config}
	if first.Stop {
		return r
	}
	methods, _ := s.Stripe.ListMethods(cust.StripeCustomerID)
	for _, m := range orderMethods(s.usableMethods(ctx, methods), cust.DefaultPaymentMethod, cust.BackupOrder) {
		if m.PaymentMethodID == cust.DefaultPaymentMethod {
			continue
		}
		var pi *stripe.PaymentIntent
		var err error
		if r.PIID != "" {
			pi, err = s.Stripe.ConfirmWithMethod(r.PIID, m.PaymentMethodID, 1, false)
		} else {
			pi, err = create(m.PaymentMethodID)
		}
		if err == nil && (pi.Status == stripe.PaymentIntentStatusSucceeded || pi.Status == stripe.PaymentIntentStatusProcessing) {
			r.Paid, r.PI, r.PaidWith = true, pi, m.PaymentMethodID
			if r.PIID == "" {
				r.PIID = pi.ID
			}
			return r
		}
		if err == nil { // a bank check without an error
			if r.PIID == "" {
				r.PIID = pi.ID
			}
			r.CardDecision = true
			continue
		}
		f := stripex.ClassifyChargeError(err)
		if f.Transient {
			r.Transient = true
			return r
		}
		if r.PIID == "" && f.PaymentIntentID != "" {
			r.PIID = f.PaymentIntentID
		}
		if !f.Config {
			r.CardDecision = true
		}
		if f.Stop {
			r.Fail = f
			return r
		}
	}
	return r
}

// alertConfigError tells the owner Stripe refused a web off-session charge
// itself (B2): a configuration to fix, not a customer's decline.
func (s *Service) alertConfigError(ctx context.Context, what, id, uid string, f stripex.ChargeFailure) {
	s.Slack.Alert(ctx, "offsession_config_error", fmt.Sprintf("Stripe refused the %s charge `%s` for `%s` (%s): %s — a configuration error, not a decline",
		what, id, uid, f.Code, f.Message))
}
