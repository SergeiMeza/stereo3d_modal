package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/stripe/stripe-go/v78"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// One-tap pay (BUX-20, owner 2026-11-07): a pay-first run or what the
// account owes (a settle) is paid with one tap on the saved default that
// has paid before, without the sheet. The customer is present: an
// on-session PaymentIntent in USD under pmc_web (Link and PayPal
// defaults work; no Adaptive Pricing — a server PaymentIntent is never
// presented locally). The bank's check is answered on the web
// (stripe.handleNextAction with the client secret); a decline answers a
// customer-safe message and the web offers "Pay another way" (the sheet).
// The amount is the server's: the client sends what it showed and a
// mismatch is refused. Every tap's PaymentIntent is recorded before money
// moves; a second tap meanwhile is refused; webhooks apply it once.

const oneTapLease = 2 * time.Minute

// oneTapOffer is what the quote, run and settle answers carry when one tap
// is allowed: {brand, last4, wallet?, type, email_masked?, amount_cents,
// currency: "usd"}; nil otherwise.
func (s *Service) oneTapOffer(ctx context.Context, uid string, cust *store.Customer, amount int64, china bool) map[string]any {
	if !s.rates(ctx).OneTapEnabled || china || amount <= 0 || s.Cfg.StripePMCWeb == "" || cust == nil || cust.StripeCustomerID == "" {
		return nil
	}
	if !hasCredit(cust) || cust.SheetOnly || cust.AllMethodsFailed || cust.UnderReview || cust.Blocked || cust.DeletionPending ||
		cust.AccountDeleted || s.methodBlocked(ctx, uid, cust) {
		return nil
	}
	out := map[string]any{"brand": cust.CardBrand, "last4": cust.CardLast4, "type": cust.DefaultMethodType,
		"amount_cents": amount, "currency": "usd"}
	if cust.DefaultMethodWallet != "" {
		out["wallet"] = cust.DefaultMethodWallet
	}
	if cust.DefaultMethodEmail != "" {
		out["email_masked"] = maskEmail(cust.DefaultMethodEmail)
	}
	return out
}

func errOneTapUnavailable() error {
	return httpx.Err(http.StatusConflict, "one_tap_unavailable", "Pay another way.")
}

func errAmountChanged(cents int64) error {
	e := httpx.Err(http.StatusConflict, "amount_changed", "The amount changed. Check it and pay again.")
	e.Details = map[string]any{"amount_cents": cents}
	return e
}

// oneTapDeclined is the answer's decline: {state: "declined", message,
// decline_code?}.
func oneTapDeclined(f stripex.ChargeFailure) map[string]any {
	out := map[string]any{"state": "declined", "message": customerMessage(f)}
	if dc := declineOf(f); dc != "" {
		out["decline_code"] = dc
	}
	return out
}

