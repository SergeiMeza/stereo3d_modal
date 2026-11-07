package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// A step-up whose payment didn't go through (D4, owner 2026-11-07) is not
// retried by us: the customer gets a mail and a pay link. The pay page
// takes today's amount on-session (a Checkout Session: the bank's check,
// another method, Adaptive Pricing per config); once paid, the change is
// made with that payment as a credit on its invoice, so nothing is
// charged twice. A change that can't be made then is refunded.

func stepUpSource(subID, to string) string { return subID + ":" + to }

// stepUpFailed adds the pay link to a step-up's 402 (details.pay_url) and
// mails SU1 once per quote.
func (s *Service) stepUpFailed(ctx context.Context, uid string, cust *store.Customer, q *planChangeQuote, err error) {
	var api *httpx.APIError
	if err == nil || !errors.As(err, &api) || api.Status != http.StatusPaymentRequired || cust == nil || cust.Plan == nil {
		return
	}
	label := "Spatial Video Studio " + q.To.Name + " plan"
	link, pr := s.payLink(ctx, uid, store.PayKindStepUp, stepUpSource(cust.Plan.SubscriptionID, q.To.ID), q.TodayCents, label)
	if pr == nil {
		return
	}
	if _, perr := s.Store.UpdatePayRequest(ctx, pr.ID, func(p *store.PayRequest) error {
		p.PlanTo = q.To.ID
		return nil
	}); perr != nil {
		return
	}
	if api.Details == nil {
		api.Details = map[string]any{}
	}
	api.Details["pay_url"] = link
	why := "Your bank declined the payment."
	if api.Details["requires_action"] == true {
		why = "Your bank needs you to confirm the payment."
	}
	s.mailCustomer(ctx, fmt.Sprintf("SU1_%s_%d", pr.ID, q.QuoteAt.Unix()), uid, s.accountEmail(ctx, uid), customerMail{
		Kind: "SU1", Subject: "Spatial Video Studio: your plan change didn't go through",
		Lines: []string{"We couldn't take " + money(q.TodayCents) + " to move you to " + q.To.Name + ". " + why,
			"Your plan hasn't changed. You can pay on the page below to finish the change."},
		Button: "Pay " + money(q.TodayCents), Link: link,
	})
}

// stepUpPayLive: open with today's price while the change can still be
// made; paid once the plan is the target; void when it can't be.
func (s *Service) stepUpPayLive(ctx context.Context, p *store.PayRequest, cust *store.Customer) (string, int64) {
	if cust.Plan == nil || !strings.HasPrefix(p.SourceID, cust.Plan.SubscriptionID+":") {
		return store.PayVoid, p.AmountCents
	}
	if cust.Plan.Key() == p.PlanTo {
		s.closePay(ctx, p, store.PayPaid, "plan changed")
		return store.PayPaid, p.AmountCents
	}
	q, qerr := s.quotePlanChange(ctx, p.UID, cust, p.PlanTo, time.Now().UTC().Truncate(time.Second))
	if qerr != nil || q.Kind != changeStepUp {
		return store.PayVoid, p.AmountCents
	}
	return store.PayOpen, q.TodayCents
}

// payStepUpCheckout opens today's payment for the change, on-session.
func (s *Service) payStepUpCheckout(ctx context.Context, p *store.PayRequest, pc payContext) (map[string]any, error) {
	cust, err := s.Store.GetCustomer(ctx, p.UID)
	if err != nil || cust.Plan == nil || cust.StripeCustomerID == "" {
		return nil, errPayLinkUnknown()
	}
	now := time.Now().UTC().Truncate(time.Second)
	q, qerr := s.quotePlanChange(ctx, p.UID, cust, p.PlanTo, now)
	if qerr != nil || q.Kind != changeStepUp {
		return nil, httpx.Err(http.StatusConflict, "pay_link_closed", "This payment link has closed.")
	}
	if q.TodayCents <= 0 { // nothing to pay today: the change itself
		if err := s.applyStepUp(ctx, cust, q); err != nil {
			return nil, err
		}
		s.closePay(ctx, p, store.PayPaid, "plan changed")
		return map[string]any{"state": store.PayPaid}, nil
	}
	if s.Cfg.StripePMCWeb == "" {
		return nil, errSheetUnavailable()
	}
	sess, serr := s.Stripe.CreateWebSession(stripex.SessionSpec{
		CustomerID: cust.StripeCustomerID, PMC: s.Cfg.StripePMCWeb, UI: "elements", AmountCents: q.TodayCents, Currency: "usd",
		Label: p.Label, ReturnURL: s.payURL(p.ID) + "?done=1", NoWeChat: pc.Device != "computer", SaveMethod: true,
		SavedOnce: s.savedOnceTypes(cust.StripeCustomerID), NoKlarna: len(s.rates(ctx).KlarnaMarkets) == 0,
		ReceiptEmail: cust.Email, Description: p.Label,
		Metadata: map[string]string{"kind": "stepup", "pay_request": p.ID, "user_id": p.UID, "payment_flow": "stepup",
			"plan_to": q.To.ID, "quote_at": strconv.FormatInt(q.QuoteAt.Unix(), 10), "credit_cents": strconv.FormatInt(q.CreditCents, 10)},
		IdemKey:         fmt.Sprintf("stepup_%s_%s_%d", s.Cfg.Env, p.ID, q.QuoteAt.Unix()),
		AdaptivePricing: s.rates(ctx).AdaptivePricingEnabled,
	})
	if serr != nil {
		httpx.Log(ctx).Error("step-up pay session failed", "err", serr)
		return nil, httpx.Err(http.StatusBadGateway, "payment_error", "the payment couldn't be opened; try again")
	}
	s.Store.UpdatePayRequest(ctx, p.ID, func(x *store.PayRequest) error {
		x.CheckoutID = sess.ID
		return nil
	})
	exp := sess.Expires()
	return map[string]any{"amount_cents": q.TodayCents, "publishable_key": s.Stripe.PublishableKey,
		"checkout": map[string]any{"client_secret": sess.ClientSecret, "expires_at": exp.Format(time.RFC3339)}}, nil
}

