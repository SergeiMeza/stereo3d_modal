package api

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/stripe/stripe-go/v78"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Prepaid balance (spec v7.1 §N), web only: top-ups through the same
// sheet as runs, optional auto-reload, runs paid from the balance with a
// hold settled at the end (the store keeps the ledger and E0-8), debts
// paid from the balance, expiry and alerts.

const (
	topupMinCents      = 1000  // T2
	topupMaxCents      = 50000 // T3
	topupFirstMaxCents = 10000
	topupDayMaxCents   = 100000
	reloadTextVersion  = "reload-v1-2026-11"
	settleBalance      = "balance" // C11 trigger: pay debts from the balance (N9)
)

// ------------------------------------------------------------- summary

// balanceSummary is the N13 summary the web reads (BalanceSummary).
func (s *Service) balanceSummary(ctx context.Context, uid string, b *store.Balance) map[string]any {
	if b == nil {
		b, _ = s.Store.GetBalance(ctx, uid)
		if b == nil {
			b = store.NewBalance(uid)
		}
	}
	ar := map[string]any{"enabled": b.AutoReload.Enabled, "below_cents": b.AutoReload.BelowCents, "add_cents": b.AutoReload.AddCents}
	if b.AutoReload.PausedReason != "" {
		ar["paused_reason"] = b.AutoReload.PausedReason
	}
	out := map[string]any{
		"balance_cents":     b.BalanceCents,
		"held_cents":        b.HeldCents,
		"held_runs":         len(b.Holds),
		"frozen_cents":      b.FrozenCents,
		"available_cents":   max(b.Available(), 0),
		"expires_at":        nil,
		"expired":           b.Expired,
		"never_topped_up":   b.LastTopupAt == nil,
		"auto_reload":       ar,
		"spend_limit_cents": b.SpendLimitCents,
		"month_spent_cents": int64(0),
		"low_balance_cents": b.LowBalanceCents,
		"currency":          "usd",
	}
	if b.ExpiresAt != nil && !b.Expired {
		out["expires_at"] = b.ExpiresAt.Format(time.RFC3339)
	}
	// The prepaid part alone (top-ups, without a plan's usage credit, which
	// the plan block shows): its own expiry (12 months after the last
	// top-up) and freezes; balance_cents, frozen_cents and expires_at keep
	// meaning the whole, as before.
	prepaid := max(b.BalanceCents-b.PlanCreditCents(), 0)
	out["prepaid_cents"] = prepaid
	out["prepaid_frozen_cents"] = max(b.FrozenCents-b.PlanCreditFrozen(), 0)
	out["plan_credit_cents"] = b.PlanCreditCents()
	// Credit broken out (owner 2026-11-07: a $0.00 balance sat beside
	// unspent credit): one entry per unexpired credit with cents left,
	// soonest to expire first. ref is the plan's or Pro's key, not shown.
	credits := []map[string]any{}
	for _, c := range b.Credits(time.Now()) {
		e := map[string]any{"kind": c.Kind, "cents": c.Cents, "expires_at": nil}
		if c.ExpiresAt != nil {
			e["expires_at"] = c.ExpiresAt.UTC().Format(time.RFC3339)
		}
		if c.Kind == "plan" && c.Ref != "" {
			e["ref"] = c.Ref
		}
		credits = append(credits, e)
	}
	out["credits"] = credits
	out["prepaid_expires_at"] = nil
	if prepaid > 0 && b.ExpiresAt != nil && !b.Expired {
		out["prepaid_expires_at"] = b.ExpiresAt.Format(time.RFC3339)
	}
	if b.Exists() {
		out["month_spent_cents"] = s.monthSpent(ctx, uid, b)
	}
	if b.ReloadInFlight != nil {
		out["reload_in_flight"] = map[string]any{"topup_id": b.ReloadInFlight.TopupID, "cents": b.ReloadInFlight.Cents} // R8
	}
	return out
}

// monthSpent (N6, T14): settled + held this calendar month (UTC), balance
// and pay-as-you-go together; pay-as-you-go runs count their quote from
// submit, then what was finally charged.
func (s *Service) monthSpent(ctx context.Context, uid string, b *store.Balance) int64 {
	now := time.Now().UTC()
	month := now.Format("2006-01")
	sum := b.MonthSettledFor(month) + b.HeldCents
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	convs, err := s.Store.ListUserConversions(ctx, uid, 500)
	if err != nil {
		return sum
	}
	for _, c := range convs {
		if c.CreatedAt.Before(start) {
			break // newest first
		}
		if c.ProjectID == "" || (c.RunBalance != nil && !c.RunBalance.Partial) || c.Quote.AmountCents <= 0 {
			continue // a split run's balance part is in the ledger; its card part counts below
		}
		switch {
		case c.Stripe.PIStatus == store.PIRefunded || c.Stripe.PIStatus == store.PICanceled:
			sum += max(c.Stripe.CapturedCents-c.Stripe.RefundedCents, 0)
		case c.State == store.StateFailed || c.State == store.StateCanceled || c.State == store.StateExpired:
		case c.Stripe.CapturedCents > 0:
			sum += c.Stripe.CapturedCents
		default:
			sum += runCardCents(c)
		}
	}
	return sum
}

// GET /v1/billing/balance → the summary.
func (s *Service) HandleGetBalance(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	httpx.WriteOK(w, s.balanceSummary(r.Context(), user.UID, nil))
}

// ------------------------------------------------------------- top-ups

func topupLabel(cents int64) string { return "Spatial Video Studio balance · " + money(cents) }

// topupRange is the allowed amount for this account now (T3).
func (s *Service) topupRange(ctx context.Context, uid string, b *store.Balance) (lo, hi int64) {
	hi = topupMaxCents
	if b.TopupCount == 0 {
		hi = topupFirstMaxCents
	}
	if b.DayKey == time.Now().UTC().Format("2006-01-02") {
		hi = min(hi, topupDayMaxCents-b.DayTopupCents)
	}
	return topupMinCents, hi
}

