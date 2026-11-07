package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func callAs(f planFixture, h func(http.ResponseWriter, *http.Request, *AuthedUser), method, body string, viaProxy bool) (int, map[string]any) {
	r := httptest.NewRequest(method, "/", strings.NewReader(body))
	w := httptest.NewRecorder()
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h(w, r, &AuthedUser{UID: f.uid}) })
	if viaProxy {
		r.Header.Set(httpx.HeaderProxyKey, "k")
		r.Header.Set(httpx.HeaderClientIP, "198.51.100.7")
	}
	httpx.WithTrustedProxy("k", inner).ServeHTTP(w, r)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func deleteAccount(f planFixture, body string, viaProxy bool) (int, map[string]any) {
	return callAs(f, f.s.HandleDeleteAccount, http.MethodPost, body, viaProxy)
}

// deleteAccountNow is the deletion without the 48-hour wait (what the
// sweep runs at delete_after, and prod until its release): these tests
// are about the deletion itself.
func deleteAccountNow(f planFixture, body string) (int, map[string]any) {
	r := *f.s.Pricing.Rates(context.Background())
	r.AccountDeleteDelayHours = 0
	f.s.Pricing = pricing.NewStatic(&r)
	return deleteAccount(f, body, false)
}

// Owner 2026-11-06: a renewing plan (Business, Studio, web Pro; a waiting
// step-down still renews) is cancelled first: 409 plan_renewing {plan,
// current_period_end, cancel_at_period_end: false}, nothing charged,
// nothing changed in Stripe.
func TestDeletionRefusedWhilePlanRenews(t *testing.T) {
	for _, tc := range []struct{ name, planID, tier, stepDown string }{
		{"studio", "studio", "studio", ""},
		{"business with a step-down waiting", "business", "business", "pro_monthly"},
		{"web pro", "pro_monthly", "pro", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newPlanFixture(t, tc.planID, tc.tier, 29900, 3, 30)
			if tc.stepDown != "" {
				if code, out := f.post(f.s.HandlePlanChange, `{"to":"`+tc.stepDown+`","confirm":true}`); code != 200 {
					t.Fatalf("step-down %d %v", code, out)
				}
			}
			code, out := deleteAccountNow(f, `{}`)
			d, _ := out["details"].(map[string]any)
			if code != 409 || out["error"] != "plan_renewing" || d["plan"] != tc.tier || d["cancel_at_period_end"] != false || d["current_period_end"] == nil {
				t.Fatalf("refusal %d %v", code, out)
			}
			if f.fake.subs[f.sub]["cancel_at_period_end"] != nil {
				t.Fatal("the deletion touched the subscription")
			}
			if c, _ := f.s.Store.GetCustomer(context.Background(), f.uid); c.AccountDeleted {
				t.Fatal("deleted")
			}
		})
	}
}

// Cancelled first (a plan change to pay_per_video while a step-down
// waits replaces it; the thin cancel is idempotent), the deletion goes
// ahead and leaves the plan running to its period end: the answer names
// it; the subscription, the Stripe customer and the plan dates stay;
// nothing is granted again.
func TestDeletionAfterCancel(t *testing.T) {
	f := newPlanFixture(t, "business", "business", 29900, 3, 30)
	ctx := context.Background()
	if code, out := f.post(f.s.HandlePlanChange, `{"to":"pro_monthly","confirm":true}`); code != 200 {
		t.Fatalf("step-down %d %v", code, out)
	}
	code, out := f.post(f.s.HandlePlanChange, `{"to":"pay_per_video","confirm":true}`)
	if code != 200 {
		t.Fatalf("cancel over a step-down %d %v", code, out)
	}
	sub := f.fake.subs[f.sub]
	if sub["cancel_at_period_end"] != true || sub["schedule"] != nil {
		t.Fatalf("subscription %v", sub)
	}
	for id, sch := range f.fake.schedules {
		if sch["released"] != "true" {
			t.Fatalf("schedule %s kept", id)
		}
	}
	c, _ := f.s.Store.GetCustomer(ctx, f.uid)
	if !c.Plan.CancelAtPeriodEnd || c.Plan.ScheduleID != "" || c.Plan.ScheduledTo != planNone {
		t.Fatalf("plan %+v", c.Plan)
	}
	if code, out := callAs(f, f.s.HandleAccountPlanCancel, http.MethodPost, ``, true); code != 200 || out["cancel_at_period_end"] != true || out["plan"] != "business" {
		t.Fatalf("thin cancel again %d %v", code, out)
	}
	end := sub["current_period_end"]
	f.s.Store.UpdateCustomer(ctx, f.uid, func(c *store.Customer) error { c.DefaultPaymentMethod, c.CardLast4 = "pm_saved", "4242"; return nil })
	code, out = deleteAccountNow(f, `{}`)
	if code != 200 || out["deleted"] != true || out["plan"] != "business" || out["cancel_at_period_end"] != true || out["current_period_end"] == nil {
		t.Fatalf("delete %d %v", code, out)
	}
	if sub["status"] != "active" || sub["current_period_end"] != end || sub["cancel_at_period_end"] != true {
		t.Fatalf("the deletion changed the subscription: %v", sub)
	}
	if len(f.fake.detaches) != 0 { // saved cards stay on Stripe (owner 2026-11-06)
		t.Fatalf("the deletion detached payment methods: %v", f.fake.detaches)
	}
	c, _ = f.s.Store.GetCustomer(ctx, f.uid)
	if c.DefaultPaymentMethod != "pm_saved" {
		t.Fatalf("saved card dropped: %q", c.DefaultPaymentMethod)
	}
	if !c.AccountDeleted || c.StripeCustomerID == "" || c.Plan.CurrentPeriodEnd == nil || c.Plan.SubscriptionID != f.sub {
		t.Fatalf("kept for restore: %+v %+v", c, c.Plan)
	}
	before, _ := f.s.Store.GetBalance(ctx, f.uid)
	inv, _ := json.Marshal(map[string]any{"id": "in_late", "subscription": f.sub, "billing_reason": "subscription_cycle",
		"lines": map[string]any{"data": []any{map[string]any{"amount": 29900}}}})
	f.s.handlePlanInvoicePaid(ctx, inv)
	after, _ := f.s.Store.GetBalance(ctx, f.uid)
	if after.PlanCreditCents() != before.PlanCreditCents() {
		t.Fatalf("credit granted again: %d → %d", before.PlanCreditCents(), after.PlanCreditCents())
	}
	if code, _ := deleteAccountNow(f, `{}`); code != 200 {
		t.Fatalf("retry %d", code)
	}
}

