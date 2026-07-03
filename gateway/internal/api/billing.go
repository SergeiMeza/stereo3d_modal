package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/stripe/stripe-go/v78"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Pay-as-you-go billing endpoints (web pro flow).
//
// Onboarding saves a card via a SetupIntent; GET /v1/billing is the
// read-through status the web client gates on (it also heals the default
// payment method after onboarding or a portal edit). Paid steps are blocked
// with 402s until a card is on file and no charge_failed conversion is
// outstanding; POST /v1/billing/settle retries the outstanding charges.

// unpaidLimit bounds the delinquency probe; one unpaid conversion already
// blocks new paid work, the exact count doesn't matter.
const unpaidLimit = 10

// holdThresholdCents: quotes at or above this place an off-session hold on
// the saved card BEFORE the job runs (captured on success); below it the
// card is charged only on success with no hold — everyday runs don't leave
// pending charges on statements. Raised $5 → $100 with the 2026-07-03
// pricing recalibration (quotes grew ~10×; at $5 nearly every run held).
// Code constant by design.
const holdThresholdCents = 10000

// refreshCardCache reads the live default payment method from Stripe and
// folds it into the uid → customer cache the conversion-create gate reads.
// On a Stripe read error the stale cache is returned — billing status must
// still render during a Stripe blip.
func (s *Service) refreshCardCache(ctx context.Context, uid, customerID string) *store.Customer {
	card, err := s.Stripe.DefaultCard(customerID)
	if err != nil {
		httpx.Log(ctx).Warn("default card lookup failed (serving cached)", "uid", uid, "err", err)
		if cust, gerr := s.Store.GetCustomer(ctx, uid); gerr == nil {
			return cust
		}
		return &store.Customer{StripeCustomerID: customerID}
	}
	cust, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if card == nil {
			c.DefaultPaymentMethod, c.CardBrand, c.CardLast4 = "", "", ""
			c.CardExpMonth, c.CardExpYear = 0, 0
		} else {
			c.DefaultPaymentMethod = card.PaymentMethodID
			c.CardBrand, c.CardLast4 = card.Brand, card.Last4
			c.CardExpMonth, c.CardExpYear = card.ExpMonth, card.ExpYear
		}
		c.CardUpdatedAt = time.Now().UTC()
		return nil
	})
	if err != nil {
		httpx.Log(ctx).Warn("card cache update failed", "uid", uid, "err", err)
		if cust, gerr := s.Store.GetCustomer(ctx, uid); gerr == nil {
			return cust
		}
		return &store.Customer{StripeCustomerID: customerID}
	}
	return cust
}

// unpaidEntry serializes one charge_failed conversion for the billing UI.
func (s *Service) unpaidEntry(ctx context.Context, conv *store.Conversion) map[string]any {
	entry := map[string]any{
		"conversion_id": conv.ID,
		"step":          conv.Step,
		"amount_cents":  conv.Quote.AmountCents,
		"currency":      conv.Quote.Currency,
		"needs_action":  false,
	}
	if conv.Stripe.PaymentIntentID != "" {
		if pi, err := s.Stripe.GetPaymentIntent(conv.Stripe.PaymentIntentID); err == nil {
			switch pi.Status {
			case stripe.PaymentIntentStatusRequiresAction, stripe.PaymentIntentStatusRequiresConfirmation:
				// The saved card is fine — the bank wants 3DS. The client
				// completes it with confirmCardPayment(client_secret).
				entry["needs_action"] = true
				entry["client_secret"] = pi.ClientSecret
			}
		} else {
			httpx.Log(ctx).Warn("unpaid PI lookup failed", "conversion_id", conv.ID, "err", err)
		}
	}
	return entry
}

func (s *Service) billingStatus(ctx context.Context, user *AuthedUser, cust *store.Customer) (map[string]any, error) {
	unpaid, err := s.Store.ListUserByPIStatus(ctx, user.UID, store.PIChargeFailed, unpaidLimit)
	if err != nil {
		return nil, err
	}
	entries := make([]map[string]any, 0, len(unpaid))
	for _, conv := range unpaid {
		entries = append(entries, s.unpaidEntry(ctx, conv))
	}
	resp := map[string]any{
		"has_payment_method": cust.DefaultPaymentMethod != "",
		"delinquent":         len(entries) > 0,
		"unpaid":             entries,
		"publishable_key":    s.Stripe.PublishableKey,
	}
	if cust.DefaultPaymentMethod != "" {
		resp["card"] = map[string]any{
			"brand":     cust.CardBrand,
			"last4":     cust.CardLast4,
			"exp_month": cust.CardExpMonth,
			"exp_year":  cust.CardExpYear,
		}
	}
	return resp, nil
}

