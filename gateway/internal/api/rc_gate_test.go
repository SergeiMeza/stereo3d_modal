package api

import (
	"context"
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

// D11 (owner 2026-11-07): on TEST, a plan invoice for an account not in
// rc_attr_allow_uids grants nothing in RevenueCat — the entitlement
// grants are dry runs and no call is made — while an allowlisted
// account's are sent; prod (no gate) sends both.
func TestRCGatePlanInvoice(t *testing.T) {
	for _, env := range []string{"test", "prod"} {
		s, fake := e0Service(t)
		ctx := context.Background()
		r := pricing.DefaultsFor("test") // plans on
		allowed, other := "u"+store.NewID(), "u"+store.NewID()
		r.RCAttrAllowUIDs = []string{allowed}
		s.Pricing = pricing.NewStatic(r)
		var mu sync.Mutex
		calls := map[string]int{}
		rc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			mu.Lock()
			defer mu.Unlock()
			calls[req.Method+" "+req.URL.Path]++
			w.Write([]byte(`{"subscriber":{"entitlements":{}}}`))
		}))
		t.Cleanup(rc.Close)
		s.RevenueCat = revenuecat.New("sk_test_fake").WithBase(rc.URL, time.Now)
		s.RevenueCat.SetGate(RCGate(env, s.Pricing.Rates))
		end := time.Now().Add(30 * 24 * time.Hour).Unix()
		for i, uid := range []string{allowed, other} {
			cus := "cus_" + uid
			s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: cus})
			sub := "sub_" + uid
			fake.subs[sub] = map[string]any{"id": sub, "status": "active", "customer": cus,
				"metadata":             map[string]string{"product": "svs-web", "env": "test", "user_id": uid, "plan": "business"},
				"current_period_start": time.Now().Unix(), "current_period_end": end}
			s.handlePlanInvoicePaid(ctx, []byte(`{"id":"in_`+string(rune('a'+i))+uid+`","subscription":"`+sub+`"}`))
		}
		count := func(uid string) int {
			mu.Lock()
			defer mu.Unlock()
			n := 0
			for k, v := range calls {
				if strings.Contains(k, uid) {
					n += v
				}
			}
			return n
		}
		if count(allowed) == 0 {
			t.Fatalf("%s: the allowlisted account got no grant: %v", env, calls)
		}
		if got := count(other); (env == "test") != (got == 0) {
			t.Fatalf("%s: other account calls %d (%v)", env, got, calls)
		}
		// Grant Pro and the revokes go through the same gate
		s.RevenueCat.GrantPromotionalUntil(ctx, other, "pro", nil)
		s.RevenueCat.RevokeAnyPromotionals(ctx, other, "pro")
		s.RevenueCat.SetAttributes(ctx, other, map[string]string{"web_plan": "business"}, time.Now())
		if got := count(other); (env == "test") != (got == 0) {
			t.Fatalf("%s: other account writes %d (%v)", env, got, calls)
		}
	}
}
