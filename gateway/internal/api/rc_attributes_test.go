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

// rcStub answers GET /v1/subscribers/{id} with attrs and records the
// attribute POSTs.
type rcStub struct {
	mu    sync.Mutex
	attrs map[string]map[string]string // uid → what RevenueCat has
	posts map[string][]map[string]any  // uid → bodies
}

func (r *rcStub) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	r.mu.Lock()
	defer r.mu.Unlock()
	parts := strings.Split(strings.TrimPrefix(req.URL.Path, "/v1/subscribers/"), "/")
	uid := parts[0]
	switch {
	case req.Method == http.MethodGet && len(parts) == 1:
		a := map[string]any{}
		for k, v := range r.attrs[uid] {
			a[k] = map[string]any{"value": v}
		}
		json.NewEncoder(w).Encode(map[string]any{"subscriber": map[string]any{"subscriber_attributes": a}})
	case req.Method == http.MethodPost && len(parts) == 2 && parts[1] == "attributes":
		raw, _ := io.ReadAll(req.Body)
		var body map[string]map[string]map[string]any
		json.Unmarshal(raw, &body)
		got := map[string]any{}
		for k, v := range body["attributes"] {
			got[k] = v["value"]
		}
		r.posts[uid] = append(r.posts[uid], got)
		w.WriteHeader(200)
	default:
		w.WriteHeader(404)
	}
}

// Attributes: only the allowlisted account is written (others are a dry
// run), only what changed, $email only where RevenueCat has none, never the
// app's attributes; a deletion clears the web_* ones once.
func TestRCAttributes(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	prev := rcAttrDebounce
	rcAttrDebounce = 0
	t.Cleanup(func() { rcAttrDebounce = prev })
	allowed, other := "u"+store.NewID(), "u"+store.NewID()
	rates := pricing.DefaultsFor("test")
	rates.RCAttrAllowUIDs = []string{allowed}
	s.Pricing = pricing.NewStatic(rates)
	stub := &rcStub{attrs: map[string]map[string]string{allowed: {"$email": "app@example.test", "newsletter": "true"}}, posts: map[string][]map[string]any{}}
	srv := httptest.NewServer(stub)
	t.Cleanup(srv.Close)
	s.RevenueCat = revenuecat.New("sk_test_fake").WithBase(srv.URL, time.Now)
	ids := newFakeIdentities()
	ids.add(allowed, "web@example.test", "google.com")
	ids.users[allowed].DisplayName = "Web Person"
	ids.add(other, "other@example.test", "apple.com")
	s.Identities = ids
	s.Store.PutCustomer(ctx, allowed, &store.Customer{StripeCustomerID: "cus_1", LifetimePaidCents: 1234, Locale: "ja"})

	s.rcAttrsTouch(ctx, allowed, "balance")
	s.rcAttrsTouch(ctx, other, "balance")
	r := httptest.NewRequest(http.MethodGet, "/v1/events", nil)
	r.Header.Set("X-Client-Geo-Country", "JP")
	r.Header.Set("CF-IPCountry", "JP")
	s.rcAttrsActive(ctx, r, allowed)
	if n := s.syncRCAttributes(ctx); n != 2 {
		t.Fatalf("synced %d", n)
	}
	if len(stub.posts[other]) != 0 {
		t.Fatal("a dry-run account was written")
	}
	if rec := s.Store.GetRCAttrSync(ctx, other); rec == nil || rec.Mode != "dry_run" || rec.DueAt != nil {
		t.Fatalf("dry run record %+v", rec)
	}
	if len(stub.posts[allowed]) != 1 {
		t.Fatalf("posts %v", stub.posts)
	}
	p := stub.posts[allowed][0]
	if p["web_email"] != "web@example.test" || p["web_display_name"] != "Web Person" || p["web_sign_in_methods"] != "email,google.com" ||
		p["web_lifetime_spend_usd"] != "12.34" || p["web_locale"] != "ja" || p["web_plan"] != "none" || p["web_credit_balance_usd"] != "0.00" ||
		p["web_last_active_at"] == nil || p["web_source"] != "web" {
		t.Fatalf("attributes %v", p)
	}
	if _, set := p["$email"]; set {
		t.Fatal("$email overwritten")
	}
	if p["$displayName"] != "Web Person" {
		t.Fatalf("$displayName where none %v", p["$displayName"])
	}
	for _, k := range []string{"newsletter", "delete_account", "locale", "free_tier_arm", "svs_simulated"} {
		if _, set := p[k]; set {
			t.Fatalf("app attribute %s written", k)
		}
	}
	for k := range p {
		if strings.Contains(strings.ToLower(k), "ip") && k != "web_sign_in_methods" {
			t.Fatalf("an IP-like attribute %s", k)
		}
	}
	// a change: only what changed
	s.Store.UpdateCustomer(ctx, allowed, func(c *store.Customer) error { c.LifetimePaidCents = 2000; return nil })
	s.rcAttrsTouch(ctx, allowed, "spend")
	s.syncRCAttributes(ctx)
	if got := stub.posts[allowed]; len(got) != 2 || len(got[1]) != 1 || got[1]["web_lifetime_spend_usd"] != "20.00" {
		t.Fatalf("only the change %v", got)
	}
	// nothing changed: nothing sent
	s.rcAttrsTouch(ctx, allowed, "balance")
	s.syncRCAttributes(ctx)
	if len(stub.posts[allowed]) != 2 {
		t.Fatalf("an unchanged sync sent %v", stub.posts[allowed][2:])
	}
	// the record keeps hashes, never the email in clear
	if rec := s.Store.GetRCAttrSync(ctx, allowed); rec == nil || strings.Contains(rec.Sent["web_email"], "@") {
		t.Fatalf("record %+v", rec)
	}
	// deletion: every web_* removed (null), nothing of the app's; once
	s.rcAttrsClear(ctx, allowed)
	s.syncRCAttributes(ctx)
	got := stub.posts[allowed]
	if len(got) != 3 || len(got[2]) != len(rcWebAttrs)-1 {
		t.Fatalf("clear %v", got)
	}
	if _, cleared := got[2]["web_source"]; cleared {
		t.Fatal("web_source cleared")
	}
	for k, v := range got[2] {
		if !strings.HasPrefix(k, "web_") || v != nil {
			t.Fatalf("clear sent %s=%v", k, v)
		}
	}
	s.rcAttrsTouch(ctx, allowed, "balance") // a late change after the deletion
	s.syncRCAttributes(ctx)
	if len(stub.posts[allowed]) != 3 {
		t.Fatal("a deleted account got attributes back")
	}
	// prod with no switch: nothing at all
	if pricing.DefaultsFor("prod").RCAttrMode("prod") != "off" {
		t.Fatal("prod default")
	}
}