// GET /v1/billing — the web client's billing gate: does the caller have a
// chargeable card on file, and is any automatic charge outstanding? Ensures
// the billing profile and heals the Stripe default payment method, so
// polling this after a SetupIntent confirm completes onboarding.
func (s *Service) HandleGetBilling(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	cust := s.refreshCardCache(ctx, user.UID, customerID)
	resp, err := s.billingStatus(ctx, user, cust)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.WriteOK(w, resp)
}

// POST /v1/billing/setup-intent — start saving a card for off-session
// charges (the onboarding flow's Payment Element binds to the returned
// client_secret).
func (s *Service) HandleCreateSetupIntent(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	sheet, err := s.Stripe.CreateSetupIntent(customerID, user.UID)
	if err != nil {
		httpx.Log(ctx).Error("setup intent failed", "uid", user.UID, "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "could not start card setup; try again"))
		return
	}
	httpx.WriteOK(w, sheet)
}

// POST /v1/billing/settle — retry the outstanding automatic charges against
// the CURRENT default card (refreshed first, so a card added in the portal
// is picked up). Returns the first 3DS challenge as requires_action +
// client_secret for the web confirmCardPayment fallback.
func (s *Service) HandleSettleBilling(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	s.refreshCardCache(ctx, user.UID, customerID)
	unpaid, err := s.Store.ListUserByPIStatus(ctx, user.UID, store.PIChargeFailed, unpaidLimit)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	for _, conv := range unpaid {
		// Re-arm the charge (charge_failed → charge_pending) and run the
		// standard settlement path. A conflict means a concurrent settle
		// already claimed it — skip.
		armed, terr := s.Store.Transition(ctx, conv.ID, []string{store.StateSucceeded}, func(c *store.Conversion) error {
			if c.Stripe.PIStatus != store.PIChargeFailed {
				return store.ErrStateConflict
			}
			c.Stripe.PIStatus = store.PIChargePending
			return nil
		})
		if terr != nil {
			continue
		}
		if _, cerr := s.chargeConversion(ctx, armed); cerr != nil {
			httpx.Log(ctx).Warn("settle charge failed", "conversion_id", conv.ID, "err", cerr)
		}
	}

	remaining, err := s.Store.ListUserByPIStatus(ctx, user.UID, store.PIChargeFailed, unpaidLimit)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	resp := map[string]any{
		"settled":         len(remaining) == 0,
		"publishable_key": s.Stripe.PublishableKey,
	}
	for _, conv := range remaining {
		entry := s.unpaidEntry(ctx, conv)
		if entry["needs_action"] == true {
			resp["requires_action"] = true
			resp["client_secret"] = entry["client_secret"]
			break
		}
	}
	if len(remaining) > 0 && resp["requires_action"] != true {
		resp["message"] = "The charge was declined again. Update your card in the billing portal, then retry."
	}
	httpx.WriteOK(w, resp)
}

// requireBillable gates paid pro-step creation: a default card must be on
// file and no automatic charge may be outstanding. 402s carry machine codes
// the web client routes on (no_payment_method → onboarding; billing_overdue
// → settle flow).
func (s *Service) requireBillable(ctx context.Context, user *AuthedUser) (*store.Customer, error) {
	cust, err := s.Store.GetCustomer(ctx, user.UID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && cust.DefaultPaymentMethod == "") {
		return nil, httpx.Err(http.StatusPaymentRequired, "no_payment_method",
			"add a payment method before starting a conversion")
	}
	if err != nil {
		return nil, err
	}
	unpaid, err := s.Store.ListUserByPIStatus(ctx, user.UID, store.PIChargeFailed, 1)
	if err != nil {
		return nil, err
	}
	if len(unpaid) > 0 {
		return nil, httpx.Err(http.StatusPaymentRequired, "billing_overdue",
			"the automatic payment for conversion "+unpaid[0].ID+" failed — settle it before starting new work")
	}
	return cust, nil
}
