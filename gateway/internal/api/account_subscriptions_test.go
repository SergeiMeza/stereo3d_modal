package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func deleteAccount(f planFixture, body string, viaProxy bool) (int, map[string]any) {
	r := httptest.NewRequest(http.MethodPost, "/v1/account/delete", strings.NewReader(body))
	w := httptest.NewRecorder()
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { f.s.HandleDeleteAccount(w, r, &AuthedUser{UID: f.uid}) })
	if viaProxy {
		r.Header.Set(httpx.HeaderProxyKey, "k")
		r.Header.Set(httpx.HeaderClientIP, "198.51.100.7")
	}
	httpx.WithTrustedProxy("k", h).ServeHTTP(w, r)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

// 3DS P1 2026-11-06: deleting an account with a web plan ends its
// subscription at the period end (no refund, the period untouched); a
// waiting step-down's schedule is released first; web Pro alike.
func TestDeletionEndsSubscriptions(t *testing.T) {
	for _, tc := range []struct {
		name, planID, tier string
		stepDown           string
	}{
		{"studio", "studio", "studio", ""},
		{"business with a step-down waiting", "business", "business", "pro_monthly"},
		{"web pro", "pro_monthly", "pro", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newPlanFixture(t, tc.planID, tc.tier, 29900, 3, 30)
			ctx := context.Background()
			if tc.stepDown != "" {
				if code, out := f.post(f.s.HandlePlanChange, `{"to":"`+tc.stepDown+`","confirm":true}`); code != 200 {
					t.Fatalf("step-down %d %v", code, out)
				}
				if f.fake.subs[f.sub]["schedule"] == nil {
					t.Fatal("no schedule on the subscription")
				}
			}
			end := f.fake.subs[f.sub]["current_period_end"]
			code, out := deleteAccount(f, `{}`, false)
			if code != 200 || out["deleted"] != true {
				t.Fatalf("delete %d %v", code, out)
			}
			sub := f.fake.subs[f.sub]
			if sub["cancel_at_period_end"] != true || sub["status"] != "active" || sub["current_period_end"] != end || sub["schedule"] != nil {
				t.Fatalf("subscription %v", sub)
			}
			for id, sch := range f.fake.schedules {
				if sch["released"] != "true" {
					t.Fatalf("schedule %s not released", id)
				}
			}
			c, _ := f.s.Store.GetCustomer(ctx, f.uid)
			if !c.AccountDeleted || !c.Plan.CancelAtPeriodEnd || c.Plan.ScheduleID != "" || c.Plan.ScheduledTo != "" {
				t.Fatalf("customer %+v plan %+v", c, c.Plan)
			}
			// a retry after the answer was lost: still 200, nothing new
			if code, _ := deleteAccount(f, `{}`, false); code != 200 {
				t.Fatalf("retry %d", code)
			}
		})
	}
}

// Stripe failing: the deletion fails retryably (502 delete_failed, the
// web's "That didn't go through. Try again.") before anything is marked;
// the retry goes through. Other live svs-web subscriptions on the customer
// end too; another product's are left alone.
func TestDeletionStripeFailureAndRetry(t *testing.T) {
	f := newPlanFixture(t, "business", "business", 29900, 3, 30)
	ctx := context.Background()
	f.fake.subs["sub_stray"] = map[string]any{"id": "sub_stray", "status": "past_due", "customer": "cus_1",
		"metadata": map[string]string{"product": "svs-web", "env": "test", "user_id": f.uid, "plan": "pro"}}
	f.fake.subs["sub_other"] = map[string]any{"id": "sub_other", "status": "active", "customer": "cus_1",
		"metadata": map[string]string{"product": "something-else"}}
	f.fake.failCancel = 1
	code, out := deleteAccount(f, `{}`, false)
	if code != http.StatusBadGateway || out["error"] != "delete_failed" {
		t.Fatalf("failing %d %v", code, out)
	}
	if c, _ := f.s.Store.GetCustomer(ctx, f.uid); c.AccountDeleted {
		t.Fatal("marked deleted though a subscription still renews")
	}
	code, out = deleteAccount(f, `{}`, false)
	if code != 200 || out["deleted"] != true {
		t.Fatalf("retry %d %v", code, out)
	}
	if f.fake.subs[f.sub]["cancel_at_period_end"] != true || f.fake.subs["sub_stray"]["cancel_at_period_end"] != true {
		t.Fatalf("not ended: %v %v", f.fake.subs[f.sub], f.fake.subs["sub_stray"])
	}
	if f.fake.subs["sub_other"]["cancel_at_period_end"] != nil {
		t.Fatal("another product's subscription touched")
	}
}