// POST /v1/conversions/{id}/pay-one-tap {amount_cents} → the run (as
// pay-now answers) plus {state: succeeded | processing | requires_action |
// declined, client_secret? (requires_action), message? (declined)}.
// 409 one_tap_unavailable (pay in the sheet), amount_changed
// {amount_cents}, payment_in_progress (a tap already being paid),
// already_paid, expired, not_payable.
func (s *Service) HandleRunPayOneTap(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	var req struct {
		AmountCents int64 `json:"amount_cents"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req)
	conv, err := s.Store.GetConversion(ctx, id)
	if err != nil || conv.UID != user.UID || s.projectGone(ctx, conv, nil) {
		httpx.WriteErr(ctx, w, httpx.ErrNotFound("conversion"))
		return
	}
	if err := runPayable(conv); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	cust, _ := s.Store.GetCustomer(ctx, user.UID)
	amount := runCardCents(conv)
	if conv.PaymentFlow != store.FlowPayNow || s.oneTapOffer(ctx, user.UID, cust, amount, chinaMode(r)) == nil {
		httpx.WriteErr(ctx, w, errOneTapUnavailable())
		return
	}
	if req.AmountCents != amount {
		httpx.WriteErr(ctx, w, errAmountChanged(amount))
		return
	}
	now := time.Now().UTC()
	leased, err := s.Store.Transition(ctx, id, []string{store.StateCreated}, func(c *store.Conversion) error {
		if c.Stripe.OneTapUntil != nil && now.Before(*c.Stripe.OneTapUntil) {
			return store.ErrStateConflict
		}
		until := now.Add(oneTapLease)
		c.Stripe.OneTapUntil = &until
		return nil
	})
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "payment_in_progress", "your payment is being confirmed"))
		return
	}
	defer s.Store.Transition(ctx, id, []string{store.StateCreated}, func(c *store.Conversion) error { c.Stripe.OneTapUntil = nil; return nil })
	pm := cust.DefaultPaymentMethod
	job := stripex.Job{Web: true, ConversionID: conv.ID, UID: conv.UID, Description: piDescription(conv), ReceiptEmail: user.Email,
		PMC: s.Cfg.StripePMCWeb, Metadata: map[string]string{"payment_flow": "one_tap", "kind": "run"}}
	// Record before money: the PaymentIntent is made unconfirmed and
	// becomes the run's current payment (the sheet's session closed),
	// then it is confirmed. Key per tap: a failed tap's next is a new one.
	updated, err := s.replaceRunPayment(ctx, leased, func(attempt int) (*store.Payment, error) {
		pi, perr := s.Stripe.CreateOnSession(cust.StripeCustomerID, pm, amount, fmt.Sprintf("onetap_%s_%s_%d", s.Cfg.Env, conv.ID, attempt), job)
		if perr != nil {
			return nil, perr
		}
		return &store.Payment{Kind: store.PaymentIntentKind, ID: pi.ID, Attempt: attempt, CreatedAt: time.Now().UTC(), ClientIP: clientIP(r)}, nil
	})
	if errors.Is(err, errAlreadyPaid) {
		resp := s.payNowResponse(updated)
		resp["state"] = "succeeded"
		httpx.WriteOK(w, resp)
		return
	}
	if err != nil || updated.CurrentPayment == nil || updated.CurrentPayment.Kind != store.PaymentIntentKind {
		httpx.Log(ctx).Error("one-tap payment not made", "conversion_id", id, "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "the payment couldn't be made; try again"))
		return
	}
	cp := *updated.CurrentPayment
	pi, cerr := s.Stripe.ConfirmOnSession(cp.ID, s.Cfg.SiteURL+"/pay/return?c="+conv.ID)
	resp, final := s.oneTapOutcome(ctx, cp.ID, pi, cerr)
	if final != nil {
		if applied, aerr := s.applyRunPayment(ctx, id, cp, *final); aerr == nil {
			updated = applied
		}
	} else if fresh, gerr := s.Store.GetConversion(ctx, id); gerr == nil {
		updated = fresh
	}
	if resp == nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "the payment couldn't be made; try again"))
		return
	}
	out := s.payNowResponse(updated)
	for k, v := range resp {
		out[k] = v
	}
	httpx.Log(ctx).Info("one-tap run payment", "conversion_id", id, "uid", user.UID, "state", resp["state"], "payment_intent", cp.ID)
	httpx.WriteOK(w, out)
}

// oneTapOutcome reads a confirmed (or refused) one-tap PaymentIntent:
// the answer's fields, and the money outcome to apply (nil: none yet). A
// decline cancels the PaymentIntent (a cancel that finds it paid means
// paid). nil answer: infrastructure trouble — the tap can be repeated (the
// next closes this PaymentIntent first).
func (s *Service) oneTapOutcome(ctx context.Context, piID string, pi *stripe.PaymentIntent, cerr error) (map[string]any, *stripex.Outcome) {
	if cerr != nil {
		f := stripex.ClassifyChargeError(cerr)
		if f.Transient {
			return nil, nil
		}
		if f.Config {
			s.alertConfigError(ctx, "one-tap", piID, "", f)
		}
		out, closeErr := s.Stripe.ClosePaymentIntent(piID)
		if closeErr == nil && (out.Paid || out.Processing) {
			return map[string]any{"state": stateOf(out)}, &out
		}
		return oneTapDeclined(f), nil
	}
	pm := ""
	if pi.PaymentMethod != nil {
		pm = pi.PaymentMethod.ID
	}
	switch pi.Status {
	case stripe.PaymentIntentStatusSucceeded, stripe.PaymentIntentStatusProcessing:
		out := stripex.Outcome{PaymentIntentID: pi.ID, AmountReceived: pi.AmountReceived, PaymentMethod: pm,
			Paid: pi.Status == stripe.PaymentIntentStatusSucceeded, Processing: pi.Status == stripe.PaymentIntentStatusProcessing}
		return map[string]any{"state": stateOf(out)}, &out
	case stripe.PaymentIntentStatusRequiresAction:
		return map[string]any{"state": "requires_action", "client_secret": pi.ClientSecret}, nil
	}
	// requires_payment_method without an error: refused
	out, closeErr := s.Stripe.ClosePaymentIntent(piID)
	if closeErr == nil && (out.Paid || out.Processing) {
		return map[string]any{"state": stateOf(out)}, &out
	}
	return oneTapDeclined(stripex.ChargeFailure{Code: "card_declined"}), nil
}

func stateOf(out stripex.Outcome) string {
	if out.Processing && !out.Paid {
		return "processing"
	}
	return "succeeded"
}

// POST /v1/billing/settle/one-tap {amount_cents, settle_id?} → the settle
// answer (as POST /v1/billing/settle with ui) plus {state: succeeded |
// processing | requires_action | declined, client_secret?, message?}.
// 409 one_tap_unavailable, amount_changed {amount_cents},
// payment_in_progress; {settled: true} when nothing is owed.
func (s *Service) HandleSettleOneTap(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		AmountCents int64  `json:"amount_cents"`
		SettleID    string `json:"settle_id"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req)
	cust, _ := s.Store.GetCustomer(ctx, user.UID)
	owed := s.owedCents(ctx, user.UID)
	if owed > 0 && s.oneTapOffer(ctx, user.UID, cust, owed, chinaMode(r)) == nil {
		httpx.WriteErr(ctx, w, errOneTapUnavailable())
		return
	}
	pc := payContextOf(r)
	pc.OneTapCents, pc.SettleID = req.AmountCents, req.SettleID
	res, err := s.collectOutstanding(ctx, user.UID, settleOneTap, pc)
	if err != nil {
		var api *httpx.APIError
		if errors.As(err, &api) {
			httpx.WriteErr(ctx, w, err)
			return
		}
		httpx.Log(ctx).Error("one-tap settle failed", "uid", user.UID, "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "the payment couldn't be made; try again"))
		return
	}
	resp := s.settleSheetResponse(ctx, user.UID, res)
	switch {
	case res.Nothing || res.Paid:
		resp["state"] = "succeeded"
		if res.Settle != nil && res.Settle.PaymentState == store.SettleInProgress {
			resp["state"] = "processing"
		}
	case res.RequiresAction:
		resp["state"], resp["client_secret"] = "requires_action", res.ClientSecret
	case res.Declined && res.Failure != nil:
		for k, v := range oneTapDeclined(*res.Failure) {
			resp[k] = v
		}
	case res.Settle != nil && res.Settle.PaymentState == store.SettleInProgress:
		resp["state"] = "processing"
	default:
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "payment_in_progress", "your payment is being confirmed"))
		return
	}
	httpx.WriteOK(w, resp)
}

