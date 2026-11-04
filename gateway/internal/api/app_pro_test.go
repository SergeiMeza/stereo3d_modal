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
		av                   *store.AppViewing
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
	if got := fmt.Sprint(rep["by_variant"]); !strings.Contains(got, "map[count:1 device:avp variant:app_pro]") ||
		!strings.Contains(got, "map[count:1 device:avp variant:default]") || !strings.Contains(got, "map[count:1 device:quest variant:default]") {
		t.Fatalf("by_variant %s", got)
	}
}
