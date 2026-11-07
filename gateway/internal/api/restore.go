package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// POST /v1/billing/restore — Restore Purchases (owner 2026-11-06, Apple
// style): resync the signed-in account's web purchases and repair what a
// missed webhook or a failed grant left behind. Nothing moves between
// accounts, so it needs no fresh sign-in, and nothing is ever charged:
// the whole run is under withoutSettle (no collectOutstanding, no debt
// paid from the balance).
//
//  1. Stripe: the account's customer and any other customer made for its
//     uid (search on metadata firebase_uid). Each of our subscriptions on
//     them that can still bill (or is the account's plan) is mirrored
//     again (syncPlan: missed customer.subscription.* events).
//  2. The current plan's latest paid invoice of this period, when the
//     account has no record of it, goes through the invoice.paid path
//     (its credit and the app's entitlements, once per invoice).
//  3. RevenueCat: M3's plan check for this account (a yearly plan's
//     missed month, the app's entitlement missing), promotional records a
//     failure left behind taken up again, then a fresh read.
//
// → {restored, repaired: [plan | monthly_usage | app_access], plan, pro,
// message}: "Your purchases are restored" when the account holds an
// active web plan or Pro, else "We didn't find any purchases". 403
// account_deleted / deletion_pending; 429 rate_limited {retry_after_s}
// (5 an hour per account, 20 an hour per address); 502
// restore_unavailable when Stripe or RevenueCat couldn't be read and
// nothing was found. One audit row in restores_{env} per run.

const (
	restorePerAccountHour = 5
	restorePerIPHour      = 20
	// A renewal's invoice is made at its period's start; one made a little
	// before it still counts as this period's.
	restoreInvoiceSlack = 2 * time.Hour
)

// Restore's two answers.
const (
	restoreMsgRestored = "Your purchases are restored"
	restoreMsgNone     = "We didn't find any purchases"
)

// What a restore repaired, in the answer's words.
const (
	repairedPlan     = "plan"          // the plan's record (status, period, the payment)
	repairedCredit   = "monthly_usage" // the plan's monthly usage
	repairedAppGrant = "app_access"    // the app's Pro, Business or Studio
)

type settleHeldKey struct{}

// withoutSettle marks ctx: nothing under it collects money
// (payDebtsFromBalance and collectOutstanding refuse).
func withoutSettle(ctx context.Context) context.Context {
	return context.WithValue(ctx, settleHeldKey{}, true)
}

func settleHeld(ctx context.Context) bool {
	held, _ := ctx.Value(settleHeldKey{}).(bool)
	return held
}

var errSettleHeld = errors.New("nothing is collected during a restore")

// restoreRun is one restore's findings.
type restoreRun struct {
	rec      store.Restore
	readFail bool // Stripe or RevenueCat couldn't be read for the account
}

func (r *restoreRun) repaired(what string) {
	if !slices.Contains(r.rec.Repaired, what) {
		r.rec.Repaired = append(r.rec.Repaired, what)
	}
}

func (r *restoreRun) fail(what string, err error) {
	if len(r.rec.Errors) < 20 {
		r.rec.Errors = append(r.rec.Errors, what+": "+err.Error())
	}
}

func hashIP(ip string) string {
	if ip == "" {
		return ""
	}
	sum := sha256.Sum256([]byte("restore:" + ip))
	return hex.EncodeToString(sum[:8])
}

