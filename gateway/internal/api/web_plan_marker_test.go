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

// rcSeq is a RevenueCat stub that logs every call in order ("attributes",
// "grant:business", "revoke:pro" …) and can fail the attribute writes.
type rcSeq struct {
	mu        sync.Mutex
	calls     []string
	failAttrs bool
	attrs     []map[string]any
	attrTimes []float64
}

func (q *rcSeq) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	q.mu.Lock()
	defer q.mu.Unlock()
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v1/subscribers/"), "/")
	switch {
	case r.Method == http.MethodPost && len(parts) == 2 && parts[1] == "attributes":
		q.calls = append(q.calls, "attributes")
		if q.failAttrs {
			w.WriteHeader(http.StatusBadRequest) // no in-call retries
			w.Write([]byte(`{"message":"down"}`))
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var body map[string]map[string]map[string]any
		json.Unmarshal(raw, &body)
		got := map[string]any{}
		for k, v := range body["attributes"] {
			got[k] = v["value"]
			q.attrTimes = append(q.attrTimes, v["updated_at_ms"].(float64))
		}
		q.attrs = append(q.attrs, got)
	case r.Method == http.MethodPost && len(parts) == 4 && parts[3] == "promotional":
		q.calls = append(q.calls, "grant:"+parts[2])
	case r.Method == http.MethodPost && len(parts) == 4 && parts[3] == "revoke_promotionals":
		q.calls = append(q.calls, "revoke:"+parts[2])
	}
	w.Write([]byte(`{"subscriber":{"entitlements":{}}}`))
}

func (q *rcSeq) snapshot() []string {
	q.mu.Lock()
	defer q.mu.Unlock()
	return append([]string(nil), q.calls...)
}

func indexOf(xs []string, x string) int {
	for i, v := range xs {
		if v == x {
			return i
		}
	}
	return -1
}

// D14 order: the marker is written before the grants; a revoke goes
// first and "none" after it; a failed marker write still grants and is
// queued, and the reconciler writes it later with its original time.
func TestWebPlanMarkerOrderAndRetry(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	r := pricing.DefaultsFor("test")
	uid := "u" + store.NewID()
	r.RCAttrAllowUIDs = []string{uid}
	s.Pricing = pricing.NewStatic(r)
	seq := &rcSeq{}
	srv := httptest.NewServer(seq)
	t.Cleanup(srv.Close)
	s.RevenueCat = revenuecat.New("sk_test_fake").WithBase(srv.URL, time.Now)
	s.RevenueCat.SetGate(RCGate("test", s.Pricing.Rates))
	end := time.Now().Add(30 * 24 * time.Hour).Truncate(time.Second).UTC()
	cus, sub := "cus_"+uid, "sub_"+uid
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: cus})
	fake.subs[sub] = map[string]any{"id": sub, "status": "active", "customer": cus,
		"metadata":             map[string]string{"product": "svs-web", "env": "test", "user_id": uid, "plan": "business"},
		"current_period_start": time.Now().Unix(), "current_period_end": end.Unix()}

	// 1. a failed marker write: the grants still go, the write is queued
	seq.failAttrs = true
	s.handlePlanInvoicePaid(ctx, []byte(`{"id":"in_1_`+uid+`","subscription":"`+sub+`"}`))
	calls := seq.snapshot()
	a, gb, gp := indexOf(calls, "attributes"), indexOf(calls, "grant:business"), indexOf(calls, "grant:pro")
	if a < 0 || gb < 0 || gp < 0 || !(a < gb && a < gp) {
		t.Fatalf("grant order %v", calls)
	}
	c, _ := s.Store.GetCustomer(ctx, uid)
	if c.Plan == nil || c.Plan.RCGrantInvoice != "in_1_"+uid {
		t.Fatalf("not granted after a failed marker write: %+v", c.Plan)
	}
	q, err := s.Store.GetRCAttrRetry(ctx, uid)
	if err != nil || q == nil || q.Attrs["web_plan"] != "business" || q.Attrs["web_plan_renews_at"] != end.Format(time.RFC3339) || q.Attempts != 0 {
		t.Fatalf("retry not queued: %+v %v", q, err)
	}
	firstAt := q.At

	// 2. not due yet: nothing; RevenueCat still failing: counted, pushed back
	if n := s.rcAttrRetrySweep(ctx, time.Now()); n != 0 || len(seq.snapshot()) != len(calls) {
		t.Fatalf("retried before it was due: %d", n)
	}
	if n := s.rcAttrRetrySweep(ctx, time.Now().Add(2*time.Minute)); n != 0 {
		t.Fatalf("a failing retry counted as done: %d", n)
	}
	if q, _ = s.Store.GetRCAttrRetry(ctx, uid); q == nil || q.Attempts != 1 || !q.NextAt.After(time.Now().Add(3*time.Minute)) {
		t.Fatalf("failed retry not pushed back: %+v", q)
	}

	// 3. RevenueCat back: the reconciler writes it, with the first try's time
	seq.failAttrs = false
	if n := s.rcAttrRetrySweep(ctx, time.Now().Add(10*time.Minute)); n != 1 {
		t.Fatalf("retry not written: %d", n)
	}
	if len(seq.attrs) != 1 || seq.attrs[0]["web_plan"] != "business" || seq.attrs[0]["web_plan_renews_at"] != end.Format(time.RFC3339) ||
		int64(seq.attrTimes[0]) != firstAt.UnixMilli() {
		t.Fatalf("retried write %v at %v (want %d)", seq.attrs, seq.attrTimes, firstAt.UnixMilli())
	}
	if q, _ = s.Store.GetRCAttrRetry(ctx, uid); q != nil {
		t.Fatalf("retry left behind: %+v", q)
	}

	// 4. a revoke: revoke first, "none" after
	before := len(seq.snapshot())
	s.revokePlanEntitlement(ctx, uid, "account blocked")
	calls = seq.snapshot()[before:]
	rv, cl := indexOf(calls, "revoke:business"), indexOf(calls, "attributes")
	if rv < 0 || cl < 0 || rv > cl {
		t.Fatalf("revoke order %v", calls)
	}
	if m := seq.attrs[len(seq.attrs)-1]; m["web_plan"] != "none" || m["web_plan_renews_at"] != nil {
		t.Fatalf("after revoke %v", m)
	}
}

