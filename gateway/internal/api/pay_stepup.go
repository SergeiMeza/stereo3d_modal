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
// mails SU1 once per link a day.
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
	// once per link a UTC day (REV-18): each in-app retry is a new quote,
	// and the customer is already looking at the error
	s.mailCustomer(ctx, "SU1_"+pr.ID+"_"+time.Now().UTC().Format("20060102"), uid, s.accountEmail(ctx, uid), customerMail{
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
// completed / async succeeded). The pay request claims the session in
// two phases (REV-01): "applying" first, "paid" only once the change is
// made, so a delivery cut short (a deploy, a Firestore or Stripe blip)
// leaves it applying and the next delivery, or stepUpApplySweep, makes
// it (its Stripe keys are the session's: nothing is done twice). A change
// that can no longer be made is refunded. A transient failure answers
// 5xx: Stripe sends the event again.
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
	now := time.Now().UTC()
	claimed, busy := false, false
	_, err = s.Store.UpdatePayRequest(ctx, token, func(x *store.PayRequest) error {
		claimed, busy = false, false
		if x.UID != uid || x.Kind != store.PayKindStepUp {
			return store.ErrStateConflict
		}
		// ours: this session claimed it (records from before REV-01 are
		// paid with no claim time)
		ours := x.CheckoutID == sessionID && (x.ClaimedAt != nil || x.State == store.PayPaid)
		switch {
		case ours && x.State == store.PayApplying:
			if x.ApplyLease != nil && now.Before(*x.ApplyLease) {
				busy = true // another attempt is at it
				return nil
			}
		case ours:
			return nil // made (paid) or refunded (void) already
		case x.State == store.PayPaid || x.State == store.PayApplying:
			return store.ErrStateConflict // paid by another session: this one is refunded
		default:
			x.ClaimedAt = &now
			x.Apply = map[string]string{"plan_to": md["plan_to"], "quote_at": md["quote_at"], "credit_cents": md["credit_cents"]}
		}
		lease := now.Add(stepUpApplyLease)
		x.State, x.CheckoutID, x.ApplyLease, x.ApplyAttempts, claimed = store.PayApplying, sessionID, &lease, x.ApplyAttempts+1, true
		return nil
	})
	if errors.Is(err, store.ErrStateConflict) || errors.Is(err, store.ErrNotFound) {
		s.refundLatePayment(ctx, &store.Conversion{ID: "stepup:" + payTokenRef(token), UID: uid}, out.PaymentIntentID, out.AmountReceived, "a step-up paid twice or not ours")
		return nil
	}
	if err != nil {
		return err
	}
	if busy {
		return errStepUpBusy
	}
	if !claimed {
		return nil
	}
	return s.stepUpApply(ctx, token, uid, sessionID, out, md, false)
}

const (
	stepUpApplyLease  = 2 * time.Minute // one attempt's hold on a claimed step-up
	stepUpApplyGiveUp = 2 * time.Hour   // a change still not made this long after the payment is refunded
)

var errStepUpBusy = errors.New("step-up change in progress")

// stepUpApply makes the change a claimed (applying) step-up session paid
// for. A transient failure leaves it applying, its lease let go, and
// answers the error; one that can't be cured (no plan, the quote no
// longer a step-up, Stripe refusing it), or any failure once giveUp, is
// refunded.
func (s *Service) stepUpApply(ctx context.Context, token, uid, sessionID string, out stripex.Outcome, md map[string]string, giveUp bool) error {
	fail := func(err error, permanent bool) error {
		if permanent || giveUp {
			s.stepUpRefund(ctx, token, uid, sessionID, out, md["plan_to"], err)
			return nil
		}
		s.Store.UpdatePayRequest(ctx, token, func(x *store.PayRequest) error {
			if x.State == store.PayApplying && x.CheckoutID == sessionID {
				x.ApplyLease, x.ApplyError = nil, err.Error()
			}
			return nil
		})
		slog.WarnContext(ctx, "paid step-up not applied yet; tried again", "pay_request", payTokenRef(token), "err", err)
		return err
	}
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil {
		return fail(err, false)
	}
	if cust.Plan != nil && cust.Plan.Key() == md["plan_to"] {
		// an earlier attempt made the change and was cut before it said so
		s.stepUpPaid(ctx, token, sessionID, uid, md["plan_to"], out.AmountReceived)
		return nil
	}
	quoteAt, _ := strconv.ParseInt(md["quote_at"], 10, 64)
	credit, _ := strconv.ParseInt(md["credit_cents"], 10, 64)
	q, qerr := s.quotePlanChange(ctx, uid, cust, md["plan_to"], time.Unix(quoteAt, 0).UTC())
	if qerr != nil {
		return fail(qerr, qerr.Status < 500)
	}
	if q.Kind != changeStepUp {
		return fail(errors.New("no longer a step-up"), true) // REV-19: an explicit error, not a typed nil
	}
	q.CreditCents = credit // what the customer was shown and paid against
	if err := s.applyStepUpWith(ctx, cust, q, stepUpPaid{Cents: out.AmountReceived, Session: sessionID}); err != nil {
		var api *httpx.APIError
		return fail(err, errors.As(err, &api) && api.Status < 500)
	}
	s.stepUpPaid(ctx, token, sessionID, uid, md["plan_to"], out.AmountReceived)
	return nil
}

func (s *Service) stepUpPaid(ctx context.Context, token, sessionID, uid, to string, cents int64) {
	now := time.Now().UTC()
	s.Store.UpdatePayRequest(ctx, token, func(x *store.PayRequest) error {
		if x.State == store.PayApplying && x.CheckoutID == sessionID {
			x.State, x.ClosedAt, x.VoidReason, x.ApplyLease, x.ApplyError = store.PayPaid, &now, "paid on the pay page", nil, ""
		}
		return nil
	})
	slog.InfoContext(ctx, "step-up paid on the pay page", "uid", uid, "to", to, "amount_cents", cents)
}

func (s *Service) stepUpRefund(ctx context.Context, token, uid, sessionID string, out stripex.Outcome, to string, why error) {
	now := time.Now().UTC()
	s.Store.UpdatePayRequest(ctx, token, func(x *store.PayRequest) error {
		if x.State == store.PayApplying && x.CheckoutID == sessionID {
			x.State, x.ClosedAt, x.VoidReason, x.ApplyLease, x.ApplyError = store.PayVoid, &now, "change failed after payment; refunded", nil, why.Error()
		}
		return nil
	})
	slog.WarnContext(ctx, "paid step-up not applied; refunding", "pay_request", payTokenRef(token), "err", why)
	s.refundLatePayment(ctx, &store.Conversion{ID: "stepup:" + payTokenRef(token), UID: uid}, out.PaymentIntentID, out.AmountReceived, "the plan change couldn't be made after it was paid")
	s.Slack.Alert(ctx, "stepup_refunded", fmt.Sprintf("`%s`'s paid step-up to %s couldn't be made (%v); %s refunded", uid, to, why, money(out.AmountReceived)))
}

// stepUpApplySweep takes up the paid step-ups left applying (a delivery
// cut short, Stripe's redeliveries spent): the change is made, or, two
// hours after the payment, refunded (reconciler).
func (s *Service) stepUpApplySweep(ctx context.Context, now time.Time) (done int) {
	rows, err := s.Store.ListPayRequests(ctx, "", store.PayApplying, 50)
	if err != nil {
		return 0
	}
	for _, p := range rows {
		if p.Kind != store.PayKindStepUp || p.CheckoutID == "" || p.ClaimedAt == nil || p.ApplyLease != nil && now.Before(*p.ApplyLease) {
			continue
		}
		out, _, err := s.Stripe.SessionOutcome(p.CheckoutID)
		if err != nil || !out.Paid {
			continue
		}
		taken := false
		lease := now.Add(stepUpApplyLease)
		if _, err := s.Store.UpdatePayRequest(ctx, p.ID, func(x *store.PayRequest) error {
			taken = false
			if x.State != store.PayApplying || x.CheckoutID != p.CheckoutID || x.ApplyLease != nil && now.Before(*x.ApplyLease) {
				return nil
			}
			x.ApplyLease, x.ApplyAttempts, taken = &lease, x.ApplyAttempts+1, true
			return nil
		}); err != nil || !taken {
			continue
		}
		md := map[string]string{"plan_to": p.Apply["plan_to"], "quote_at": p.Apply["quote_at"], "credit_cents": p.Apply["credit_cents"]}
		if s.stepUpApply(ctx, p.ID, p.UID, p.CheckoutID, out, md, now.Sub(*p.ClaimedAt) > stepUpApplyGiveUp) == nil {
			done++
		}
	}
	return done
}
