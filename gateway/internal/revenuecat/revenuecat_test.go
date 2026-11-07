package revenuecat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestProRules(t *testing.T) {
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	bodies := map[string]string{
		"sub":      `{"subscriber":{"entitlements":{"pro":{"expires_date":"2026-11-10T00:00:00Z","product_identifier":"pro_subs_1m_v1"}}}}`,
		"lapsed":   `{"subscriber":{"entitlements":{"pro":{"expires_date":"2026-11-01T00:00:00Z","product_identifier":"pro_subs_1m_v1"}}}}`,
		"grace":    `{"subscriber":{"entitlements":{"pro":{"expires_date":"2026-11-01T00:00:00Z","grace_period_expires_date":"2026-11-05T00:00:00Z","product_identifier":"pro_subs_1w_v1"}}}}`,
		"lifetime": `{"subscriber":{"entitlements":{"pro":{"expires_date":null,"product_identifier":"pro_subs_lifetime_v1"}}}}`,
		"pass":     `{"subscriber":{"entitlements":{},"non_subscriptions":{"pro_pass_3m_v1":[{"purchase_date":"2026-08-10T00:00:00Z"}]}}}`,
		"oldpass":  `{"subscriber":{"entitlements":{},"non_subscriptions":{"pro_pass_3m_v1":[{"purchase_date":"2026-07-10T00:00:00Z"}]}}}`,
		"webpass":  `{"subscriber":{"entitlements":{},"non_subscriptions":{"web_pro_pass_6m_v1":[{"purchase_date":"2026-06-01T00:00:00Z"}]}}}`,
		"trial":    `{"subscriber":{"entitlements":{"trial":{"expires_date":"2026-11-10T00:00:00Z"}}}}`,
		"none":     `{"subscriber":{"entitlements":{},"non_subscriptions":{"photo_pack":[{"purchase_date":"2026-11-01T00:00:00Z"}]}}}`,
	}
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer k" {
			w.WriteHeader(401)
			return
		}
		uid := strings.TrimPrefix(r.URL.Path, "/v1/subscribers/")
		if uid == "down" {
			w.WriteHeader(500)
			return
		}
		fmt.Fprint(w, bodies[uid])
	}))
	defer srv.Close()
	clock := now
	c := New("k").WithBase(srv.URL, func() time.Time { return clock })
	want := map[string]bool{"sub": true, "lapsed": false, "grace": true, "lifetime": true, "pass": true, "oldpass": false, "webpass": true, "trial": false, "none": false}
	for uid, pro := range want {
		st, err := c.Pro(context.Background(), uid)
		if err != nil || st.Pro != pro {
			t.Errorf("%s: %+v %v", uid, st, err)
		}
	}
	n := calls
	_, _ = c.Pro(context.Background(), "sub")
	if calls != n {
		t.Error("not cached")
	}
	clock = now.Add(11 * time.Minute)
	_, _ = c.Pro(context.Background(), "sub")
	if calls != n+1 {
		t.Error("cache outlived 10 min")
	}
	if st, err := c.Pro(context.Background(), "down"); err == nil || st.Pro {
		t.Errorf("down: %+v %v", st, err)
	}
	if _, err := New("").Pro(context.Background(), "x"); err == nil {
		t.Error("unconfigured answered")
	}
	if PassMonths("pro_pass_3m_v1") != 3 || PassMonths("web_pro_pass_6m_v1") != 6 || PassMonths("pro_subs_1m_v1") != 0 {
		t.Error("PassMonths")
	}
}

