package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/revenuecat"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// rcWith serves one subscriber: a "pro" entitlement on product, bought in
// storeName (plus a business entitlement when plan is set).
func rcWith(t *testing.T, product, storeName, plan string) *revenuecat.Client {
	t.Helper()
	exp := time.Now().Add(20 * 24 * time.Hour).UTC().Format(time.RFC3339)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		ents := map[string]any{"pro": map[string]any{"expires_date": exp, "product_identifier": product}}
		if plan != "" {
			ents[plan] = map[string]any{"expires_date": exp, "product_identifier": "rc_promo_" + plan}
		}
		subs := map[string]any{product: map[string]any{"purchase_date": time.Now().UTC().Format(time.RFC3339), "expires_date": exp, "store": storeName}}
		json.NewEncoder(w).Encode(map[string]any{"subscriber": map[string]any{"entitlements": ents, "subscriptions": subs}})
	}))
	t.Cleanup(srv.Close)
	return revenuecat.New("sk_test_fake").WithBase(srv.URL, time.Now)
}

func TestAppProVariant(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	for _, tc := range []struct {
		product, store, plan string
		ourGrant             bool
		want                 bool
	}{
		{"svs_pro_monthly", "app_store", "", false, true},
		{"svs_pro_yearly_mac", "mac_app_store", "", false, true},
		{"rc_promo_pro_monthly", "promotional", "", false, true}, // e.g. the app's campaign
		{"rc_promo_pro_monthly", "promotional", "", true, false}, // ours, beside a web plan
		{"web_pro_monthly", "rc_billing", "", false, false},
		{"web_pro_monthly", "stripe", "", false, false},
		{"svs_pro_monthly", "app_store", "business", false, false}, // Pro with Business
	} {
		s.RevenueCat = rcWith(t, tc.product, tc.store, tc.plan)
		uid := "u" + store.NewID()
		cust := &store.Customer{StripeCustomerID: "cus_1"}
		if tc.ourGrant {
			until := time.Now().Add(10 * 24 * time.Hour)
			cust.Plan = &store.Plan{Tier: "business", RCGrantedUntil: &until}
		}
		if got := s.appPro(ctx, uid, cust); got != tc.want {
			t.Errorf("%s/%s plan=%q ours=%v: %v", tc.product, tc.store, tc.plan, tc.ourGrant, got)
		}
	}
}

// simulate_app_pro: test only; the account reads as app Pro for the
// variant and is priced at Pro; prod refuses it.
func TestSimulateAppPro(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1", CreatedAt: sampleSince.Add(time.Hour)})
	settings := func(method, body string) (int, map[string]any) {
		return callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleAccountSettings(w, r, &AuthedUser{UID: uid}) }, method, body)
	}
	_, out := settings("GET", "")
	ob := out["onboarding"].(map[string]any)
	if ob["variant"] != "default" || ob["app_pro_welcome_done"] != false || fmt.Sprint(ob["headsets_from_app"]) != "[]" ||
		ob["headsets_from_app_source"] != nil || ob["app_viewing_device"] != nil {
		t.Fatalf("default %v", ob)
	}
	if s.accountTier(ctx, uid).Tier != "" {
		t.Fatal("tier before")
	}
	code, out := settings("PATCH", `{"simulate_app_pro":true,"onboarding":{"app_pro_welcome_done":true}}`)
	ob = out["onboarding"].(map[string]any)
	if code != 200 || ob["variant"] != "app_pro" || ob["app_pro_welcome_done"] != true {
		t.Fatalf("simulated %d %v", code, out)
	}
	if at := s.accountTier(ctx, uid); at.Tier != pricing.TierPro || at.AllowanceKey != "pro_monthly" {
		t.Fatalf("tier %+v", at)
	}
	settings("PATCH", `{"simulate_app_pro":false}`)
	if _, out := settings("GET", ""); out["onboarding"].(map[string]any)["variant"] != "default" {
		t.Fatal("switched off")
	}
	s.Cfg = &config.Config{Env: "prod"}
	if code, out := settings("PATCH", `{"simulate_app_pro":true}`); code != 403 || out["error"] != "test_only" {
		t.Fatalf("prod %d %v", code, out)
	}
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error { c.SimulateAppPro = true; return nil })
	if s.accountTier(ctx, uid).Tier != "" {
		t.Fatal("a stored switch must not count on prod")
	}
}

func TestHeadsetsFromApp(t *testing.T) {
	for _, tc := range []struct {
		av                  *store.AppViewing
		ids, source, answer string
	}{
		{nil, "[]", "", ""},
		{&store.AppViewing{ViewingDevice: "appleVisionPro", Answered: true}, "[avp]", "app_answer", "apple_vision_pro"},
		{&store.AppViewing{ViewingDevice: "otherHeadset", Answered: true}, "[]", "", "other_headset"},
		{&store.AppViewing{ViewingDevice: "screenOnly", Answered: true, UsedDevices: []string{"RealityDevice14,1"}}, "[avp]", "app_device", "screen_only"},
		{&store.AppViewing{ViewingDevice: "appleVisionPro", Answered: false, UsedDevices: []string{"iPhone16,2"}}, "[]", "", ""},
	} {
		ids, source, answer := headsetsFromApp(tc.av)
		if fmt.Sprint(ids) != tc.ids || source != tc.source || answer != tc.answer {
			t.Errorf("%+v: %v %q %q", tc.av, ids, source, answer)
		}
	}
}