// HandleRestore is POST /v1/billing/restore.
func (s *Service) HandleRestore(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	now := time.Now().UTC()
	cust, err := s.Store.GetCustomer(ctx, user.UID)
	if errors.Is(err, store.ErrNotFound) {
		cust, err = nil, nil
	}
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if cust != nil && cust.AccountDeleted {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusForbidden, "account_deleted", "This account was deleted."))
		return
	}
	if cust != nil && cust.DeletionPending {
		httpx.WriteErr(ctx, w, errDeletionPending())
		return
	}
	ip := clientIP(r)
	if ip != "" && !eventAllowed("restore-ip:"+ip, restorePerIPHour, now) {
		writeRestoreLimited(ctx, w, time.Hour)
		return
	}
	ok, wait, err := s.Store.AllowRestore(ctx, user.UID, restorePerAccountHour, time.Hour, now)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if !ok {
		writeRestoreLimited(ctx, w, wait)
		return
	}

	run := &restoreRun{rec: store.Restore{UID: user.UID, Kind: "resync", At: now, Repaired: []string{}, IPHash: hashIP(ip)}}
	rctx := withoutSettle(ctx)
	s.restoreStripe(rctx, user.UID, cust, run)
	pro := s.restoreRevenueCat(rctx, user.UID, run)

	after, _ := s.Store.GetCustomer(ctx, user.UID)
	planActive := after != nil && after.Plan != nil && after.Plan.Active(time.Now())
	run.rec.Restored = planActive || pro
	if err := s.Store.AddRestore(ctx, &run.rec); err != nil {
		slog.WarnContext(ctx, "restore audit row not written", "err", err)
	}
	slog.InfoContext(ctx, "restore purchases", "restored", run.rec.Restored, "repaired", run.rec.Repaired,
		"other_customers", run.rec.OtherCustomers, "errors", len(run.rec.Errors))
	if !run.rec.Restored && run.readFail {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "restore_unavailable",
			"We couldn't check your purchases right now. Try again in a while."))
		return
	}
	msg := restoreMsgNone
	if run.rec.Restored {
		msg = restoreMsgRestored
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, map[string]any{"restored": run.rec.Restored, "repaired": run.rec.Repaired,
		"plan": s.planJSON(ctx, user.UID), "pro": pro, "message": msg})
}

func writeRestoreLimited(ctx context.Context, w http.ResponseWriter, wait time.Duration) {
	e := httpx.Err(http.StatusTooManyRequests, "rate_limited", "Too many tries. Try again in a while.")
	e.Details = map[string]any{"retry_after_s": max(1, int(wait.Seconds()))}
	httpx.WriteErr(ctx, w, e)
}

// planMirror is what syncPlan writes, to tell a repair from a no-op.
func planMirror(c *store.Customer) string {
	if c == nil || c.Plan == nil {
		return ""
	}
	p := c.Plan
	end := ""
	if p.CurrentPeriodEnd != nil {
		end = p.CurrentPeriodEnd.UTC().Format(time.RFC3339)
	}
	cancel := "renews"
	if p.CancelAtPeriodEnd {
		cancel = "ends"
	}
	return p.Tier + "|" + p.PlanID + "|" + p.SubscriptionID + "|" + p.Status + "|" + end + "|" + cancel + "|" + p.LastInvoiceID
}

// restoreStripe is steps 1 and 2.
func (s *Service) restoreStripe(ctx context.Context, uid string, cust *store.Customer, run *restoreRun) {
	if s.Stripe == nil {
		return
	}
	before := planMirror(cust)
	var customers []string
	if cust != nil && cust.StripeCustomerID != "" {
		customers = append(customers, cust.StripeCustomerID)
	}
	if found, err := s.Stripe.CustomersOfUID(uid); err != nil {
		run.fail("customer search", err) // the account's own customer is still read
	} else {
		for _, id := range found {
			if !slices.Contains(customers, id) {
				customers = append(customers, id)
				run.rec.OtherCustomers++
			}
		}
	}
	run.rec.Customers = len(customers)
	if run.rec.OtherCustomers > 0 {
		s.Slack.Alert(ctx, "restore_other_customer", "Restore Purchases found another Stripe customer for one account; see restores_"+s.Cfg.Env)
	}
	var live []stripex.Subscription
	for _, id := range customers {
		subs, err := s.Stripe.CustomerSubscriptions(id)
		if err != nil {
			run.fail("subscriptions", err)
			if cust != nil && id == cust.StripeCustomerID {
				run.readFail = true
			}
			continue
		}
		for _, sub := range subs {
			if sub.Metadata["product"] != "svs-web" || sub.Metadata["env"] != s.Cfg.Env || sub.Metadata["user_id"] != uid {
				continue
			}
			mine := cust != nil && cust.Plan != nil && cust.Plan.SubscriptionID == sub.ID
			if !sub.Live() && !mine {
				continue // an ended one that isn't the plan on record: nothing to mirror
			}
			run.rec.Subscriptions++
			fresh := sub
			if got, err := s.Stripe.GetSubscription(sub.ID); err == nil {
				fresh = *got // the list can lag; the subscription itself is current
			}
			s.syncPlan(ctx, &fresh)
			if fresh.Live() {
				live = append(live, fresh)
			}
		}
	}
	for i := range live {
		s.restoreInvoice(ctx, uid, &live[i], run)
	}
	after, _ := s.Store.GetCustomer(ctx, uid)
	if planMirror(after) != before && after != nil && after.Plan != nil {
		run.repaired(repairedPlan)
	}
}