// POST /v1/billing/balance/topup {amount_cents, ui: elements|hosted_page}
// → {checkout {client_secret, expires_at}, topup_id, publishable_key,
// amount_cents}; China {amount_cents, method: alipay, return_url?} →
// {topup_id, redirect_url, next_action}. 422 amount_out_of_range {min, max}.
func (s *Service) HandleTopup(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		AmountCents int64  `json:"amount_cents"`
		UI          string `json:"ui"`
		Method      string `json:"method"`
		ReturnURL   string `json:"return_url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	cust, _ := s.Store.GetCustomer(ctx, user.UID)
	if cust != nil && cust.AccountDeleted {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusGone, "account_deleted", "this account has been deleted"))
		return
	}
	if cust != nil && cust.UnderReview {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusForbidden, "under_review", "we're checking a payment on your account; contact support to continue"))
		return
	}
	if cust != nil && cust.DeletionPending {
		httpx.WriteErr(ctx, w, errDeletionPending())
		return
	}
	if s.methodBlocked(ctx, user.UID, cust) { // H: block list at the gate
		httpx.WriteErr(ctx, w, errMethodBlocked())
		return
	}
	b, err := s.Store.GetBalance(ctx, user.UID)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	lo, hi := s.topupRange(ctx, user.UID, b)
	if dayLeft := topupDayMaxCents - b.DayTopupCents; b.DayKey == time.Now().UTC().Format("2006-01-02") &&
		req.AmountCents >= lo && req.AmountCents > dayLeft {
		// Over the $1,000-a-day cap (T3): its own code, so the web can say
		// how much is left today and when it resets.
		now := time.Now().UTC()
		e := httpx.Err(http.StatusUnprocessableEntity, "topup_daily_cap",
			fmt.Sprintf("You can add up to %s more today.", money(max(dayLeft, 0))))
		e.Details = map[string]any{"min": lo, "max": max(hi, 0), "day_left_cents": max(dayLeft, 0), "day_cap_cents": int64(topupDayMaxCents),
			"resets_at": time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, time.UTC).Format(time.RFC3339)}
		httpx.WriteErr(ctx, w, e)
		return
	}
	if req.AmountCents < lo || req.AmountCents > hi || hi < lo {
		e := httpx.Err(http.StatusUnprocessableEntity, "amount_out_of_range",
			fmt.Sprintf("add between %s and %s", money(lo), money(max(hi, lo))))
		e.Details = map[string]any{"min": lo, "max": max(hi, 0)}
		httpx.WriteErr(ctx, w, e)
		return
	}
	t := &store.Topup{ID: "t" + store.NewID(), UID: user.UID, Cents: req.AmountCents, Currency: "usd", State: store.TopupOpen, CustomerID: customerID}
	if err := s.Store.CreateTopup(ctx, t); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	returnURL := s.Cfg.SiteURL + "/billing?topup=" + t.ID
	if req.ReturnURL != "" && len(req.ReturnURL) > len(s.Cfg.SiteURL) && req.ReturnURL[:len(s.Cfg.SiteURL)+1] == s.Cfg.SiteURL+"/" {
		returnURL = req.ReturnURL
	}
	if req.Method != "" || chinaMode(r) {
		if req.Method != "alipay" {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "method_unavailable", "this payment method isn't available yet"))
			return
		}
		pi, redirect, perr := s.Stripe.CreateAlipayTopup(customerID, t.Cents, returnURL, t.ID, 1,
			stripex.Job{UID: user.UID, Description: topupLabel(t.Cents)})
		if perr != nil {
			httpx.Log(ctx).Error("alipay top-up failed", "topup_id", t.ID, "err", perr)
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "the payment couldn't be opened; try again"))
			return
		}
		p := store.Payment{Kind: store.PaymentIntentKind, ID: pi.ID, Attempt: 1, CreatedAt: time.Now().UTC(), ClientIP: clientIP(r)}
		s.Store.UpdateTopup(ctx, t.ID, func(x *store.Topup) error {
			x.CurrentPayment, x.Payments = &p, append(x.Payments, p)
			return nil
		})
		httpx.WriteOK(w, map[string]any{"topup_id": t.ID, "amount_cents": t.Cents, "redirect_url": redirect,
			"next_action": map[string]any{"type": "redirect", "redirect_url": redirect}})
		return
	}
	if s.Cfg.StripePMCWeb == "" {
		httpx.WriteErr(ctx, w, errSheetUnavailable())
		return
	}
	ui := "elements"
	if req.UI == "hosted_page" || req.UI == "hosted" {
		ui = "hosted_page"
	}
	sess, serr := s.Stripe.CreateWebSession(stripex.SessionSpec{
		CustomerID: customerID, PMC: s.Cfg.StripePMCWeb, UI: ui, AmountCents: t.Cents, Currency: "usd",
		Label: topupLabel(t.Cents), ReturnURL: returnURL, NoWeChat: clientDevice(r) != "computer", SaveMethod: true, SavedOnce: s.savedOnceTypes(cust.StripeCustomerID),
		NoKlarna: len(s.rates(ctx).KlarnaMarkets) == 0, Description: topupLabel(t.Cents), // no receipt_email: E13 is the receipt
		Metadata: map[string]string{"kind": "topup", "topup_id": t.ID, "user_id": user.UID, "payment_flow": "topup", "attempt": "1"},
		IdemKey:  fmt.Sprintf("topup_%s_%s_1", s.Cfg.Env, t.ID),
	})
	if serr != nil {
		httpx.Log(ctx).Error("top-up session failed", "topup_id", t.ID, "err", serr)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "the payment couldn't be opened; try again"))
		return
	}
	exp := sess.Expires()
	p := store.Payment{Kind: store.PaymentCheckoutSession, ID: sess.ID, ExpiresAt: &exp, Attempt: 1, UI: ui,
		ClientSecret: sess.ClientSecret, URL: sess.URL, CreatedAt: time.Now().UTC(), ClientIP: clientIP(r)}
	s.Store.UpdateTopup(ctx, t.ID, func(x *store.Topup) error {
		x.CurrentPayment, x.Payments = &p, append(x.Payments, p)
		return nil
	})
	resp := map[string]any{"topup_id": t.ID, "amount_cents": t.Cents, "publishable_key": s.Stripe.PublishableKey,
		"checkout": map[string]any{"client_secret": sess.ClientSecret, "expires_at": exp.Format(time.RFC3339)}}
	if ui == "hosted_page" {
		resp["url"] = sess.URL
	}
	httpx.WriteOK(w, resp)
}

// applyTopupPayment folds money found on a top-up's payment object (a
// webhook, a sweep, an auto-reload): paid → credited once (the store
// keys it by PaymentIntent); a second payment of the same top-up is
// refunded (N3.4); processing waits.
func (s *Service) applyTopupPayment(ctx context.Context, topupID string, out stripex.Outcome) error {
	if !out.Paid || out.PaymentIntentID == "" {
		return nil
	}
	t, promoted, fx, err := s.Store.ApplyTopupPaid(ctx, topupID, out.PaymentIntentID, out.AmountReceived, out.PaymentMethod)
	if errors.Is(err, store.ErrDuplicateTopupPayment) {
		s.refundLatePayment(ctx, &store.Conversion{ID: "topup:" + topupID, UID: t.UID}, out.PaymentIntentID, out.AmountReceived,
			"a second payment for the same top-up")
		return nil
	}
	if err != nil {
		return err
	}
	if t.PaidAt == nil || time.Since(*t.PaidAt) > time.Minute {
		return nil // already applied earlier
	}
	slog.InfoContext(ctx, "balance topped up", "topup_id", topupID, "uid", t.UID, "amount_cents", out.AmountReceived, "auto", t.Auto)
	s.afterTopup(ctx, t, promoted, fx)
	return nil
}

// afterTopup: account facts, the invoice record, E13, waiting runs start,
// debts paid from the balance (N9).
func (s *Service) afterTopup(ctx context.Context, t *store.Topup, promoted []string, fx store.BalanceEffects) {
	s.notePaidOnce(ctx, t.UID)
	if t.PaidWith != "" {
		if cust, err := s.Store.GetCustomer(ctx, t.UID); err == nil && cust.DefaultPaymentMethod == t.PaidWith {
			s.noteMethodPaid(ctx, t.UID, t.PaidWith) // T24
		}
	}
	paidAt := time.Now().UTC()
	if t.PaidAt != nil {
		paidAt = *t.PaidAt
	}
	s.writeCharge(ctx, &store.Charge{UID: t.UID, Kind: store.ChargeTopup, SourceID: t.ID, CustomerID: t.CustomerID,
		PaymentIntentID: t.PaymentIntentID, AmountCents: t.PaidCents, Currency: "usd", PaidWith: t.PaidWith, PaidAt: paidAt,
		Lines: []store.ChargeLine{{ConversionID: "topup_" + t.ID, AmountCents: t.PaidCents, Description: "Spatial Video Studio balance top-up"}}})
	s.mailTopup(ctx, t)
	for _, id := range promoted {
		s.startPromotedRun(ctx, id)
	}
	s.handleBalanceEffects(ctx, t.UID, fx)
	s.payDebtsFromBalance(ctx, t.UID)
}

// startPromotedRun queues a run whose pending_reload hold became a
// normal hold.
func (s *Service) startPromotedRun(ctx context.Context, convID string) {
	updated, err := s.Store.Transition(ctx, convID, []string{store.StateCreated}, func(c *store.Conversion) error {
		if c.RunBalance == nil || c.RunBalance.State != store.HoldPendingReload {
			return store.ErrStateConflict
		}
		c.RunBalance.State, c.RunBalance.TopupID = store.HoldHeld, ""
		c.State, c.ExpiresAt = store.StatePaid, nil
		return nil
	})
	if err != nil {
		return
	}
	s.paidAtStart(ctx, updated)
	if serr := s.submitToModal(ctx, updated.ID); serr != nil {
		slog.WarnContext(ctx, "submit after reload failed; reconciler retries", "conversion_id", convID, "err", serr)
	}
}

// fallBackToPayNow: a run whose reload failed pays as it would have
// without a balance (N4 failure): the sheet, its clock running.
func (s *Service) fallBackToPayNow(ctx context.Context, convID string) {
	exp := time.Now().UTC().Add(noObjectHold)
	_, _ = s.Store.Transition(ctx, convID, []string{store.StateCreated}, func(c *store.Conversion) error {
		if c.RunBalance == nil || c.RunBalance.State != store.HoldPendingReload {
			return store.ErrStateConflict
		}
		c.RunBalance.State, c.RunBalance.ReleasedCents = store.HoldReleased, c.RunBalance.HoldCents
		c.PaymentFlow, c.PayReason, c.Stripe.Mode, c.ExpiresAt = store.FlowPayNow, "declined", store.BillingModeAutoPrecharge, &exp
		return nil
	})
}

// handleBalanceEffects runs what a balance transaction asked for after it
// committed: a reload charge, a low-balance mail.
func (s *Service) handleBalanceEffects(ctx context.Context, uid string, fx store.BalanceEffects) {
	s.rcAttrsTouch(ctx, uid, "balance") // web_credit_balance_usd
	if fx.LowAlert {
		s.mailLowBalance(ctx, uid, fx.Available)
	}
	if fx.ReloadTopupID != "" {
		id := fx.ReloadTopupID
		go s.runReload(context.WithoutCancel(ctx), id)
	}
}

// runReload charges an auto-reload off-session: the default, then the
// backups in the customer's order (C5), under a lease; key
// topup_{env}_{topup_id}. Never while a debt exists, under review or
// sheet_only (the reload is abandoned with a pause).
func (s *Service) runReload(ctx context.Context, topupID string) {
	t, err := s.Store.UpdateTopup(ctx, topupID, func(x *store.Topup) error {
		if x.State != store.TopupCharging || x.Lease.Held(time.Now()) {
			return store.ErrStateConflict
		}
		x.Lease = &store.Lease{Owner: leaseOwner, Until: time.Now().Add(leaseTTL)}
		return nil
	})
	if err != nil {
		return
	}
	fail := func(reason, msg string) {
		_, released, ferr := s.Store.FailTopup(ctx, topupID, reason, msg)
		if ferr != nil {
			slog.WarnContext(ctx, "reload failure not recorded", "topup_id", topupID, "err", ferr)
			return
		}
		for _, id := range released {
			s.fallBackToPayNow(ctx, id)
		}
		if reason == "declined" || reason == "stop_code" {
			s.mailReloadFailed(ctx, t)
		}
	}
	cust, err := s.Store.GetCustomer(ctx, t.UID)
	if err != nil {
		fail("", "no account")
		return
	}
	switch {
	case cust.UnderReview:
		fail("review", "under review")
		return
	case cust.SheetOnly:
		fail("sheet_only", "sheet only")
		return
	case s.owedCents(ctx, t.UID) > 0:
		fail("", "a debt exists") // R1: never while a pay-as-you-go debt exists
		return
	}
	if cust.DefaultPaymentMethod == "" {
		cust = s.refreshCardCache(ctx, t.UID, cust.StripeCustomerID)
	}
	if cust.DefaultPaymentMethod == "" {
		fail("declined", "no saved method")
		return
	}
	job := stripex.Job{UID: t.UID, Description: "Spatial Video Studio balance auto-reload"}
	pi, chErr := s.Stripe.ChargeTopup(cust.StripeCustomerID, cust.DefaultPaymentMethod, t.Cents, t.ID, job)
	paidWith := cust.DefaultPaymentMethod
	var f stripex.ChargeFailure
	switch {
	case chErr != nil:
		f = stripex.ClassifyChargeError(chErr)
	case pi.Status == stripe.PaymentIntentStatusSucceeded || pi.Status == stripe.PaymentIntentStatusProcessing:
	default:
		f = stripex.ChargeFailure{PaymentIntentID: pi.ID, Code: string(pi.Status), NeedsAction: true}
	}
	if f.Transient {
		return // the lease lapses; the sweep replays the key
	}
	if chErr != nil || f.Code != "" || f.NeedsAction {
		piID := f.PaymentIntentID
		paid := false
		if !f.Stop && !f.NeedsAction && piID != "" {
			methods, _ := s.Stripe.ListMethods(cust.StripeCustomerID)
			for _, m := range orderMethods(s.usableMethods(ctx, methods), cust.DefaultPaymentMethod, cust.BackupOrder) {
				if m.PaymentMethodID == cust.DefaultPaymentMethod {
					continue
				}
				pi2, err2 := s.Stripe.ConfirmWithMethod(piID, m.PaymentMethodID, 1, false)
				if err2 == nil && (pi2.Status == stripe.PaymentIntentStatusSucceeded || pi2.Status == stripe.PaymentIntentStatusProcessing) {
					pi, paidWith, paid = pi2, m.PaymentMethodID, true
					break
				}
				if err2 != nil {
					if f2 := stripex.ClassifyChargeError(err2); f2.Transient {
						return
					} else if f2.Stop {
						f = f2
						break
					}
				}
			}
		}
		if !paid {
			if piID != "" {
				if out, cerr := s.Stripe.ClosePaymentIntent(piID); cerr == nil && out.Paid {
					_ = s.applyTopupPayment(ctx, topupID, out)
					return
				} else if cerr != nil {
					return
				}
			}
			reason := "declined" // a bank check off-session counts as declined (N4)
			if f.Stop {
				reason = "stop_code"
				s.setSheetOnly(ctx, t.UID, "stop code "+f.DeclineCode)
			}
			fail(reason, "reload declined: "+f.Code)
			return
		}
	}
	s.Store.UpdateTopup(ctx, topupID, func(x *store.Topup) error { x.PaymentIntentID = pi.ID; return nil })
	if pi.Status == stripe.PaymentIntentStatusProcessing {
		return // the succeeded webhook credits it
	}
	_ = s.applyTopupPayment(ctx, topupID, stripex.Outcome{PaymentIntentID: pi.ID, AmountReceived: pi.AmountReceived, PaymentMethod: paidWith, Paid: true})
}

// handleTopupPI routes a PaymentIntent event of a top-up (China, auto-reload).
func (s *Service) handleTopupPI(ctx context.Context, eventType, topupID, piID, piStatus string, received int64, pm string) error {
	switch eventType {
	case "payment_intent.succeeded":
		return s.applyTopupPayment(ctx, topupID, stripex.Outcome{PaymentIntentID: piID, AmountReceived: received, PaymentMethod: pm, Paid: true})
	case "payment_intent.payment_failed", "payment_intent.canceled":
		t, err := s.Store.GetTopup(ctx, topupID)
		if err != nil || t.State == store.TopupPaid {
			return nil
		}
		if t.Auto && t.PaymentIntentID == piID {
			_, released, ferr := s.Store.FailTopup(ctx, topupID, "declined", "async payment ended "+piStatus)
			if ferr == nil {
				for _, id := range released {
					s.fallBackToPayNow(ctx, id)
				}
				s.mailReloadFailed(ctx, t)
			}
		}
	}
	return nil
}

// applyTopupSessionEvent: checkout.session.* for a top-up.
func (s *Service) applyTopupSessionEvent(ctx context.Context, eventType, sessionID, topupID string) error {
	switch eventType {
	case "checkout.session.completed", "checkout.session.async_payment_succeeded":
		out, _, err := s.Stripe.SessionOutcome(sessionID)
		if err != nil {
			return err
		}
		if out.Paid && out.PaymentMethod != "" {
			if t, gerr := s.Store.GetTopup(ctx, topupID); gerr == nil {
				if cust, cerr := s.Store.GetCustomer(ctx, t.UID); cerr == nil {
					if owner, typ, merr := s.Stripe.MethodOwner(out.PaymentMethod); merr == nil && owner == cust.StripeCustomerID && stripex.ReusableTypes[typ] {
						ip := ""
						if t.CurrentPayment != nil {
							ip = t.CurrentPayment.ClientIP
						}
						s.saveMethodFacts(ctx, t.UID, cust.StripeCustomerID, out.PaymentMethod, sessionID, ip, cust.DefaultPaymentMethod == "", true)
					}
				}
			}
		}
		return s.applyTopupPayment(ctx, topupID, out)
	case "checkout.session.expired", "checkout.session.async_payment_failed":
		_, _ = s.Store.UpdateTopup(ctx, topupID, func(x *store.Topup) error {
			if x.State != store.TopupOpen || x.CurrentPayment == nil || x.CurrentPayment.ID != sessionID {
				return store.ErrStateConflict
			}
			x.State = store.TopupCanceled
			return nil
		})
	}
	return nil
}

// ------------------------------------------------------------ settings

// PUT /v1/billing/balance/settings {auto_reload?: {enabled, below_cents,
// add_cents}, spend_limit_cents?: n|null, low_balance_cents?} → the
// summary. 409 method_needed (auto-reload without a saved method), 409
// auto_reload_blocked while a pause condition holds, 400 invalid values.
func (s *Service) HandlePutBalanceSettings(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var raw map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	var ar *store.AutoReload
	if v, ok := raw["auto_reload"]; ok {
		ar = &store.AutoReload{}
		if err := json.Unmarshal(v, ar); err != nil {
			httpx.WriteErr(ctx, w, httpx.ErrInvalid("auto_reload is malformed"))
			return
		}
		if ar.AddCents < topupMinCents || ar.AddCents > topupMaxCents || ar.BelowCents < 0 || ar.AddCents < ar.BelowCents {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "invalid_auto_reload",
				"the amount to add must be between $10 and $500 and at least the threshold"))
			return
		}
	}
	setLimit, clearLimit := int64(0), false
	if v, ok := raw["spend_limit_cents"]; ok {
		if string(v) == "null" {
			clearLimit = true
		} else if err := json.Unmarshal(v, &setLimit); err != nil || setLimit < 100 {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "invalid_spend_limit", "the spend limit must be at least $1"))
			return
		}
	}
	low := int64(-1)
	if v, ok := raw["low_balance_cents"]; ok {
		if err := json.Unmarshal(v, &low); err != nil || low < 0 {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "invalid_low_balance", "the alert amount can't be negative"))
			return
		}
	}
	turningOn := false
	if ar != nil && ar.Enabled {
		cust, err := s.requireRunnableLite(ctx, user)
		if err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
		if cust.DefaultPaymentMethod == "" {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "method_needed", "save a payment method to turn on auto-reload"))
			return
		}
		// auto_reload_blocked {reason: under_review | dispute | payment_failed |
		// deletion_pending}: auto-reload stays off while a payment is checked.
		reason := ""
		switch {
		case cust.UnderReview:
			reason = "under_review" // an early fraud warning or a blocked card
		case cust.SheetOnly:
			reason = "dispute"
		case cust.AllMethodsFailed:
			reason = "payment_failed"
		case cust.DeletionPending:
			reason = "deletion_pending"
		}
		if reason != "" {
			e := httpx.Err(http.StatusConflict, "auto_reload_blocked", "Auto-reload can't be turned on while we check a payment.")
			e.Details = map[string]any{"reason": reason}
			httpx.WriteErr(ctx, w, e)
			return
		}
		cur, _ := s.Store.GetBalance(ctx, user.UID)
		turningOn = cur == nil || !cur.AutoReload.Enabled || cur.AutoReload.PausedReason != ""
		if turningOn {
			if err := s.Store.RecordConsent(ctx, store.Consent{UID: user.UID, PaymentMethod: "auto_reload_" + cust.DefaultPaymentMethod,
				TextVersion: reloadTextVersion, IP: clientIP(r), At: time.Now().UTC()}); err != nil {
				httpx.WriteErr(ctx, w, err)
				return
			}
		}
	}
	b, fx, err := s.Store.BalanceTx(ctx, user.UID, func(b *store.Balance) ([]store.BalanceOp, error) {
		now := time.Now().UTC()
		if ar != nil {
			next := b.AutoReload
			next.Enabled, next.BelowCents, next.AddCents = ar.Enabled, ar.BelowCents, ar.AddCents
			if ar.Enabled && turningOn {
				next.PausedReason, next.PausedDay, next.ConsentAt, next.TextVersion = "", "", &now, reloadTextVersion
				b.ReloadArmed = b.BalanceCents-b.FrozenCents >= ar.BelowCents
			}
			b.AutoReload = next
		}
		if clearLimit {
			b.SpendLimitCents = nil
		} else if setLimit > 0 {
			b.SpendLimitCents = &setLimit
		}
		if low >= 0 {
			b.LowBalanceCents, b.LowAlertArmed = low, b.Available() >= low
		}
		return []store.BalanceOp{{Kind: store.EntryAdjustment, Note: "settings"}}, nil
	})
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	s.handleBalanceEffects(ctx, user.UID, fx)
	httpx.WriteOK(w, s.balanceSummary(ctx, user.UID, b))
}

// requireRunnableLite reads the account for settings (no debt check).
func (s *Service) requireRunnableLite(ctx context.Context, user *AuthedUser) (*store.Customer, error) {
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		return nil, err
	}
	cust, err := s.Store.GetCustomer(ctx, user.UID)
	if err != nil {
		return nil, err
	}
	if cust.DefaultPaymentMethod == "" {
		cust = s.refreshCardCache(ctx, user.UID, customerID)
	}
	return cust, nil
}

// --------------------------------------------------------------- runs

// balancePlan is how a run of amount would pay from the balance (N5).
type balancePlan struct {
	Use         bool
	ReloadCents int64 // > 0: waits for a reload (T8)
	Available   int64
	Enough      bool
	Exists      bool // the account has a balance (show the block)
}

// planBalance: paid from the balance when available covers the quote;
// short with auto-reload on (and allowed) → a reload of max(Y, shortfall
// in whole dollars, $10).
func (s *Service) planBalance(ctx context.Context, uid string, cust *store.Customer, amount int64) balancePlan {
	if amount <= 0 || s.Store == nil {
		return balancePlan{}
	}
	b, err := s.Store.GetBalance(ctx, uid)
	if err != nil || !b.Exists() {
		return balancePlan{}
	}
	hold := max(amount, 100)
	p := balancePlan{Available: max(b.Available(), 0), Exists: true}
	if p.Available >= hold {
		p.Use, p.Enough = true, true
		return p
	}
	ar := b.AutoReload
	if !ar.Enabled || ar.PausedReason != "" || cust == nil || cust.DefaultPaymentMethod == "" || cust.SheetOnly || cust.UnderReview {
		return p
	}
	if b.ReloadInFlight != nil {
		if p.Available+b.ReloadInFlight.Cents >= hold && b.Available()+b.ReloadInFlight.Cents-hold >= 0 {
			p.Use, p.ReloadCents = true, b.ReloadInFlight.Cents
		}
		return p
	}
	short := hold - p.Available
	reload := max(ar.AddCents, ((short+99)/100)*100, topupMinCents)
	p.Use, p.ReloadCents = true, reload
	return p
}

// quoteBalance is the quote's balance block (N13).
func (p balancePlan) quoteJSON() map[string]any {
	out := map[string]any{"available_cents": p.Available, "enough": p.Enough}
	if p.ReloadCents > 0 {
		out["reload_cents"] = p.ReloadCents
	}
	return out
}

// spendLimitError is N6's 403 when amount would pass the month's limit.
func (s *Service) spendLimitError(ctx context.Context, uid string, amount int64) error {
	b, err := s.Store.GetBalance(ctx, uid)
	if err != nil || b.SpendLimitCents == nil {
		return nil
	}
	if s.monthSpent(ctx, uid, b)+amount > *b.SpendLimitCents {
		e := httpx.Err(http.StatusForbidden, "spend_limit_reached", "You've reached your monthly spend limit.")
		e.Details = map[string]any{"spend_limit_cents": *b.SpendLimitCents}
		return e
	}
	return nil
}

// startBalanceRun writes a balance run with its hold in one transaction
// and queues it (N5), or parks it on a pending_reload hold. ok=false when
// the balance no longer covers it (a race): the caller falls back.
func (s *Service) startBalanceRun(ctx context.Context, w http.ResponseWriter, user *AuthedUser, cust *store.Customer,
	conv *store.Conversion, plan balancePlan, restore func()) bool {
	conv.PaymentFlow, conv.PayReason = store.FlowBalance, ""
	conv.Stripe = store.Stripe{CustomerID: cust.StripeCustomerID, Mode: store.BillingModeBalance}
	conv.RunBalance = &store.RunBalance{HoldCents: max(conv.Quote.AmountCents, 100), State: store.HoldHeld}
	conv.State = store.StatePaid
	if plan.ReloadCents > 0 {
		exp := time.Now().UTC().Add(noObjectHold)
		conv.State, conv.ExpiresAt = store.StateCreated, &exp
	}
	fx, err := s.Store.CreateConversionWithHold(ctx, conv, plan.ReloadCents)
	if errors.Is(err, store.ErrAlreadyExists) {
		s.replayConversion(ctx, w, user, conv.ID)
		return true
	}
	if errors.Is(err, store.ErrInsufficientBalance) {
		conv.RunBalance, conv.ExpiresAt = nil, nil
		return false
	}
	if err != nil {
		restore()
		httpx.WriteErr(ctx, w, err)
		return true
	}
	httpx.Log(ctx).Info("conversion created (balance)", "conversion_id", conv.ID, "uid", user.UID,
		"hold_cents", conv.RunBalance.HoldCents, "pending_reload", plan.ReloadCents > 0)
	s.handleBalanceEffects(ctx, user.UID, fx)
	if conv.State == store.StatePaid {
		s.paidAtStart(ctx, conv)
		if serr := s.submitInline(ctx, conv.ID); serr != nil {
			var rej *submitRejected
			if errors.As(serr, &rej) {
				e := httpx.Err(http.StatusBadRequest, rej.Code, rej.Message)
				e.Details = map[string]any{"conversion_id": conv.ID}
				httpx.WriteErr(ctx, w, e)
				return true
			}
			httpx.Log(ctx).Warn("inline submit failed; reconciler will retry", "conversion_id", conv.ID, "err", serr)
		}
	}
	if fresh, gerr := s.Store.GetConversion(ctx, conv.ID); gerr == nil {
		conv = fresh
	}
	httpx.WriteOK(w, s.conversionResponse(conv, nil))
	return true
}

// balanceBilling is a balance run's billing block (web statuses).
func balanceBilling(c *store.Conversion) map[string]any {
	rb := c.RunBalance
	if rb == nil {
		return nil
	}
	switch rb.State {
	case store.HoldPendingReload:
		return map[string]any{"status": "waiting_for_payment", "paid_from": "balance"}
	case store.HoldHeld:
		return map[string]any{"status": "balance_hold", "held_cents": rb.HoldCents, "paid_from": "balance"}
	case store.HoldSettled:
		return map[string]any{"status": "balance_settled", "charged_cents": rb.SettledCents, "released_cents": rb.ReleasedCents, "paid_from": "balance"}
	case store.HoldReleased:
		if c.PaymentFlow == store.FlowPayNow { // fell back after a failed reload
			return nil
		}
		return map[string]any{"status": "balance_released", "released_cents": rb.ReleasedCents, "paid_from": "balance"}
	}
	return nil
}

// ------------------------------------------------------------- debts

// payDebtsFromBalance is N9: when the account owes and the available
// balance covers it all, collectOutstanding pays from the balance. Never
// under Restore Purchases (withoutSettle): a restore collects nothing.
func (s *Service) payDebtsFromBalance(ctx context.Context, uid string) bool {
	if settleHeld(ctx) {
		return false
	}
	owed := s.owedCents(ctx, uid)
	if owed <= 0 {
		return false
	}
	b, err := s.Store.GetBalance(ctx, uid)
	if err != nil || b.Available() < owed {
		return false
	}
	res, err := s.collectOutstanding(ctx, uid, settleBalance, payContext{})
	if err != nil {
		slog.WarnContext(ctx, "debt not paid from the balance", "uid", uid, "err", err)
		return false
	}
	return res.Paid
}

// paySettleFromBalance: the settle's frozen amount as a debt_payment
// (keyed debt_{settle}, once), then the settle paid. Short → closed.
func (s *Service) paySettleFromBalance(ctx context.Context, st *store.Settle, dropped []string) (settleResult, error) {
	entryID := "debt_" + st.ID
	short := false
	_, fx, err := s.Store.BalanceTx(ctx, st.UID, func(b *store.Balance) ([]store.BalanceOp, error) {
		if b.Available() < st.AmountCents {
			short = true
			return nil, nil
		}
		return []store.BalanceOp{{Kind: store.EntryDebtPayment, Cents: st.AmountCents, Ref: st.ID, EntryID: entryID}}, nil
	})
	if err != nil && !errors.Is(err, store.ErrInsufficientBalance) {
		return settleResult{Settle: st}, err
	}
	if short || errors.Is(err, store.ErrInsufficientBalance) {
		closed, ferr := s.Store.FinishSettle(ctx, st.ID, store.SettleOutcome{}, dropped)
		return settleResult{Settle: closed, Declined: true}, ferr
	}
	s.handleBalanceEffects(ctx, st.UID, fx)
	return s.finishBalanceSettle(ctx, st, dropped)
}

func (s *Service) finishBalanceSettle(ctx context.Context, st *store.Settle, dropped []string) (settleResult, error) {
	done, err := s.Store.FinishSettle(ctx, st.ID, store.SettleOutcome{Paid: true, PaymentIntentID: "balance:" + st.ID,
		PaidCents: st.AmountCents, PaidWith: "balance"}, dropped)
	if err != nil {
		return settleResult{Settle: st}, err
	}
	slog.InfoContext(ctx, "debt paid from the balance", "settle_id", st.ID, "uid", st.UID, "amount_cents", st.AmountCents)
	s.mailDownloadsBack(ctx, "E5_"+st.ID, st.UID, st.AmountCents)
	return settleResult{Settle: done, Paid: true}, nil
}

// ----------------------------------------------------------- sweeps

// balanceSweep (reconciler): R3's hold sweep, reloads whose lease lapsed,
// top-up sessions left open, expiry and its notices.
func (s *Service) balanceSweep(ctx context.Context) map[string]int {
	stats := map[string]int{}
	now := time.Now().UTC()
	// R3: any open hold on a terminal run settles or releases now.
	runs, err := s.Store.ListOpenHoldRuns(ctx, 100)
	if err != nil {
		slog.WarnContext(ctx, "balance sweep: holds list failed", "err", err)
	} else {
		for _, c := range runs {
			switch {
			case store.IsTerminal(c.State):
				if updated, terr := s.Store.Transition(ctx, c.ID, []string{c.State}, func(*store.Conversion) error { return nil }); terr == nil {
					stats["holds_closed"]++
					slog.WarnContext(ctx, "balance hold closed by the sweep", "conversion_id", c.ID, "state", updated.RunBalance.State)
				}
			case c.RunBalance.State == store.HoldPendingReload && c.RunBalance.TopupID != "":
				if t, gerr := s.Store.GetTopup(ctx, c.RunBalance.TopupID); gerr == nil {
					switch t.State {
					case store.TopupPaid:
						s.startPromotedRun(ctx, c.ID)
					case store.TopupFailed, store.TopupCanceled:
						s.fallBackToPayNow(ctx, c.ID)
					}
				}
			}
		}
	}
	if charging, err := s.Store.ListTopupsByState(ctx, store.TopupCharging, 50); err == nil {
		for _, t := range charging {
			if !t.Lease.Held(now) && now.Sub(t.CreatedAt) > 30*time.Second {
				s.runReload(ctx, t.ID)
				stats["reloads_replayed"]++
			}
		}
	}
	if open, err := s.Store.ListTopupsByState(ctx, store.TopupOpen, 50); err == nil {
		for _, t := range open {
			cp := t.CurrentPayment
			if cp == nil {
				if now.Sub(t.CreatedAt) > time.Hour {
					s.Store.UpdateTopup(ctx, t.ID, func(x *store.Topup) error { x.State = store.TopupCanceled; return nil })
				}
				continue
			}
			if cp.ExpiresAt != nil && now.Before(*cp.ExpiresAt) || cp.ExpiresAt == nil && now.Sub(cp.CreatedAt) < time.Hour {
				continue
			}
			out, cerr := s.closePayment(cp)
			if cerr != nil {
				continue
			}
			if out.Paid {
				_ = s.applyTopupPayment(ctx, t.ID, out)
				stats["topups_adopted"]++
				continue
			}
			if !out.Processing {
				s.Store.UpdateTopup(ctx, t.ID, func(x *store.Topup) error { x.State = store.TopupCanceled; return nil })
			}
		}
	}
	if n := s.planCreditSweep(ctx); n > 0 {
		stats["plan_credit_expired"] = n
	}
	if now.Minute()%10 == 0 {
		if n := s.planMonthlySweep(ctx, now); n > 0 {
			stats["plan_months_granted"] = n
		}
		if n := s.proCreditSweep(ctx, now); n > 0 {
			stats["pro_credit_granted"] = n
		}
		if n := s.appProReminderSweep(ctx, now); n > 0 {
			stats["app_pro_reminders"] = n
		}
	}
	// N7: notices at 30 and 7 days, then expiry.
	due, err := s.Store.ListBalancesExpiringBy(ctx, now.Add(30*24*time.Hour), 100)
	if err != nil {
		slog.WarnContext(ctx, "balance sweep: expiry list failed", "err", err)
	} else {
		for _, b := range due {
			if b.ExpiresAt == nil {
				continue
			}
			left := b.ExpiresAt.Sub(now)
			switch {
			case left <= 0:
				if b.HeldCents > 0 {
					continue // open holds settle first
				}
				nb, _, eerr := s.Store.BalanceTx(ctx, b.UID, func(x *store.Balance) ([]store.BalanceOp, error) {
					if x.Expired || x.ExpiresAt == nil || x.ExpiresAt.After(time.Now()) || x.HeldCents > 0 {
						return nil, nil
					}
					return []store.BalanceOp{{Kind: store.EntryExpiry}}, nil
				})
				if eerr == nil && nb != nil && nb.Expired {
					stats["balances_expired"]++
					s.mailBalanceExpired(ctx, b)
				}
			case left <= 7*24*time.Hour:
				s.mailBalanceExpiring(ctx, b, "7")
			default:
				s.mailBalanceExpiring(ctx, b, "30")
			}
		}
	}
	return stats
}

// ---------------------------------------------------------------- mails

func (s *Service) mailTopup(ctx context.Context, t *store.Topup) {
	kind := "Funds added"
	line := money(t.PaidCents) + " was added to your balance."
	if t.Auto {
		kind = "Auto-reload"
		line = "Auto-reload added " + money(t.PaidCents) + " to your balance."
	}
	b, _ := s.Store.GetBalance(ctx, t.UID)
	lines := []string{line}
	if b != nil {
		lines = append(lines, "Your balance is now "+money(b.Available())+".")
	}
	lines = append(lines, "Your invoice will be in Billing shortly.")
	s.mailCustomer(ctx, "E13_"+t.ID, t.UID, s.accountEmail(ctx, t.UID), customerMail{
		Kind: "E13", Subject: "Spatial Video Studio: " + kind + " · " + money(t.PaidCents), Lines: lines,
		Button: "View billing", Link: s.Cfg.SiteURL + "/billing", Receipt: true,
	})
}

func (s *Service) mailLowBalance(ctx context.Context, uid string, available int64) {
	s.mailCustomer(ctx, fmt.Sprintf("E14_%s_%d", uid, time.Now().Unix()/3600), uid, s.accountEmail(ctx, uid), customerMail{
		Kind: "E14", Subject: "Spatial Video Studio: your balance is low",
		Lines:  []string{"Your balance is " + money(available) + ".", "Add funds to keep making 3D videos from your balance."},
		Button: "Add funds", Link: s.Cfg.SiteURL + "/billing?add=1",
	})
}

func (s *Service) mailReloadFailed(ctx context.Context, t *store.Topup) {
	s.mailCustomer(ctx, "E15_"+t.ID, t.UID, s.accountEmail(ctx, t.UID), customerMail{
		Kind: "E15", Subject: "Spatial Video Studio: auto-reload didn't go through",
		Lines:  []string{"We couldn't add " + money(t.Cents) + " to your balance.", "Auto-reload is paused until you turn it back on."},
		Button: "Check billing", Link: s.Cfg.SiteURL + "/billing",
	})
}

func (s *Service) mailBalanceExpiring(ctx context.Context, b *store.Balance, days string) {
	if b.ExpiresAt == nil {
		return
	}
	key := "E16_" + days + "_" + b.ExpiresAt.Format("20060102")
	if ok, err := s.Store.MarkExpiryNotice(ctx, b.UID, key); err != nil || !ok {
		return
	}
	s.mailCustomer(ctx, b.UID+"_"+key, b.UID, s.accountEmail(ctx, b.UID), customerMail{
		Kind: "E16", Subject: "Spatial Video Studio: your balance expires in " + days + " days",
		Lines: []string{"Your balance of " + money(max(b.Available(), 0)) + " expires on " + b.ExpiresAt.Format("2 January 2006") + ".",
			"Any top-up keeps the whole balance for another 12 months."},
		Button: "Add funds", Link: s.Cfg.SiteURL + "/billing?add=1",
	})
}

func (s *Service) mailBalanceExpired(ctx context.Context, b *store.Balance) {
	key := "E17_" + b.UID
	if b.ExpiresAt != nil {
		key += "_" + b.ExpiresAt.Format("20060102")
	}
	s.mailCustomer(ctx, key, b.UID, s.accountEmail(ctx, b.UID), customerMail{
		Kind: "E17", Subject: "Spatial Video Studio: your balance expired",
		Lines:  []string{"Your balance expired 12 months after your last top-up.", "Questions? Reply to this email."},
		Button: "Open billing", Link: s.Cfg.SiteURL + "/billing",
	})
}

// ------------------------------------------------------------- ledger API

// GET /v1/billing/balance/entries?limit=25&starting_after={id} →
// {entries: [{id, kind, cents, at, detail?}], has_more}: the "Balance
// history" disclosure. Signed cents; run holds, settles and releases are
// in Usage instead; an auto-reload top-up reads kind auto_reload.
func (s *Service) HandleBalanceEntries(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	limit := 25
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 {
		limit = min(v, 100)
	}
	after := r.URL.Query().Get("starting_after")
	rows := []map[string]any{}
	more := false
	for len(rows) < limit {
		page, m, err := s.Store.ListEntries(ctx, user.UID, limit, after)
		if err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
		for _, e := range page {
			after = e.ID
			row := ledgerRow(e)
			if row == nil {
				continue
			}
			if len(rows) == limit {
				more = true
				break
			}
			rows = append(rows, row)
		}
		if !m || more {
			more = more || m
			break
		}
	}
	httpx.WriteOK(w, map[string]any{"entries": rows, "has_more": more})
}

func ledgerRow(e store.Entry) map[string]any {
	kind, cents, detail := e.Kind, e.Delta, ""
	switch e.Kind {
	case store.EntryHold, store.EntrySettle, store.EntryRelease:
		return nil
	case store.EntryTopup:
		if e.Auto {
			kind = "auto_reload"
		}
	case store.EntryAdjustment:
		if e.Delta == 0 {
			return nil // a settings change
		}
		detail = e.Note
	case store.EntryDisputeFreeze, store.EntryPlanCreditFreeze:
		cents = -e.Cents
		detail = e.Note
	case store.EntryDisputeUnfreeze, store.EntryPlanCreditUnfreeze:
		cents = e.Cents
		detail = e.Note
	case store.EntryPlanCreditRemoval:
		detail = e.Note
	}
	if cents == 0 && (e.Kind == store.EntryPlanCreditFreeze || e.Kind == store.EntryPlanCreditUnfreeze || e.Kind == store.EntryPlanCreditRemoval) {
		return nil // nothing moved
	}
	if e.CaseID != "" {
		detail = e.CaseID
	}
	row := map[string]any{"id": e.ID, "kind": kind, "cents": cents, "at": e.At.Format(time.RFC3339)}
	if detail != "" {
		row["detail"] = detail
	}
	return row
}

// GET /v1/billing/usage?month=YYYY-MM&limit=50&starting_after={conversion_id}
// [&format=csv] → {rows: [{at, project, project_id, conversion_id, method,
// preset, minutes, cost_cents, paid_with, status, reserved_cents?,
// returned_cents?}], has_more}. Web runs of the month, newest first; the
// CSV holds the whole month.
func (s *Service) HandleUsage(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	q := r.URL.Query()
	now := time.Now().UTC()
	month := q.Get("month")
	if month == "" {
		month = now.Format("2006-01")
	}
	start, err := time.Parse("2006-01", month)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("month must be YYYY-MM"))
		return
	}
	end := start.AddDate(0, 1, 0)
	limit := 50
	if v, err := strconv.Atoi(q.Get("limit")); err == nil && v > 0 {
		limit = min(v, 200)
	}
	convs, err := s.Store.ListUserConversions(ctx, user.UID, 1000)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	names := map[string]string{}
	var rows []map[string]any
	for _, c := range convs {
		if c.ProjectID == "" || c.Sample || c.CreatedAt.Before(start) || !c.CreatedAt.Before(end) {
			continue
		}
		row := s.usageRow(ctx, c, names)
		if row != nil {
			rows = append(rows, row)
		}
	}
	if q.Get("format") == "csv" {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="spatial-video-studio-usage-%s.csv"`, month))
		cw := csv.NewWriter(w)
		_ = cw.Write([]string{"date", "project", "conversion_id", "method", "preset", "minutes", "cost_usd", "paid_with", "status"})
		for _, row := range rows {
			cost := ""
			if c, ok := row["cost_cents"].(int64); ok {
				cost = fmt.Sprintf("%.2f", float64(c)/100)
			}
			_ = cw.Write([]string{row["at"].(string), fmt.Sprint(row["project"]), row["conversion_id"].(string), row["method"].(string),
				fmt.Sprint(row["preset"]), fmt.Sprintf("%.2f", row["minutes"]), cost, row["paid_with"].(string), row["status"].(string)})
		}
		cw.Flush()
		return
	}
	after := q.Get("starting_after")
	startIdx := 0
	if after != "" {
		startIdx = len(rows)
		for i, row := range rows {
			if row["conversion_id"] == after {
				startIdx = i + 1
				break
			}
		}
	}
	endIdx := min(startIdx+limit, len(rows))
	page := rows[startIdx:endIdx]
	if page == nil {
		page = []map[string]any{}
	}
	httpx.WriteOK(w, map[string]any{"rows": page, "has_more": endIdx < len(rows), "month": month})
}