// An app user with no gateway customer: 200 deleted at once, no Stripe
// call. keep_sign_in is honoured only through svs-backend (proxy key).
func TestDeletionWithoutCustomer(t *testing.T) {
	s, fake := e0Service(t)
	f := planFixture{t: t, s: s, fake: fake, uid: "u" + store.NewID()}
	code, out := deleteAccount(f, `{"keep_sign_in":true}`, true)
	if code != 200 || out["deleted"] != true || out["sign_in_removed"] != false || fake.subCalls != 0 {
		t.Fatalf("no customer %d %v stripe calls %d", code, out, fake.subCalls)
	}
	s.Auth = nil
	f.uid = "u" + store.NewID()
	if _, out := deleteAccount(f, `{"keep_sign_in":true}`, false); out["deleted"] != true || out["sign_in_removed"] != false {
		t.Fatalf("no auth client: %v", out)
	}
}

// After the deletion, a plan invoice (one already in flight) grants
// nothing and fails nothing.
func TestDeletedAccountInvoiceGrantsNothing(t *testing.T) {
	f := newPlanFixture(t, "business", "business", 29900, 3, 30)
	ctx := context.Background()
	if code, _ := deleteAccount(f, `{}`, false); code != 200 {
		t.Fatal("delete")
	}
	before, _ := f.s.Store.GetBalance(ctx, f.uid)
	inv, _ := json.Marshal(map[string]any{"id": "in_late", "subscription": f.sub, "billing_reason": "subscription_cycle",
		"lines": map[string]any{"data": []any{map[string]any{"amount": 29900}}}})
	f.s.handlePlanInvoicePaid(ctx, inv)
	after, _ := f.s.Store.GetBalance(ctx, f.uid)
	if after.PlanCreditCents() != before.PlanCreditCents() || after.PlanCreditCents() != 0 {
		t.Fatalf("credit granted to a deleted account: %d → %d", before.PlanCreditCents(), after.PlanCreditCents())
	}
}

// The orphan sweep: a live subscription whose Firebase user is gone. In
// report mode it only counts; on, it ends it like a deletion; off (prod's
// default) it does nothing.
func TestOrphanSweep(t *testing.T) {
	f := newPlanFixture(t, "studio", "studio", 1198800, 3, 365)
	ctx := context.Background()
	gone := map[string]bool{f.uid: true}
	f.s.UserExists = func(_ context.Context, uid string) (bool, error) { return !gone[uid], nil }

	if found, ended := f.s.sweepOrphanSubscriptions(ctx, false); found < 1 || ended != 0 {
		t.Fatalf("report %d %d", found, ended)
	}
	if f.fake.subs[f.sub]["cancel_at_period_end"] == true {
		t.Fatal("report mode changed Stripe")
	}
	found, ended := f.s.sweepOrphanSubscriptions(ctx, true)
	if found < 1 || ended < 1 || f.fake.subs[f.sub]["cancel_at_period_end"] != true {
		t.Fatalf("on %d %d %v", found, ended, f.fake.subs[f.sub])
	}
	if c, _ := f.s.Store.GetCustomer(ctx, f.uid); !c.AccountDeleted {
		t.Fatal("not marked deleted")
	}
	// mode off: nothing runs
	f.s.Cfg = &config.Config{Env: "prod", OrphanSweep: "off"}
	lastOrphanSweep.Store(0)
	if found, _ := f.s.orphanSweepDue(ctx); found != 0 {
		t.Fatal("off ran")
	}
}