// applyStepUpSession: a step-up's pay page was paid (checkout.session
// completed / async succeeded). The change is made once (the pay request
// claims the session), today's payment a credit on its invoice; if it
// can't be made, the payment is refunded. An error answers 5xx: Stripe
// sends the event again.
func (s *Service) applyStepUpSession(ctx context.Context, eventType, sessionID string, md map[string]string) error {
	if eventType != "checkout.session.completed" && eventType != "checkout.session.async_payment_succeeded" {
		return nil
	}
	out, _, err := s.Stripe.SessionOutcome(sessionID)
	if err != nil {
		return err
	}
	if !out.Paid {
		return nil // async: its succeeded event comes later
	}
	token, uid := md["pay_request"], md["user_id"]
	claimed := false
	p, err := s.Store.UpdatePayRequest(ctx, token, func(x *store.PayRequest) error {
		claimed = false
		if x.UID != uid || x.Kind != store.PayKindStepUp {
			return store.ErrStateConflict
		}
		if x.State == store.PayPaid && x.CheckoutID == sessionID {
			return nil // done already
		}
		if x.State == store.PayPaid {
			return store.ErrStateConflict // paid by another session: this one is refunded
		}
		now := time.Now().UTC()
		x.State, x.CheckoutID, x.ClosedAt, x.VoidReason, claimed = store.PayPaid, sessionID, &now, "paid on the pay page", true
		return nil
	})
	refund := func(why string) {
		s.refundLatePayment(ctx, &store.Conversion{ID: "stepup:" + token, UID: uid}, out.PaymentIntentID, out.AmountReceived, why)
	}
	if errors.Is(err, store.ErrStateConflict) || errors.Is(err, store.ErrNotFound) {
		refund("a step-up paid twice or not ours")
		return nil
	}
	if err != nil {
		return err
	}
	if !claimed {
		return nil
	}
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil {
		return err
	}
	quoteAt, _ := strconv.ParseInt(md["quote_at"], 10, 64)
	credit, _ := strconv.ParseInt(md["credit_cents"], 10, 64)
	q, qerr := s.quotePlanChange(ctx, uid, cust, md["plan_to"], time.Unix(quoteAt, 0).UTC())
	if qerr == nil && q.Kind == changeStepUp {
		q.CreditCents = credit // what the customer was shown and paid against
		err = s.applyStepUpWith(ctx, cust, q, stepUpPaid{Cents: out.AmountReceived, Session: sessionID})
	} else {
		err = qerr
	}
	if err != nil {
		slog.WarnContext(ctx, "paid step-up not applied; refunding", "pay_request", p.ID, "err", err)
		s.Store.UpdatePayRequest(ctx, token, func(x *store.PayRequest) error {
			x.State, x.VoidReason = store.PayVoid, "change failed after payment; refunded"
			return nil
		})
		refund("the plan change couldn't be made after it was paid")
		s.Slack.Alert(ctx, "stepup_refunded", fmt.Sprintf("`%s`'s paid step-up to %s couldn't be made (%v); %s refunded", uid, md["plan_to"], err, money(out.AmountReceived)))
		return nil
	}
	slog.InfoContext(ctx, "step-up paid on the pay page", "uid", uid, "to", md["plan_to"], "amount_cents", out.AmountReceived)
	return nil
}