// usageRow is one run for Usage (P10): cost_cents null while it runs.
func (s *Service) usageRow(ctx context.Context, c *store.Conversion, names map[string]string) map[string]any {
	name, ok := names[c.ProjectID]
	if !ok {
		if p, err := s.Store.GetProject(ctx, c.ProjectID); err == nil && !p.Deleted {
			name = p.Name
		}
		names[c.ProjectID] = name
	}
	minutes := 0.0
	if c.Source.FPS > 0 && c.Params.ToFrame > c.Params.FromFrame {
		minutes = float64(c.Params.ToFrame-c.Params.FromFrame) / c.Source.FPS / 60
	} else if c.Source.DurationS > 0 {
		minutes = c.Source.DurationS / 60
	}
	row := map[string]any{"at": c.CreatedAt.Format(time.RFC3339), "project": name, "project_id": c.ProjectID,
		"conversion_id": c.ID, "method": store.MethodOr(c.Method), "preset": c.Params.Preset, "step": c.Step,
		"minutes": math.Round(minutes*100) / 100, "cost_cents": nil, "paid_with": "card", "status": "running"}
	if c.FreePreview != nil {
		row["paid_with"], row["cost_cents"], row["status"] = "free_preview", int64(0), "done"
		if store.IsTerminal(c.State) && c.State != store.StateSucceeded {
			row["status"] = "released"
		} else if !store.IsTerminal(c.State) {
			row["status"], row["cost_cents"] = "running", nil
		}
		return row
	}
	if rb := c.RunBalance; rb != nil && rb.Partial {
		// credit and balance first, the card's rest: the card's row status
		// below, with the covered part beside it
		row["paid_with"], row["balance_cents"], row["card_cents"] = "balance_and_card", rb.HoldCents, runCardCents(c)
	} else if rb != nil {
		row["paid_with"] = "balance"
		switch rb.State {
		case store.HoldHeld, store.HoldPendingReload:
			row["reserved_cents"] = rb.HoldCents
		case store.HoldSettled:
			row["cost_cents"], row["status"] = rb.SettledCents, "done"
			if rb.ReleasedCents > 0 {
				row["returned_cents"] = rb.ReleasedCents
			}
		case store.HoldReleased:
			if c.PaymentFlow == store.FlowPayNow {
				row["paid_with"] = "card"
				break
			}
			row["cost_cents"], row["status"], row["returned_cents"] = int64(0), "released", rb.ReleasedCents
		}
		if store.IsTerminal(c.State) && row["status"] == "running" {
			row["status"] = "released"
		}
		return row
	}
	switch {
	case c.State == store.StateCreated:
		return nil // not paid yet
	case c.Stripe.PIStatus == store.PIRefunded:
		row["cost_cents"], row["status"] = max(c.Stripe.CapturedCents-c.Stripe.RefundedCents, 0), "returned"
		row["returned_cents"] = c.Stripe.RefundedCents
	case c.State == store.StateFailed || c.State == store.StateCanceled || c.State == store.StateExpired:
		row["cost_cents"], row["status"] = int64(0), "released"
	case c.State == store.StateSucceeded:
		cost := c.Stripe.CapturedCents
		if cost == 0 {
			cost = c.Quote.AmountCents
		}
		row["cost_cents"], row["status"] = cost, "done"
	default:
		row["reserved_cents"] = c.Quote.AmountCents
	}
	if c.PaymentFlow == store.FlowChina {
		row["paid_with"] = "alipay"
	}
	return row
}
