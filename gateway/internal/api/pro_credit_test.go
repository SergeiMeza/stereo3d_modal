package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/revenuecat"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// rcSubs serves RevenueCat subscribers by uid (set per test); unknown
// uids have nothing.
type rcSubs struct {
	mu   sync.Mutex
	subs map[string]map[string]any
}

func (f *rcSubs) set(uid string, sub map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.subs[uid] = sub
}

func ts(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// rcSub is a subscriber with one product behind "pro" (subscription, or
// lifetime when expires is zero), bought originally at original.
func rcSub(product, storeName, periodType, originalTx string, original, expires time.Time, extra map[string]any) map[string]any {
	ent := map[string]any{"product_identifier": product}
	out := map[string]any{"entitlements": map[string]any{"pro": ent}}
	if expires.IsZero() {
		ent["expires_date"] = nil
		out["non_subscriptions"] = map[string]any{product: []any{map[string]any{"id": "ns_" + originalTx, "purchase_date": ts(original),
			"store": storeName, "store_transaction_id": originalTx}}}
		out["subscriptions"] = map[string]any{}
		return map[string]any{"subscriber": out}
	}
	ent["expires_date"] = ts(expires)
	sub := map[string]any{"purchase_date": ts(time.Now().Add(-time.Hour)), "original_purchase_date": ts(original), "expires_date": ts(expires),
		"store": storeName, "period_type": periodType, "original_transaction_id": originalTx}
	for k, v := range extra {
		sub[k] = v
	}
	out["subscriptions"] = map[string]any{product: sub}
	return map[string]any{"subscriber": out}
}

func proCreditService(t *testing.T) (*Service, *rcSubs) {
	t.Helper()
	s, _ := e0Service(t)
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	f := &rcSubs{subs: map[string]map[string]any{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uid := strings.TrimPrefix(r.URL.Path, "/v1/subscribers/")
		f.mu.Lock()
		sub, ok := f.subs[uid]
		f.mu.Unlock()
		if !ok {
			sub = map[string]any{"subscriber": map[string]any{"entitlements": map[string]any{}, "subscriptions": map[string]any{}}}
		}
		json.NewEncoder(w).Encode(sub)
	}))
	t.Cleanup(srv.Close)
	s.RevenueCat = revenuecat.New("sk_test_fake").WithBase(srv.URL, time.Now)
	return s, f
}

func planCredit(t *testing.T, s *Service, uid string) int64 {
	t.Helper()
	b, err := s.Store.GetBalance(context.Background(), uid)
	if err != nil {
		return 0
	}
	return b.PlanCreditCents()
}

func fresh(s *Service, uid string) *proCreditView {
	s.RevenueCat.Forget(uid)
	return s.ensureProCredit(context.Background(), uid)
}

// PRO-01/03/04/06/08: App Store Monthly, Yearly and a free trial each get
// $20 for the month they are in, counted from the original purchase's
// anniversary, once; a cancelled plan keeps getting it to its period end.
func TestProCreditAppStoreMonths(t *testing.T) {
	s, rc := proCreditService(t)
	now := time.Now().UTC()
	for _, tc := range []struct {
		name, product, period string
		original, expires     time.Time
		extra                 map[string]any
		month                 int
	}{
		{"monthly", "pro_subs_1m_v1", "normal", now.AddDate(0, 0, -40), now.AddDate(0, 0, 20), nil, 1},
		{"yearly, month 4 of 12, never upfront", "pro_subs_1y_v1", "normal", now.AddDate(0, 0, -100), now.AddDate(0, 0, 265), nil, 3},
		{"free trial", "pro_subs_1m_v1", "trial", now.AddDate(0, 0, -10), now.AddDate(0, 0, 80), nil, 0},
		{"cancelled, period not over", "pro_subs_1m_v1", "normal", now.AddDate(0, 0, -10), now.AddDate(0, 0, 20), map[string]any{"unsubscribe_detected_at": ts(now.AddDate(0, 0, -2))}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			uid := "u" + store.NewID()
			rc.set(uid, rcSub(tc.product, "app_store", tc.period, "tx_"+uid, tc.original, tc.expires, tc.extra))
			v := fresh(s, uid)
			if v == nil || !v.Granted || v.CentsPerMonth != 2000 || v.Source != "app_store" || v.Trial != (tc.period == "trial") {
				t.Fatalf("view %+v", v)
			}
			if !v.PeriodStart.Equal(store.AddMonths(tc.original.Truncate(time.Second), tc.month)) {
				t.Fatalf("month window %v (original %v)", v.PeriodStart, tc.original)
			}
			if got := planCredit(t, s, uid); got != 2000 {
				t.Fatalf("credit %d", got)
			}
			if v2 := fresh(s, uid); v2 == nil || v2.grantedNow || !v2.Granted || planCredit(t, s, uid) != 2000 {
				t.Fatalf("granted twice %+v %d", v2, planCredit(t, s, uid))
			}
		})
	}
}