// Web plans: studio > business > pro, and a plan never reads as Pro
// Monthly's allowance.
func TestPlanTiers(t *testing.T) {
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	parse := func(raw string) Status {
		var b subscriber
		if err := json.Unmarshal([]byte(raw), &b); err != nil {
			t.Fatal(err)
		}
		return statusOf(b, now)
	}
	both := parse(`{"subscriber":{"entitlements":{
		"pro":{"expires_date":"2026-12-01T00:00:00Z","product_identifier":"prod_VYiOZAbAXiJP29"},
		"business":{"expires_date":"2026-12-01T00:00:00Z","product_identifier":"prod_VYiOG5FegIJiFK"},
		"studio":{"expires_date":"2026-12-01T00:00:00Z","product_identifier":"prod_VYiOZAbAXiJP29"}}}}`)
	if !both.Pro || both.Tier != TierStudio || both.AllowanceKey() != "studio" {
		t.Fatalf("studio wins: %+v", both)
	}
	viaPro := parse(`{"subscriber":{"entitlements":{"pro":{"expires_date":"2026-12-01T00:00:00Z","product_identifier":"prod_VYiOG5FegIJiFK"}}}}`)
	if viaPro.Tier != TierBusiness || viaPro.AllowanceKey() != "business" {
		t.Fatalf("pro through the Business product: %+v %s", viaPro, viaPro.AllowanceKey())
	}
	lapsedStudio := parse(`{"subscriber":{"entitlements":{
		"studio":{"expires_date":"2026-11-01T00:00:00Z","product_identifier":"prod_VYiOZAbAXiJP29"},
		"pro":{"expires_date":"2026-11-10T00:00:00Z","product_identifier":"pro_subs_1m_v1"}}}}`)
	if lapsedStudio.Tier != "" || lapsedStudio.AllowanceKey() != "pro_monthly" {
		t.Fatalf("lapsed studio, live Pro Monthly: %+v", lapsedStudio)
	}
	if PlanTierOf("pro_subs_1m_v1") != "" || PlanTierOf("prod_VYiOZAbAXiJP29") != TierStudio {
		t.Fatal("plan products")
	}
}

// Promotional grants: start/end in ms, a 5xx retried, a 400 on the times
// falls back to the smallest covering duration; pro is never revoked.
func TestPromotionalGrants(t *testing.T) {
	retryPauses = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond}
	var got []string
	fail500, reject := 1, false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if strings.HasSuffix(r.URL.Path, "/promotional") && fail500 > 0 {
			fail500--
			w.WriteHeader(502)
			return
		}
		if _, ok := body["end_time_ms"]; ok && reject {
			w.WriteHeader(400)
			fmt.Fprint(w, `{"message":"end_time_ms not supported"}`)
			return
		}
		got = append(got, fmt.Sprintf("%s %v", r.URL.Path, body))
		fmt.Fprint(w, `{}`)
	}))
	defer srv.Close()
	c := New("sk_test").WithBase(srv.URL, time.Now)
	start := time.Now()
	end := start.Add(33 * 24 * time.Hour)
	if err := c.GrantPromotional(context.Background(), "u1", "business", start, end); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !strings.Contains(got[0], "/v1/subscribers/u1/entitlements/business/promotional") || !strings.Contains(got[0], "end_time_ms") {
		t.Fatalf("grant %v", got)
	}
	reject = true
	if err := c.GrantPromotional(context.Background(), "u1", "pro", start, end); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got[1], "duration:two_month") {
		t.Fatalf("fallback %v", got[1])
	}
	if err := c.RevokePromotionals(context.Background(), "u1", "pro"); err == nil {
		t.Fatal("pro must never be revoked")
	}
	if err := c.RevokePromotionals(context.Background(), "u1", "studio"); err != nil || !strings.HasSuffix(strings.Fields(got[2])[0], "/entitlements/studio/revoke_promotionals") {
		t.Fatalf("revoke %v %v", err, got)
	}
	if New("appl_public").CanGrant() {
		t.Fatal("public keys can't grant")
	}
}