func TestOnboardingVariantEvents(t *testing.T) {
	s, _ := e0Service(t)
	uid := "u" + store.NewID()
	post := func(body string) int {
		code, _ := callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleEvents(w, r, &AuthedUser{UID: uid}) }, "POST", body)
		return code
	}
	if post(`{"name":"onboarding_headsets","props":{"devices":["avp"],"variant":"vip"}}`) != 400 {
		t.Fatal("bad variant")
	}
	if post(`{"name":"onboarding_headsets","props":{"devices":["avp"],"variant":"app_pro"}}`) != 200 {
		t.Fatal("app_pro variant")
	}
	ev := func(uid, variant string, devices ...any) store.Event {
		props := map[string]any{"devices": devices}
		if variant != "" {
			props["variant"] = variant
		}
		return store.Event{UID: uid, Name: "onboarding_headsets", At: time.Now(), Props: props}
	}
	rep := s.headsetReport(context.Background(), []store.Event{ev("a", "app_pro", "avp"), ev("a", "app_pro", "avp"), ev("b", "", "avp", "quest")})
	if got := fmt.Sprint(rep["by_variant"]); !strings.Contains(got, "map[converted:0 count:1 device:avp variant:app_pro]") ||
		!strings.Contains(got, "map[converted:0 count:1 device:avp variant:default]") || !strings.Contains(got, "map[converted:0 count:1 device:quest variant:default]") {
		t.Fatalf("by_variant %s", got)
	}
}

// GET /v1/pro names the Pro holder's free previews from our own table.
func TestProStatusFreePreviews(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	s.RevenueCat = rcWith(t, "svs_pro_weekly", "app_store", "")
	uid := "u" + store.NewID()
	get := func() map[string]any {
		_, out := callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleProStatus(w, r, &AuthedUser{UID: uid}) }, "GET", "")
		return out
	}
	out := get()
	fp, _ := out["free_previews"].(map[string]any)
	want := s.rates(ctx).FreePreviewAllowance("pro_weekly")
	if out["pro"] != true || fp["allowance"] != "pro_weekly" || fp["period"] != "week" || fp["per_period"] != float64(want) {
		t.Fatalf("weekly %v (want %d)", out, want)
	}
	s.RevenueCat = revenuecat.New("") // not configured: nothing known
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1", SimulateAppPro: true})
	if out := get(); out["via"] != "simulated_app_pro" || out["free_previews"].(map[string]any)["allowance"] != "pro_monthly" {
		t.Fatalf("simulated %v", out)
	}
}

// GET /v1/pro names where Pro comes from, its period and when it renews
// or ends (QA batch 3, 2026-11-05), and never the RevenueCat app user id.
func TestProStatusSourceAndTerms(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	uid := "u" + store.NewID()
	get := func() map[string]any {
		_, out := callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleProStatus(w, r, &AuthedUser{UID: uid}) }, "GET", "")
		return out
	}
	for _, tc := range []struct {
		product, store, source, period string
		renews                         bool
	}{
		{"svs_pro_monthly", "app_store", "app_store", "monthly", true},
		{"svs_pro_yearly_mac", "mac_app_store", "mac_app_store", "yearly", true},
		{"svs_pro_weekly", "app_store", "app_store", "weekly", true},
		{"web_pro_monthly", "rc_billing", "web", "monthly", true},
		{"rc_promo_pro_monthly", "promotional", "grant", "", false},
	} {
		s.RevenueCat = rcWith(t, tc.product, tc.store, "")
		out := get()
		if out["source"] != tc.source || out["period"] != tc.period && !(tc.period == "" && out["period"] == nil) {
			t.Errorf("%s: %v", tc.product, out)
		}
		if tc.renews && (out["renews_at"] == nil || out["ends_at"] != nil) || !tc.renews && (out["ends_at"] == nil || out["renews_at"] != nil) {
			t.Errorf("%s dates: %v", tc.product, out)
		}
		if (tc.source == "app_store" || tc.source == "mac_app_store") && out["management_url"] == nil {
			t.Errorf("%s: no management url", tc.product)
		}
		if _, err := time.Parse(time.RFC3339, firstString(out["renews_at"], out["ends_at"])); err != nil {
			t.Errorf("%s: date not ISO 8601: %v", tc.product, out)
		}
		raw, _ := json.Marshal(out)
		if strings.Contains(string(raw), uid) || strings.Contains(string(raw), "app_user_id") {
			t.Errorf("%s: leaks the id %s", tc.product, raw)
		}
	}
	// a cancelled App Store subscription ends rather than renews
	exp := time.Now().Add(9 * 24 * time.Hour).UTC().Format(time.RFC3339)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"subscriber": map[string]any{
			"entitlements":  map[string]any{"pro": map[string]any{"expires_date": exp, "product_identifier": "svs_pro_monthly"}},
			"subscriptions": map[string]any{"svs_pro_monthly": map[string]any{"purchase_date": time.Now().UTC().Format(time.RFC3339), "expires_date": exp, "store": "app_store", "unsubscribe_detected_at": time.Now().UTC().Format(time.RFC3339)}},
		}})
	}))
	t.Cleanup(srv.Close)
	s.RevenueCat = revenuecat.New("sk_test_fake").WithBase(srv.URL, time.Now)
	if out := get(); out["ends_at"] != exp || out["renews_at"] != nil || out["period"] != "monthly" {
		t.Fatalf("cancelled %v", out)
	}
	// a support grant's end comes from our grant record
	s.RevenueCat = rcWith(t, "rc_promo_pro_monthly", "promotional", "")
	end := time.Now().Add(60 * 24 * time.Hour).UTC().Truncate(time.Second)
	s.Store.CreateAdminGrant(ctx, &store.AdminGrant{ID: store.NewID(), UID: uid, Entitlement: "pro", EndsAt: end, State: "granted", CreatedAt: time.Now()})
	if out := get(); out["source"] != "grant" || out["ends_at"] != end.Format(time.RFC3339) {
		t.Fatalf("grant %v", out)
	}
}

func firstString(vs ...any) string {
	for _, v := range vs {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}