// PRO-05: Lifetime gets $10 a month from its purchase's anniversary.
// Weekly gets $20 per month window, however many weeks renew in it.
func TestProCreditLifetimeAndWeekly(t *testing.T) {
	s, rc := proCreditService(t)
	now := time.Now().UTC()
	life := "u" + store.NewID()
	rc.set(life, rcSub("pro_subs_lifetime_v1", "app_store", "", "life_"+life, now.AddDate(0, 0, -70), time.Time{}, nil))
	v := fresh(s, life)
	if v == nil || !v.Granted || v.CentsPerMonth != 1000 || v.Kind != "pro_lifetime" || !v.PeriodStart.Equal(store.AddMonths(now.AddDate(0, 0, -70).Truncate(time.Second), 2)) {
		t.Fatalf("lifetime %+v", v)
	}
	if planCredit(t, s, life) != 1000 {
		t.Fatalf("lifetime credit %d", planCredit(t, s, life))
	}
	week := "u" + store.NewID()
	rc.set(week, rcSub("pro_subs_1w_v1", "app_store", "normal", "wk_"+week, now.AddDate(0, 0, -9), now.AddDate(0, 0, 5), nil))
	if v := fresh(s, week); v == nil || !v.Granted || v.Kind != "pro_weekly" || v.CentsPerMonth != 2000 {
		t.Fatalf("weekly %+v", v)
	}
	// the next weekly renewal, same month window: nothing more
	rc.set(week, rcSub("pro_subs_1w_v1", "app_store", "normal", "wk_"+week, now.AddDate(0, 0, -9), now.AddDate(0, 0, 12), nil))
	if v := fresh(s, week); v == nil || v.grantedNow || planCredit(t, s, week) != 2000 {
		t.Fatalf("weekly renewal granted again %+v", v)
	}
}

// PRO-06: the same store purchase (original transaction) never earns a
// month twice: a re-trial on it, or a TRANSFER to another account, gets
// nothing more that month.
func TestProCreditOncePerPurchase(t *testing.T) {
	s, rc := proCreditService(t)
	now := time.Now().UTC()
	a, b := "u"+store.NewID(), "u"+store.NewID()
	tx := "tx_shared_" + store.NewID()
	rc.set(a, rcSub("pro_subs_1m_v1", "app_store", "trial", tx, now.AddDate(0, 0, -3), now.AddDate(0, 0, 87), nil))
	if v := fresh(s, a); v == nil || !v.Granted {
		t.Fatalf("trial %+v", v)
	}
	// re-trial on the same purchase (a new trial period, same original transaction)
	rc.set(a, rcSub("pro_subs_1y_v1", "app_store", "trial", tx, now.AddDate(0, 0, -3), now.AddDate(0, 0, 90), nil))
	if v := fresh(s, a); v == nil || v.grantedNow || planCredit(t, s, a) != 2000 {
		t.Fatalf("re-trial granted again %+v %d", v, planCredit(t, s, a))
	}
	// transferred to another account
	rc.set(a, map[string]any{"subscriber": map[string]any{"entitlements": map[string]any{}, "subscriptions": map[string]any{}}})
	rc.set(b, rcSub("pro_subs_1m_v1", "app_store", "trial", tx, now.AddDate(0, 0, -3), now.AddDate(0, 0, 87), nil))
	if v := fresh(s, b); v == nil || v.grantedNow || v.Granted || planCredit(t, s, b) != 0 {
		t.Fatalf("transfer granted again %+v %d", v, planCredit(t, s, b))
	}
}