// The App Store product ids name their length (pro_subs_1w_v1): the free
// previews and the Pro credit read them (a weekly holder had Monthly's 20).
func TestAllowanceAndCreditKind(t *testing.T) {
	exp := time.Now().Add(time.Hour)
	for product, want := range map[string][2]string{
		"pro_subs_1w_v1":       {"pro_weekly", "pro_weekly"},
		"pro_subs_1m_v1":       {"pro_monthly", "pro_monthly"},
		"pro_subs_1y_v1":       {"pro_yearly", "pro_yearly"},
		"pro_subs_3m_v1":       {"pro_monthly", "pro_3m"},
		"pro_subs_6m_v1":       {"pro_monthly", "pro_6m"},
		"pro_pass_3m_v1":       {"pro_pass_3m", "pro_pass_3m"},
		"web_pro_subs_1w_v1":   {"pro_weekly", "pro_weekly"},
		"pro_subs_lifetime_v1": {"pro_lifetime", "pro_lifetime"},
	} {
		st := Status{Pro: true, Via: product, ExpiresAt: &exp}
		if product == "pro_subs_lifetime_v1" {
			st.ExpiresAt = nil
		}
		if got := st.AllowanceKey(); got != want[0] {
			t.Errorf("%s allowance %s, want %s", product, got, want[0])
		}
		if got := st.CreditKind(); got != want[1] {
			t.Errorf("%s credit %s, want %s", product, got, want[1])
		}
	}
}

// RevenueCat answers 201 when GET /v1/subscribers/{id} created the
// subscriber; it is a successful read like 200 (TEST logs 2026-11-07).
func TestSubscriberReadAccepts201(t *testing.T) {
	for _, code := range []int{200, 201} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(code)
			w.Write([]byte(`{"subscriber":{"entitlements":{},"subscriptions":{},"non_subscriptions":{},"subscriber_attributes":{"web_plan":{"value":"pro"}}}}`))
		}))
		c := New("k").WithBase(srv.URL, time.Now)
		if st, err := c.Pro(context.Background(), "u1"); err != nil || st.Pro {
			t.Fatalf("%d: Pro %+v %v", code, st, err)
		}
		if g, err := c.PromotionalGrants(context.Background(), "u1"); err != nil || len(g) != 0 {
			t.Fatalf("%d: grants %v %v", code, g, err)
		}
		if a, err := c.SubscriberAttributes(context.Background(), "u1"); err != nil || a["web_plan"] != "pro" {
			t.Fatalf("%d: attributes %v %v", code, a, err)
		}
		srv.Close()
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404) }))
	defer srv.Close()
	if _, err := New("k").WithBase(srv.URL, time.Now).Pro(context.Background(), "u1"); err == nil {
		t.Fatal("404 read as success")
	}
}

// The read gate (TEST): a uid it refuses is never sent to RevenueCat
// (whose subscriber read creates the customer); it reads as no app Pro,
// and the grant and attribute reads say ErrNotRead. Allowed uids read.
func TestReadGate(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Write([]byte(`{"subscriber":{"entitlements":{"pro":{"expires_date":null,"product_identifier":"lifetime"}},"subscriptions":{},"non_subscriptions":{}}}`))
	}))
	defer srv.Close()
	c := New("k").WithBase(srv.URL, time.Now)
	c.SetReadGate(func(_ context.Context, uid string) bool { return uid == "allowed" })
	ctx := context.Background()
	if st, err := c.Pro(ctx, "other"); err != nil || st.Pro {
		t.Fatalf("gated Pro %+v %v", st, err)
	}
	if _, err := c.PromotionalGrants(ctx, "other"); err != ErrNotRead {
		t.Fatalf("gated grants %v", err)
	}
	if _, err := c.SubscriberAttributes(ctx, "other"); err != ErrNotRead {
		t.Fatalf("gated attributes %v", err)
	}
	if calls != 0 {
		t.Fatalf("%d calls for a gated uid", calls)
	}
	if st, err := c.Pro(ctx, "allowed"); err != nil || !st.Pro || calls != 1 {
		t.Fatalf("allowed %+v %v calls %d", st, err, calls)
	}
}