// A revoke that fails leaves the marker alone; the nightly resume revokes,
// then clears.
func TestWebPlanMarkerNoClearOnFailedRevoke(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	r := pricing.DefaultsFor("test")
	uid := "u" + store.NewID()
	r.RCAttrAllowUIDs = []string{uid}
	s.Pricing = pricing.NewStatic(r)
	var mu sync.Mutex
	var calls []string
	failRevoke := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/attributes"):
			raw, _ := io.ReadAll(r.Body)
			calls = append(calls, "attributes:"+map[bool]string{true: "none", false: "plan"}[strings.Contains(string(raw), `"none"`)])
		case strings.HasSuffix(r.URL.Path, "/revoke_promotionals"):
			calls = append(calls, "revoke")
			if failRevoke {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
		}
		w.Write([]byte(`{"subscriber":{"entitlements":{}}}`))
	}))
	t.Cleanup(srv.Close)
	s.RevenueCat = revenuecat.New("sk_test_fake").WithBase(srv.URL, time.Now)
	s.RevenueCat.SetGate(RCGate("test", s.Pricing.Rates))
	end := time.Now().Add(30 * 24 * time.Hour).UTC()
	cus, sub := "cus_"+uid, "sub_"+uid
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: cus})
	fake.subs[sub] = map[string]any{"id": sub, "status": "active", "customer": cus,
		"metadata":             map[string]string{"product": "svs-web", "env": "test", "user_id": uid, "plan": "business"},
		"current_period_start": time.Now().Unix(), "current_period_end": end.Unix()}
	s.handlePlanInvoicePaid(ctx, []byte(`{"id":"in_`+uid+`","subscription":"`+sub+`"}`))
	s.revokePlanEntitlement(ctx, uid, "account blocked")
	mu.Lock()
	got := append([]string(nil), calls...)
	mu.Unlock()
	if indexOf(got, "revoke") < 0 || indexOf(got, "attributes:none") >= 0 {
		t.Fatalf("cleared despite a failed revoke: %v", got)
	}
	// the resume (a second delivery of the same event) revokes, then clears
	mu.Lock()
	failRevoke, calls = false, nil
	mu.Unlock()
	s.revokePlanEntitlement(ctx, uid, "account blocked")
	mu.Lock()
	got = append([]string(nil), calls...)
	mu.Unlock()
	if rv, cl := indexOf(got, "revoke"), indexOf(got, "attributes:none"); rv < 0 || cl < 0 || rv > cl {
		t.Fatalf("resume order %v", got)
	}
}