// oneTapSettle pays a settle with one tap (trigger settleOneTap): the
// amount checked against what the web showed, the charge recorded first
// (B5), an on-session PaymentIntent on the default.
func (s *Service) oneTapSettle(ctx context.Context, st *store.Settle, dropped []string, pc payContext) (settleResult, error) {
	if pc.OneTapCents != st.AmountCents {
		s.Store.FinishSettle(ctx, st.ID, store.SettleOutcome{}, dropped) // nothing charged: back to owed
		return settleResult{}, errAmountChanged(st.AmountCents)
	}
	cust, err := s.Store.GetCustomer(ctx, st.UID)
	if err != nil || cust.DefaultPaymentMethod == "" {
		s.Store.FinishSettle(ctx, st.ID, store.SettleOutcome{}, dropped)
		return settleResult{}, errOneTapUnavailable()
	}
	pm := cust.DefaultPaymentMethod
	key := s.Stripe.SettleChargeKey(st.ID) + "_onetap"
	startedAt := time.Now().UTC()
	if _, uerr := s.Store.UpdateSettle(ctx, st.ID, func(x *store.Settle) error {
		if x.State != store.SettleSettling {
			return store.ErrStateConflict
		}
		x.ChargeKey, x.ChargePM, x.ChargeCustomerID, x.ChargeStartedAt = key, pm, cust.StripeCustomerID, &startedAt
		return nil
	}); uerr != nil {
		return settleResult{Settle: st}, uerr
	}
	job := stripex.Job{Web: true, UID: st.UID, Description: fmt.Sprintf("Your last runs (%d)", st.Runs()), ReceiptEmail: cust.Email,
		PMC: s.Cfg.StripePMCWeb, Metadata: map[string]string{"settle_id": st.ID, "payment_flow": "settle_one_tap"}}
	pi, cerr := s.Stripe.ChargeOnSession(cust.StripeCustomerID, pm, st.AmountCents, s.Cfg.SiteURL+"/billing?settle="+st.ID, key, job)
	if cerr != nil {
		f := stripex.ClassifyChargeError(cerr)
		if f.Transient {
			return settleResult{Settle: st}, cerr // the lease lapses; the sweep finds what the charge made (B5)
		}
		if f.PaymentIntentID != "" {
			if out, cl := s.Stripe.ClosePaymentIntent(f.PaymentIntentID); cl == nil && (out.Paid || out.Processing) {
				return s.applySettlePayment(ctx, st.ID, store.Payment{Kind: store.PaymentIntentKind, ID: out.PaymentIntentID}, out)
			}
		}
		if f.Config {
			s.alertConfigError(ctx, "one-tap settle", st.ID, st.UID, f)
		}
		closed, ferr := s.Store.FinishSettle(ctx, st.ID, store.SettleOutcome{}, dropped)
		return settleResult{Settle: closed, Declined: true, Failure: &f}, ferr
	}
	switch pi.Status {
	case stripe.PaymentIntentStatusSucceeded, stripe.PaymentIntentStatusProcessing:
		out := stripex.Outcome{PaymentIntentID: pi.ID, AmountReceived: pi.AmountReceived, PaymentMethod: pm,
			Paid: pi.Status == stripe.PaymentIntentStatusSucceeded, Processing: pi.Status == stripe.PaymentIntentStatusProcessing}
		return s.applySettlePayment(ctx, st.ID, store.Payment{Kind: store.PaymentIntentKind, ID: pi.ID}, out)
	case stripe.PaymentIntentStatusRequiresAction:
		// The web answers the bank's check; the succeeded webhook settles
		// it. Live for 30 min, then the sweep closes it.
		until := time.Now().UTC().Add(iosBankCheckLease)
		p := store.Payment{Kind: store.PaymentIntentKind, ID: pi.ID, ExpiresAt: &until, CreatedAt: time.Now().UTC()}
		updated, uerr := s.Store.UpdateSettle(ctx, st.ID, func(x *store.Settle) error {
			x.CurrentPayment, x.Payments = &p, append(x.Payments, p)
			x.PaymentState = store.SettleOpen
			x.Lease = &store.Lease{Owner: leaseOwner, Until: until}
			return nil
		})
		return settleResult{Settle: updated, RequiresAction: true, ClientSecret: pi.ClientSecret}, uerr
	}
	out, cl := s.Stripe.ClosePaymentIntent(pi.ID)
	if cl == nil && (out.Paid || out.Processing) {
		return s.applySettlePayment(ctx, st.ID, store.Payment{Kind: store.PaymentIntentKind, ID: pi.ID}, out)
	}
	f := stripex.ChargeFailure{Code: "card_declined", PaymentIntentID: pi.ID}
	closed, ferr := s.Store.FinishSettle(ctx, st.ID, store.SettleOutcome{}, dropped)
	return settleResult{Settle: closed, Declined: true, Failure: &f}, ferr
}

