package api

import (
	"context"
	"encoding/json"
	"io"
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

// attrRecorder is a RevenueCat stub that keeps each uid's attribute writes.
type attrRecorder struct {
	mu    sync.Mutex
	posts map[string][]map[string]any
}

func (a *attrRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v1/subscribers/"), "/")
	if r.Method == http.MethodPost && len(parts) == 2 && parts[1] == "attributes" {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]map[string]map[string]any
		json.Unmarshal(raw, &body)
		got := map[string]any{}
		for k, v := range body["attributes"] {
			got[k] = v["value"]
		}
		a.posts[parts[0]] = append(a.posts[parts[0]], got)
	}
	w.Write([]byte(`{"subscriber":{"entitlements":{}}}`))
}

func (a *attrRecorder) last(uid string) map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	if p := a.posts[uid]; len(p) > 0 {
		return p[len(p)-1]
	}
	return nil
}

// D14: a plan invoice's grant writes web_plan and web_plan_renews_at with
// it — on prod always (rc_attr_sync off), on TEST only for allowlisted
// uids; a revoke and the plan ending write web_plan "none"; the backfill
// counts, then writes, active plans' markers.
func TestWebPlanMarker(t *testing.T) {
	for _, env := range []string{"test", "prod"} {
		s, fake := e0Service(t)
		ctx := context.Background()
		r := pricing.DefaultsFor("test") // plans on
		allowed, other := "u"+store.NewID(), "u"+store.NewID()
		r.RCAttrAllowUIDs = []string{allowed}
		r.RCAttrSync = "off" // the profile attributes stay off: the marker doesn't depend on it
		s.Pricing = pricing.NewStatic(r)
		rec := &attrRecorder{posts: map[string][]map[string]any{}}
		srv := httptest.NewServer(rec)
		t.Cleanup(srv.Close)
		s.RevenueCat = revenuecat.New("sk_test_fake").WithBase(srv.URL, time.Now)
		s.RevenueCat.SetGate(RCGate(env, s.Pricing.Rates))
		end := time.Now().Add(30 * 24 * time.Hour).Truncate(time.Second).UTC()
		for _, uid := range []string{allowed, other} {
			cus, sub := "cus_"+uid, "sub_"+uid
			s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: cus})
			fake.subs[sub] = map[string]any{"id": sub, "status": "active", "customer": cus,
				"metadata":             map[string]string{"product": "svs-web", "env": "test", "user_id": uid, "plan": "business"},
				"current_period_start": time.Now().Unix(), "current_period_end": end.Unix()}
			s.handlePlanInvoicePaid(ctx, []byte(`{"id":"in_`+uid+`","subscription":"`+sub+`"}`))
		}
		m := rec.last(allowed)
		if m == nil || m["web_plan"] != "business" || m["web_plan_renews_at"] != end.Format(time.RFC3339) {
			t.Fatalf("%s: marker %v", env, m)
		}
		if got := rec.last(other); (env == "test") != (got == nil) {
			t.Fatalf("%s: other account's marker %v", env, got)
		}
		// the backfill: counts without writing, then writes
		before := len(rec.posts[allowed])
		res, err := s.BackfillWebPlanMarkers(ctx, false)
		if err != nil || res.Plans != 2 || res.ByPlan["business"] != 2 || res.Written != 0 || len(rec.posts[allowed]) != before {
			t.Fatalf("%s: dry backfill %+v %v", env, res, err)
		}
		if res, _ = s.BackfillWebPlanMarkers(ctx, true); res.Written != 2 || len(rec.posts[allowed]) != before+1 {
			t.Fatalf("%s: backfill %+v", env, res)
		}
		// a revoke: web_plan none, renews_at removed
		s.revokePlanEntitlement(ctx, allowed, "account blocked")
		if m := rec.last(allowed); m["web_plan"] != "none" || m["web_plan_renews_at"] != nil {
			t.Fatalf("%s: after revoke %v", env, m)
		}
		// the plan ending (subscription canceled)
		sub := "sub_" + allowed
		fake.subs[sub]["status"] = "canceled"
		fake.subs[sub]["current_period_end"] = time.Now().Add(-time.Hour).Unix()
		n := len(rec.posts[allowed])
		got, _ := s.Stripe.GetSubscription(sub)
		s.syncPlan(ctx, got)
		if len(rec.posts[allowed]) != n+1 || rec.last(allowed)["web_plan"] != "none" {
			t.Fatalf("%s: plan end %v", env, rec.posts[allowed][n:])
		}
	}
}