// restoreInvoice is step 2 for one subscription: its latest paid invoice
// of this period goes through the invoice.paid path when the plan has no
// record of it (that path grants once per invoice).
func (s *Service) restoreInvoice(ctx context.Context, uid string, sub *stripex.Subscription, run *restoreRun) {
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || cust.Plan == nil || cust.Plan.SubscriptionID != sub.ID {
		return // not the account's plan (an older or incomplete subscription)
	}
	invs, err := s.Stripe.PaidSubscriptionInvoices(sub.ID, 3)
	if err != nil {
		run.fail("invoices", err)
		return
	}
	if len(invs) == 0 {
		return
	}
	inv := invs[0]
	start, _ := sub.Period()
	if time.Unix(inv.Created, 0).Before(start.Add(-restoreInvoiceSlack)) {
		return // an earlier period's: its credit has run out
	}
	if cust.Plan.LastInvoiceID == inv.ID {
		return // on record
	}
	creditEntry := "plancredit_" + inv.ID
	if cust.Plan.Yearly() {
		if k, _, _, ok := cust.Plan.Month(time.Now()); ok {
			creditEntry = planMonthEntry(sub.ID, k)
		}
	}
	hadCredit, _ := s.Store.EntryExists(ctx, uid, creditEntry)
	grantedBefore := cust.Plan.RCGrantInvoice
	s.handlePlanInvoicePaid(ctx, inv.Raw)
	run.rec.Invoices = append(run.rec.Invoices, inv.ID)
	after, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || after.Plan == nil || after.Plan.LastInvoiceID != inv.ID {
		run.fail("invoice "+inv.ID, errors.New("not applied"))
		return
	}
	run.repaired(repairedPlan)
	if has, _ := s.Store.EntryExists(ctx, uid, creditEntry); has && !hadCredit {
		run.repaired(repairedCredit)
	}
	if after.Plan.RCGrantInvoice == inv.ID && grantedBefore != inv.ID {
		run.repaired(repairedAppGrant)
	}
}

// restoreRevenueCat is step 3; it answers whether the account holds Pro
// (or a plan's entitlement) in RevenueCat now.
func (s *Service) restoreRevenueCat(ctx context.Context, uid string, run *restoreRun) bool {
	now := time.Now().UTC()
	if cust, err := s.Store.GetCustomer(ctx, uid); err == nil && cust.Plan != nil {
		rep := &M3Report{Counts: map[string]int{}}
		s.m3PlanOne(ctx, rep, uid, cust, now, false)
		for _, f := range rep.Flags {
			switch {
			case f.Flag == "plan_credit_missed" && f.Action == "granted":
				run.repaired(repairedCredit)
			case f.Flag == "plan_entitlement_missing" && strings.HasPrefix(f.Action, "granted again"):
				run.repaired(repairedAppGrant)
			}
		}
		for _, e := range rep.Errors {
			run.fail("plans", errors.New(e))
		}
	}
	if recs, err := s.Store.ListUserPromoRegrants(ctx, uid, 50); err == nil {
		retry := append(append([]string{}, store.PromoRetryStatuses...), "snapshotted", "regranting")
		for _, rec := range recs {
			if !slices.Contains(retry, rec.Status) || time.Since(rec.UpdatedAt) < promoRetryAfter {
				continue // done, or maybe still in flight
			}
			s.promoAdvance(ctx, rec)
			run.rec.PromoRecords = append(run.rec.PromoRecords, rec.ID)
			if got, gerr := s.Store.GetPromoRegrant(ctx, rec.ID); gerr == nil && got.Status != rec.Status {
				run.repaired(repairedAppGrant)
			}
		}
	} else {
		run.fail("promo records", err)
	}
	if !s.RevenueCat.Configured() {
		return false
	}
	st, err := s.RevenueCat.Fresh(ctx, uid)
	if err != nil {
		run.fail("revenuecat", err)
		run.readFail = true
		return false
	}
	return st.Pro || st.Tier != ""
}