// Thin cancel and resume (the app through svs-backend), and Stripe
// failing on the cancel: 502, nothing marked, a retry goes through.
func TestPlanCancelResume(t *testing.T) {
	f := newPlanFixture(t, "pro_yearly", "pro", 6999, 3, 365)
	f.fake.failCancel = 1
	if code, out := callAs(f, f.s.HandleAccountPlanCancel, http.MethodPost, ``, true); code != http.StatusBadGateway {
		t.Fatalf("failing %d %v", code, out)
	}
	if c, _ := f.s.Store.GetCustomer(context.Background(), f.uid); c.Plan.CancelAtPeriodEnd {
		t.Fatal("marked cancelled though Stripe failed")
	}
	code, out := callAs(f, f.s.HandleAccountPlanCancel, http.MethodPost, ``, true)
	if code != 200 || out["cancel_at_period_end"] != true || out["plan"] != "pro" || out["current_period_end"] == nil {
		t.Fatalf("cancel %d %v", code, out)
	}
	code, out = callAs(f, f.s.HandleAccountPlanResume, http.MethodPost, ``, true)
	if code != 200 || out["cancel_at_period_end"] != false || f.fake.subs[f.sub]["cancel_at_period_end"] != false {
		t.Fatalf("resume %d %v", code, out)
	}
	none := planFixture{t: t, s: f.s, fake: f.fake, uid: "u" + store.NewID()}
	if code, out := callAs(none, f.s.HandleAccountPlanCancel, http.MethodPost, ``, false); code != 404 || out["error"] != "no_plan" {
		t.Fatalf("no plan %d %v", code, out)
	}
}

// The preview: what a delete would do, changing nothing; refusals name
// the plan.
func TestDeletePreview(t *testing.T) {
	f := newPlanFixture(t, "studio", "studio", 1198800, 3, 365)
	ctx := context.Background()
	code, out := callAs(f, f.s.HandleDeletePreview, http.MethodGet, ``, true)
	if code != 200 || out["can_delete"] != false || out["block"] != "plan_renewing" || out["plan_state"] != "renewing" || out["plan"] != "studio" {
		t.Fatalf("renewing %d %v", code, out)
	}
	callAs(f, f.s.HandleAccountPlanCancel, http.MethodPost, ``, true)
	if err := f.s.Store.CreateConversion(ctx, &store.Conversion{ID: store.NewID(), UID: f.uid, State: store.ActiveStates[0], Kind: "video"}); err != nil {
		t.Fatal(err)
	}
	code, out = callAs(f, f.s.HandleDeletePreview, http.MethodGet, ``, false)
	if code != 200 || out["block"] != "active_runs" || out["plan_state"] != "cancelled" || out["active_runs"] != float64(1) || out["dues_cents"] != float64(0) {
		t.Fatalf("cancelled with a run %d %v", code, out)
	}
	code, out = deleteAccountNow(f, `{}`)
	d, _ := out["details"].(map[string]any)
	if code != 409 || out["error"] != "active_runs" || d["plan"] != "studio" || d["cancel_at_period_end"] != true {
		t.Fatalf("active runs %d %v", code, out)
	}
	nobody := planFixture{t: t, s: f.s, fake: f.fake, uid: "u" + store.NewID()}
	if code, out := callAs(nobody, f.s.HandleDeletePreview, http.MethodGet, ``, false); code != 200 || out["can_delete"] != true || out["plan_state"] != "none" || out["plan"] != nil {
		t.Fatalf("nobody %d %v", code, out)
	}
	if c, _ := f.s.Store.GetCustomer(ctx, f.uid); c.AccountDeleted {
		t.Fatal("a preview deleted")
	}
}