// oneTapLiveSettle: a one-tap on a settle that is already live — the
// sheet's session is closed and the settle paid with one tap; a tap
// already in flight or a bank check waiting answers as it stands.
func (s *Service) oneTapLiveSettle(ctx context.Context, st *store.Settle, pc payContext) (settleResult, error) {
	res := settleResult{Settle: st, Live: true}
	if cp := st.CurrentPayment; cp != nil && cp.Kind == store.PaymentIntentKind {
		if pi, err := s.Stripe.GetPaymentIntent(cp.ID); err == nil && pi.Status == stripe.PaymentIntentStatusRequiresAction {
			res.RequiresAction, res.ClientSecret = true, pi.ClientSecret
		}
		return res, nil
	}
	if st.ChargeStartedAt != nil && st.CurrentPayment == nil {
		return res, nil // a tap being charged: payment_in_progress
	}
	if cp := st.CurrentPayment; cp != nil {
		out, err := s.closePayment(cp)
		if err != nil {
			return res, err
		}
		if out.Paid || out.Processing {
			return s.applySettlePayment(ctx, st.ID, *cp, out)
		}
		if _, err := s.Store.UpdateSettle(ctx, st.ID, func(x *store.Settle) error {
			x.CurrentPayment = nil
			return nil
		}); err != nil {
			return res, err
		}
	}
	slog.InfoContext(ctx, "one-tap on a live settle", "settle_id", st.ID)
	return s.oneTapSettle(ctx, st, nil, pc)
}