// PRO-02: a promotional grant (gift, promo, admin) gets no credit.
func TestProCreditPaidOnly(t *testing.T) {
	s, rc := proCreditService(t)
	now := time.Now().UTC()
	for _, tc := range []struct{ product, store string }{{"rc_promo_pro_custom", "promotional"}, {"pro_subs_1m_v1", "promotional"}} {
		uid := "u" + store.NewID()
		rc.set(uid, rcSub(tc.product, tc.store, "normal", "p_"+uid, now.AddDate(0, 0, -3), now.AddDate(0, 0, 20), nil))
		if v := fresh(s, uid); v != nil || planCredit(t, s, uid) != 0 {
			t.Fatalf("%s/%s: %+v", tc.product, tc.store, v)
		}
	}
}

// PRO-07: a refund takes back only the unspent part of the month's
// credit, never bills what was spent, and counts once; two refunded
// purchases flag the account.
func TestProCreditRefund(t *testing.T) {
	s, rc := proCreditService(t)
	ctx := context.Background()
	now := time.Now().UTC()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_r"})
	rc.set(uid, rcSub("pro_subs_1m_v1", "app_store", "normal", "r1_"+uid, now.AddDate(0, 0, -3), now.AddDate(0, 0, 27), nil))
	fresh(s, uid)
	if _, _, err := s.Store.BalanceTx(ctx, uid, func(*store.Balance) ([]store.BalanceOp, error) {
		return []store.BalanceOp{{Kind: store.EntryAdjustment, Cents: -700, EntryID: "spend_" + uid, Note: "a run"}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	before, _ := s.Store.GetBalance(ctx, uid)
	if before.PlanCreditCents() != 1300 {
		t.Fatalf("after spending %d", before.PlanCreditCents())
	}
	refunded := rcSub("pro_subs_1m_v1", "app_store", "normal", "r1_"+uid, now.AddDate(0, 0, -3), now.AddDate(0, 0, 27), map[string]any{"refunded_at": ts(now)})
	delete(refunded["subscriber"].(map[string]any)["entitlements"].(map[string]any), "pro") // RevenueCat drops the entitlement
	rc.set(uid, refunded)
	if v := fresh(s, uid); v != nil {
		t.Fatalf("still credited %+v", v)
	}
	after, _ := s.Store.GetBalance(ctx, uid)
	if after.PlanCreditCents() != 0 || after.BalanceCents != before.BalanceCents-1300 {
		t.Fatalf("refund took %d (balance %d → %d)", before.PlanCreditCents()-after.PlanCreditCents(), before.BalanceCents, after.BalanceCents)
	}
	c, _ := s.Store.GetCustomer(ctx, uid)
	if c.ProRefunds != 1 || c.ProRefundFlag {
		t.Fatalf("counter %+v", c)
	}
	fresh(s, uid) // seen again: counted once
	if c, _ := s.Store.GetCustomer(ctx, uid); c.ProRefunds != 1 {
		t.Fatalf("counted twice %d", c.ProRefunds)
	}
	grants, _ := s.Store.ListProCreditGrants(ctx, uid, 5)
	if len(grants) != 1 || grants[0].State != store.ProCreditRemoved || grants[0].RemovedCents != 1300 {
		t.Fatalf("grant %+v", grants)
	}
	// a second refunded purchase: flagged; the admin page shows it
	rc.set(uid, rcSub("pro_subs_1w_v1", "app_store", "normal", "r2_"+uid, now.AddDate(0, 0, -2), now.AddDate(0, 0, 5), nil))
	fresh(s, uid)
	second := rcSub("pro_subs_1w_v1", "app_store", "normal", "r2_"+uid, now.AddDate(0, 0, -2), now.AddDate(0, 0, 5), map[string]any{"refunded_at": ts(now)})
	delete(second["subscriber"].(map[string]any)["entitlements"].(map[string]any), "pro")
	rc.set(uid, second)
	fresh(s, uid)
	c, _ = s.Store.GetCustomer(ctx, uid)
	adm := s.proCreditAdminJSON(ctx, uid, c)
	if c.ProRefunds != 2 || !c.ProRefundFlag || adm["refund_flag"] != true || len(adm["grants"].([]*store.ProCreditGrant)) != 2 {
		t.Fatalf("flag %+v %v", c, adm)
	}
}

// PRO-10: a Business plan's credit wins; Pro adds nothing (and never
// replaces it). Web Pro on our Stripe earns its credit from our record,
// once, even with RevenueCat's promotional grant behind it.
func TestProCreditPlansAndWebPro(t *testing.T) {
	s, rc := proCreditService(t)
	ctx := context.Background()
	now := time.Now().UTC()
	biz := "u" + store.NewID()
	end := now.AddDate(0, 0, 20)
	start := now.AddDate(0, 0, -10)
	s.Store.PutCustomer(ctx, biz, &store.Customer{Plan: &store.Plan{Tier: "business", SubscriptionID: "sub_b", Status: "active", CurrentPeriodStart: &start, CurrentPeriodEnd: &end}})
	s.Store.BalanceTx(ctx, biz, func(*store.Balance) ([]store.BalanceOp, error) {
		return []store.BalanceOp{{Kind: store.EntryPlanCredit, Cents: 40000, EntryID: "plancredit_in_b", Ref: "sub_b", ExpiresAt: &end}}, nil
	})
	rc.set(biz, rcSub("pro_subs_1m_v1", "app_store", "normal", "biz_"+biz, now.AddDate(0, 0, -3), now.AddDate(0, 0, 27), nil))
	if v := fresh(s, biz); v != nil || planCredit(t, s, biz) != 40000 {
		t.Fatalf("business + pro: %+v %d", v, planCredit(t, s, biz))
	}
	web := "u" + store.NewID()
	s.Store.PutCustomer(ctx, web, &store.Customer{Plan: &store.Plan{Tier: "pro", PlanID: "pro_monthly", SubscriptionID: "sub_w", Status: "active",
		StartedAt: &start, CurrentPeriodStart: &start, CurrentPeriodEnd: &end}})
	rc.set(web, rcSub("rc_promo_pro_custom", "promotional", "normal", "", now.AddDate(0, 0, -10), end, nil))
	v := fresh(s, web)
	if v == nil || !v.Granted || v.Source != "web" || v.Kind != "pro_monthly" || planCredit(t, s, web) != 2000 {
		t.Fatalf("web pro %+v %d", v, planCredit(t, s, web))
	}
	if v := fresh(s, web); v == nil || v.grantedNow || planCredit(t, s, web) != 2000 {
		t.Fatalf("web pro twice %+v", v)
	}
	// a Stripe refund of the web plan: the unspent month goes
	s.revokeRefundedPlan(ctx, web, "in_w")
	if planCredit(t, s, web) != 0 {
		t.Fatalf("after the Stripe refund %d", planCredit(t, s, web))
	}
	// /v1/pricing: each plan's credit and the by-product table (Lifetime $10)
	r := s.rates(ctx)
	if r.ProCreditFor("pro_lifetime") != 1000 || r.ProCreditFor("pro_monthly") != 2000 || pricing.Defaults().ProCreditFor("pro_monthly") != 0 {
		t.Fatal("credit config")
	}
}

// Expired Pro, or prod without pro_credit_cents: nothing.
func TestProCreditOff(t *testing.T) {
	s, rc := proCreditService(t)
	now := time.Now().UTC()
	uid := "u" + store.NewID()
	rc.set(uid, rcSub("pro_subs_1m_v1", "app_store", "normal", "x_"+uid, now.AddDate(0, -2, 0), now.Add(-time.Hour), nil))
	if v := fresh(s, uid); v != nil {
		t.Fatalf("expired %+v", v)
	}
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("prod"))
	rc.set(uid, rcSub("pro_subs_1m_v1", "app_store", "normal", "x_"+uid, now.AddDate(0, 0, -2), now.AddDate(0, 0, 20), nil))
	if v := fresh(s, uid); v != nil {
		t.Fatalf("prod %+v", v)
	}
}
