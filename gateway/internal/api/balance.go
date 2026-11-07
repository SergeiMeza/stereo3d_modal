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
	"net/url"
	"strconv"
	"strings"
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
	ar["retry"] = s.reloadRetryJSON(ctx, uid) // D2: a failed reload's retry and pay link, null when none
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
// The payment returns to return_url (on the site; default /billing) with
// topup={topup_id} set (topupReturnURL).
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
	t := &store.Topup{ID: "t" + store.NewID(), UID: user.UID, Cents: req.AmountCents, Currency: "usd", State: store.TopupOpen, CustomerID: customerID,
		BonusCents: s.rates(ctx).TopupBonusFor(req.AmountCents)} // BUX-23: what it adds when paid, fixed now
	if err := s.Store.CreateTopup(ctx, t); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	returnURL := s.topupReturnURL(req.ReturnURL, t.ID)
	if (req.Method != "" || chinaMode(r)) && s.chinaPaymentsOff(ctx) {
		httpx.WriteErr(ctx, w, errChinaPaymentsUnavailable())
		return
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
		httpx.WriteOK(w, map[string]any{"topup_id": t.ID, "amount_cents": t.Cents, "bonus_cents": t.BonusCents, "redirect_url": redirect,
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
		Metadata:        map[string]string{"kind": "topup", "topup_id": t.ID, "user_id": user.UID, "payment_flow": "topup", "attempt": "1"},
		IdemKey:         fmt.Sprintf("topup_%s_%s_1", s.Cfg.Env, t.ID),
		AdaptivePricing: s.rates(ctx).AdaptivePricingEnabled,
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
	resp := map[string]any{"topup_id": t.ID, "amount_cents": t.Cents, "bonus_cents": t.BonusCents, "publishable_key": s.Stripe.PublishableKey,
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
	if tp, gerr := s.Store.GetTopup(ctx, topupID); gerr == nil && tp.PayRequestID != "" && tp.State != store.TopupPaid {
		// REV-07: a pay link's debt is paid once; another payment of it
		// (a second session, or after the reload's retry paid) goes back
		ok, cerr := s.claimTopupDebt(ctx, tp.PayRequestID, topupID)
		if cerr != nil {
			return cerr
		}
		if !ok {
			s.refundLatePayment(ctx, &store.Conversion{ID: "topup:" + topupID, UID: tp.UID}, out.PaymentIntentID, out.AmountReceived,
				"a second payment for the same pay link")
			s.Store.UpdateTopup(ctx, topupID, func(x *store.Topup) error {
				if x.State == store.TopupOpen {
					x.State = store.TopupCanceled
				}
				return nil
			})
			return nil
		}
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
	s.notePresentmentQuiet(ctx, store.PresentTopup, topupID, out)
	if t.Presentment == nil && t.PaymentIntentID == out.PaymentIntentID {
		t.Presentment = presentmentOf(out.Presentment) // for the receipt mail below
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
	s.payRequestsAfterTopup(ctx, t)                    // D7: its pay link, a failed reload's links
	s.cancelReloadRetries(ctx, t.UID, "a top-up paid") // D2: nothing more to retry
	if t.PaidWith != "" {
		if cust, err := s.Store.GetCustomer(ctx, t.UID); err == nil && cust.DefaultPaymentMethod == t.PaidWith {
			s.noteMethodPaid(ctx, t.UID, t.PaidWith) // T24
		}
	}
	paidAt := time.Now().UTC()
	if t.PaidAt != nil {
		paidAt = *t.PaidAt
	}
	s.addTopupBonus(ctx, t) // BUX-23
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

// addTopupBonus credits a paid top-up's bonus (BUX-23) once: usage-only
// credit, never on an auto-reload or a pay link's top-up, scaled down if
// less was paid than asked.
func (s *Service) addTopupBonus(ctx context.Context, t *store.Topup) {
	if t.BonusCents <= 0 || t.Auto || t.PayRequestID != "" {
		return
	}
	bonus := t.BonusCents
	if t.PaidCents > 0 && t.PaidCents < t.Cents {
		bonus = t.BonusCents * t.PaidCents / t.Cents
	}
	if bonus <= 0 {
		return
	}
	if _, _, err := s.Store.BalanceTx(ctx, t.UID, func(*store.Balance) ([]store.BalanceOp, error) {
		return []store.BalanceOp{{Kind: store.EntryTopupBonus, Cents: bonus, TopupID: t.ID, EntryID: "bonus_" + t.ID,
			Note: "Top-up bonus"}}, nil
	}); err != nil {
		slog.WarnContext(ctx, "top-up bonus not added", "topup_id", t.ID, "err", err)
		s.Slack.Alert(ctx, "topup_bonus_failed", fmt.Sprintf("top-up %s's bonus (%s) for `%s` wasn't added: %v", t.ID, money(bonus), t.UID, err))
	}
}

// clawBackTopupBonus removes what is left of a top-up's bonus (a dispute
// of the top-up: all of it, upTo 0; a cash refund: its share) and answers
// how much went.
func (s *Service) clawBackTopupBonus(ctx context.Context, uid, topupID, entryID string, upTo int64, why string) int64 {
	if topupID == "" {
		return 0
	}
	left := func(b *store.Balance) int64 {
		var n int64
		for _, it := range b.Fifo {
			if it.PlanCredit && it.Ref == "bonus:"+topupID {
				n += it.RemainingCents
			}
		}
		return n
	}
	var before int64
	after, _, err := s.Store.BalanceTx(ctx, uid, func(b *store.Balance) ([]store.BalanceOp, error) {
		before = left(b)
		if before == 0 {
			return nil, nil
		}
		return []store.BalanceOp{{Kind: store.EntryPlanCreditRemoval, Ref: "bonus:" + topupID, MatchRef: true, UpTo: upTo,
			EntryID: entryID, Note: "Top-up bonus removed (" + why + ")"}}, nil
	})
	if err != nil {
		slog.WarnContext(ctx, "top-up bonus not removed", "topup_id", topupID, "err", err)
		return 0
	}
	if after == nil {
		return 0
	}
	return max(before-left(after), 0)
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
// sheet_only (the reload is abandoned with a pause). A card's refusal
// fails it (auto-reload paused, no credit) and starts its retry schedule
// and pay link (D2, D7).
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
	fail := func(reason, msg string, f *stripex.ChargeFailure) {
		_, released, ferr := s.Store.FailTopup(ctx, topupID, reason, msg)
		if ferr != nil {
			slog.WarnContext(ctx, "reload failure not recorded", "topup_id", topupID, "err", ferr)
			return
		}
		for _, id := range released {
			s.fallBackToPayNow(ctx, id)
		}
		if f != nil {
			s.startReloadRetry(ctx, t, *f)
		}
	}
	cust, err := s.Store.GetCustomer(ctx, t.UID)
	if err != nil {
		fail("", "no account", nil)
		return
	}
	switch {
	case cust.UnderReview:
		fail("review", "under review", nil)
		return
	case cust.SheetOnly:
		fail("sheet_only", "sheet only", nil)
		return
	case s.owedCents(ctx, t.UID) > 0:
		fail("", "a debt exists", nil) // R1: never while a pay-as-you-go debt exists
		return
	}
	if cust.DefaultPaymentMethod == "" {
		cust = s.refreshCardCache(ctx, t.UID, cust.StripeCustomerID)
	}
	if cust.DefaultPaymentMethod == "" {
		fail("declined", "no saved method", &stripex.ChargeFailure{Code: "no_payment_method"})
		return
	}
	o := s.chargeReload(ctx, t, cust, 1)
	switch {
	case o.transient:
		return // the lease lapses; the sweep replays the keys
	case o.closedPaid != nil:
		_ = s.applyTopupPayment(ctx, topupID, *o.closedPaid)
		return
	case !o.paid:
		reason := "declined" // a bank check off-session counts as declined (N4)
		switch {
		case o.fail.Stop:
			reason = "stop_code"
			s.setSheetOnly(ctx, t.UID, "stop code "+o.fail.DeclineCode)
		case !o.cardDecision:
			reason = "config" // B2: paused, no "didn't go through" mail; the owner was alerted
		}
		fail(reason, "reload declined: "+o.fail.Code, &o.fail)
		return
	}
	s.reloadPaid(ctx, topupID, o)
}

// reloadOutcome is one auto-reload charge attempt.
type reloadOutcome struct {
	paid, transient, cardDecision bool
	pi                            *stripe.PaymentIntent
	paidWith                      string
	fail                          stripex.ChargeFailure
	closedPaid                    *stripex.Outcome // the final cancel found it paid after all
}

// chargeReload charges t once: the default, then the backups. Try n > 1
// (a retry, D2) has its own keys: topup_{env}_{id}_r{n}[_{pm}].
func (s *Service) chargeReload(ctx context.Context, t *store.Topup, cust *store.Customer, attempt int) reloadOutcome {
	job := stripex.Job{UID: t.UID, Description: "Spatial Video Studio balance auto-reload", PMC: s.Cfg.StripePMCWeb}
	suffix := ""
	if attempt > 1 {
		suffix = fmt.Sprintf("_r%d", attempt)
	}
	var pi *stripe.PaymentIntent
	var chErr error
	if attempt > 1 {
		pi, chErr = s.Stripe.ChargeTopupWith(cust.StripeCustomerID, cust.DefaultPaymentMethod, t.Cents, t.ID, suffix, job)
	} else {
		pi, chErr = s.Stripe.ChargeTopup(cust.StripeCustomerID, cust.DefaultPaymentMethod, t.Cents, t.ID, job)
	}
	o := reloadOutcome{pi: pi, paidWith: cust.DefaultPaymentMethod, cardDecision: true}
	var f stripex.ChargeFailure
	switch {
	case chErr != nil:
		f = stripex.ClassifyChargeError(chErr)
	case pi.Status == stripe.PaymentIntentStatusSucceeded || pi.Status == stripe.PaymentIntentStatusProcessing:
		o.paid = true
		return o
	default:
		f = stripex.ChargeFailure{PaymentIntentID: pi.ID, Code: string(pi.Status), NeedsAction: true}
	}
	if f.Transient {
		o.transient = true
		return o
	}
	if f.Config {
		s.alertConfigError(ctx, "auto-reload", t.ID, t.UID, f)
	}
	r := s.webBackups(ctx, cust, f, func(pm string) (*stripe.PaymentIntent, error) {
		return s.Stripe.ChargeTopupWith(cust.StripeCustomerID, pm, t.Cents, t.ID, suffix+"_"+pm, job)
	})
	o.transient, o.cardDecision, o.fail = r.Transient, r.CardDecision, r.Fail
	if r.Transient {
		return o
	}
	if r.Paid {
		o.paid, o.pi, o.paidWith = true, r.PI, r.PaidWith
		return o
	}
	if r.PIID != "" {
		out, cerr := s.Stripe.ClosePaymentIntent(r.PIID)
		if cerr != nil {
			o.transient = true
			return o
		}
		if out.Paid {
			o.closedPaid = &out
		}
	}
	return o
}

// reloadPaid credits a reload whose charge went through (a processing one
// waits for its succeeded webhook).
func (s *Service) reloadPaid(ctx context.Context, topupID string, o reloadOutcome) {
	s.Store.UpdateTopup(ctx, topupID, func(x *store.Topup) error { x.PaymentIntentID = o.pi.ID; return nil })
	if o.pi.Status == stripe.PaymentIntentStatusProcessing {
		return // the succeeded webhook credits it
	}
	_ = s.applyTopupPayment(ctx, topupID, stripex.Outcome{PaymentIntentID: o.pi.ID, AmountReceived: o.pi.AmountReceived, PaymentMethod: o.paidWith, Paid: true})
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
				if t.Retry == nil {
					s.startReloadRetry(ctx, t, stripex.ChargeFailure{Code: "payment_failed"})
				}
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
		if err := s.applyTopupPayment(ctx, topupID, out); err != nil {
			return err
		}
		return s.notePresentment(ctx, store.PresentTopup, topupID, out) // an error → 5xx → Stripe retries
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
	if ar != nil && (!ar.Enabled || turningOn) {
		// D2: turned back on (normal reloads resume) or off — a pending
		// retry would charge on top
		s.cancelReloadRetries(ctx, user.UID, "auto-reload turned "+map[bool]string{true: "on", false: "off"}[ar.Enabled])
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
	if n := s.stepUpApplySweep(ctx, now); n > 0 { // REV-01: paid step-ups left applying
		stats["stepups_applied"] = n
	}
	if n := s.rcAttrRetrySweep(ctx, now); n > 0 { // D14: failed web plan markers
		stats["rc_attr_retries"] = n
	}
	if n := s.reloadRetrySweep(ctx, now); n > 0 { // D2: failed reloads due again
		stats["reload_retries"] = n
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
	added := money(t.PaidCents)
	if !t.Auto {
		added = amountText(t.Presentment, t.PaidCents) // an off-session reload is never presented locally
	}
	now := ""
	if b, _ := s.Store.GetBalance(ctx, t.UID); b != nil {
		now = money(b.Available())
	}
	s.mailCustomer(ctx, "E13_"+t.ID, t.UID, s.accountEmail(ctx, t.UID), topupMail(t.Auto, added, now, s.Cfg.SiteURL+"/billing"))
}

func (s *Service) mailLowBalance(ctx context.Context, uid string, available int64) {
	s.mailCustomer(ctx, fmt.Sprintf("E14_%s_%d", uid, time.Now().Unix()/3600), uid, s.accountEmail(ctx, uid),
		lowBalanceMail(money(available), s.Cfg.SiteURL+"/billing?add=1"))
}

func (s *Service) mailBalanceExpiring(ctx context.Context, b *store.Balance, days string) {
	if b.ExpiresAt == nil {
		return
	}
	key := "E16_" + days + "_" + b.ExpiresAt.Format("20060102")
	if ok, err := s.Store.MarkExpiryNotice(ctx, b.UID, key); err != nil || !ok {
		return
	}
	s.mailCustomer(ctx, b.UID+"_"+key, b.UID, s.accountEmail(ctx, b.UID),
		balanceExpiringMail(days, money(max(b.Available(), 0)), *b.ExpiresAt, s.Cfg.SiteURL+"/billing?add=1"))
}

func (s *Service) mailBalanceExpired(ctx context.Context, b *store.Balance) {
	key := "E17_" + b.UID
	if b.ExpiresAt != nil {
		key += "_" + b.ExpiresAt.Format("20060102")
	}
	s.mailCustomer(ctx, key, b.UID, s.accountEmail(ctx, b.UID), balanceExpiredMail(s.Cfg.SiteURL+"/billing"))
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
		if strings.HasPrefix(e.Ref, "bonus:") {
			kind = "topup_bonus_removed" // BUX-23: a disputed or refunded top-up's bonus
		}
	case store.EntryTopupBonus:
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
	if (e.Kind == store.EntryTopup || e.Kind == store.EntryTopupBonus) && e.TopupID != "" {
		row["topup_id"] = e.TopupID // REV-14: the return page matches its own top-up; BUX-23: the bonus its top-up's
	}
	return row
}

// topupReturnURL (REV-14): where a top-up's payment returns, naming the
// top-up. The default is SiteURL/billing?topup={id}; a client's
// return_url (on the site) gets {TOPUP_ID} replaced and its topup query
// parameter set to the id (any value it had, such as topup=1, replaced).
func (s *Service) topupReturnURL(client, topupID string) string {
	def := s.Cfg.SiteURL + "/billing?topup=" + url.QueryEscape(topupID)
	if client == "" || !strings.HasPrefix(client, s.Cfg.SiteURL+"/") {
		return def
	}
	client = strings.NewReplacer("{TOPUP_ID}", topupID, "%7BTOPUP_ID%7D", topupID, "%7btopup_id%7d", topupID).Replace(client)
	u, err := url.Parse(client)
	if err != nil {
		return def
	}
	q := u.Query()
	q.Set("topup", topupID)
	u.RawQuery = q.Encode()
	return u.String()
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