// An app user with no gateway customer: 200 deleted at once, no Stripe
// call; keep_sign_in only through svs-backend.
func TestDeletionWithoutCustomer(t *testing.T) {
	s, fake := e0Service(t)
	f := planFixture{t: t, s: s, fake: fake, uid: "u" + store.NewID()}
	code, out := deleteAccount(f, `{"keep_sign_in":true}`, true)
	if code != 200 || out["deleted"] != true || out["sign_in_removed"] != false || out["plan"] != nil || fake.subCalls != 0 {
		t.Fatalf("no customer %d %v stripe calls %d", code, out, fake.subCalls)
	}
}

// The orphan sweep reports renewing plans whose sign-in is gone and never
// cancels; off (prod's default) it doesn't run.
func TestOrphanSweepReportsOnly(t *testing.T) {
	f := newPlanFixture(t, "studio", "studio", 1198800, 3, 365)
	ctx := context.Background()
	f.s.UserExists = func(_ context.Context, uid string) (bool, error) { return uid != f.uid, nil }
	if found := f.s.sweepOrphanSubscriptions(ctx); found < 1 {
		t.Fatalf("found %d", found)
	}
	if f.fake.subs[f.sub]["cancel_at_period_end"] != nil {
		t.Fatal("the sweep changed Stripe")
	}
	if c, _ := f.s.Store.GetCustomer(ctx, f.uid); c.AccountDeleted {
		t.Fatal("the sweep marked the account deleted")
	}
	f.s.Cfg = &config.Config{Env: "prod", OrphanSweep: "off"}
	lastOrphanSweep.Store(0)
	if f.s.orphanSweepDue(ctx) != 0 {
		t.Fatal("off ran")
	}
}

// Plan credit is never money: a cancelled plan's credit alone asks for no
// "Delete and refund" and opens no refund case; the preview names it as
// plan_credit_cents. A cash top-up still asks and waits for its case.
func TestDeletionPlanCreditIsNotCash(t *testing.T) {
	f := newPlanFixture(t, "business", "business", 29900, 3, 30)
	ctx := context.Background()
	inv := fmt.Sprintf(`{"id":"in_%s","subscription":"%s","billing_reason":"subscription_cycle","lines":{"data":[{"amount":29900}]}}`, f.sub, f.sub)
	f.s.handlePlanInvoicePaid(ctx, []byte(inv))
	callAs(f, f.s.HandleAccountPlanCancel, http.MethodPost, ``, false)
	code, out := callAs(f, f.s.HandleDeletePreview, http.MethodGet, ``, false)
	if code != 200 || out["plan_credit_cents"] == float64(0) || out["cash_balance_cents"] != float64(0) ||
		out["balance_confirmation_needed"] != false || out["waits_for_refund_case"] != false {
		t.Fatalf("preview %d %v", code, out)
	}
	code, out = deleteAccountNow(f, `{}`)
	if code != 200 || out["deleted"] != true {
		t.Fatalf("delete with plan credit only %d %v", code, out)
	}
	if cases, _ := f.s.Store.ListUserCases(ctx, f.uid, 10); len(cases) != 0 {
		t.Fatalf("a refund case for plan credit: %+v", cases)
	}

	cash := planFixture{t: t, s: f.s, fake: f.fake, uid: "u" + store.NewID()}
	f.s.Store.PutCustomer(ctx, cash.uid, &store.Customer{StripeCustomerID: "cus_cash"})
	paidTopup(t, f.s, cash.uid, 2500)
	code, out = deleteAccountNow(cash, `{}`)
	// refund policy 2026-11-08: the cash is forfeited, no 409, no case
	if code != 200 || out["deleted"] != true {
		t.Fatalf("cash %d %v", code, out)
	}
	if cases, _ := f.s.Store.ListUserCases(ctx, cash.uid, 10); len(cases) != 0 {
		t.Fatalf("a refund case for the deleted balance: %+v", cases)
	}
}