// TEST reads RevenueCat only for rc_attr_allow_uids; prod reads everyone
// (no gate): creating customers there for web accounts is intended.
func TestRCReadGateByEnv(t *testing.T) {
	r := pricing.DefaultsFor("test")
	r.RCAttrAllowUIDs = []string{"qa1"}
	rates := func(context.Context) *pricing.Rates { return r }
	if RCGate("prod", rates) != nil {
		t.Fatal("prod is gated")
	}
	g := RCGate("test", rates)
	if g == nil || !g(context.Background(), "qa1") || g(context.Background(), "someone") {
		t.Fatal("test gate")
	}
	r.RCAttrAllowUIDs = nil // the default: nobody on TEST
	if g(context.Background(), "qa1") {
		t.Fatal("empty allowlist reads")
	}
}

// web_source "web" goes with an account's first attribute write, once; a
// customer that already has a web_source keeps it (never overwritten).
func TestRCWebSource(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	prev := rcAttrDebounce
	rcAttrDebounce = 0
	t.Cleanup(func() { rcAttrDebounce = prev })
	fresh, app := "u"+store.NewID(), "u"+store.NewID()
	rates := pricing.DefaultsFor("test")
	rates.RCAttrAllowUIDs = []string{fresh, app}
	s.Pricing = pricing.NewStatic(rates)
	stub := &rcStub{attrs: map[string]map[string]string{app: {"web_source": "app"}}, posts: map[string][]map[string]any{}}
	srv := httptest.NewServer(stub)
	t.Cleanup(srv.Close)
	s.RevenueCat = revenuecat.New("sk_test_fake").WithBase(srv.URL, time.Now)
	ids := newFakeIdentities()
	ids.add(fresh, "fresh@example.test", "email")
	ids.add(app, "app@example.test", "apple.com")
	s.Identities = ids
	for _, uid := range []string{fresh, app} {
		s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_" + uid, LifetimePaidCents: 100})
		s.rcAttrsTouch(ctx, uid, "balance")
	}
	s.syncRCAttributes(ctx)
	if p := stub.posts[fresh]; len(p) != 1 || p[0]["web_source"] != "web" {
		t.Fatalf("fresh %v", p)
	}
	if p := stub.posts[app]; len(p) != 1 || p[0]["web_source"] != nil {
		t.Fatalf("existing web_source overwritten %v", p)
	}
	if _, set := stub.posts[app][0]["web_source"]; set {
		t.Fatal("web_source sent over the existing one")
	}
	// later changes never send it again
	for _, uid := range []string{fresh, app} {
		s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error { c.LifetimePaidCents = 500; return nil })
		s.rcAttrsTouch(ctx, uid, "spend")
	}
	s.syncRCAttributes(ctx)
	for _, uid := range []string{fresh, app} {
		got := stub.posts[uid]
		if len(got) != 2 {
			t.Fatalf("%s posts %v", uid, got)
		}
		if _, set := got[1]["web_source"]; set {
			t.Fatalf("%s web_source sent again %v", uid, got[1])
		}
	}
}
