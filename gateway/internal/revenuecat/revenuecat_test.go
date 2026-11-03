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
