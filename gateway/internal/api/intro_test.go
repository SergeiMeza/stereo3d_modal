package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func TestNormalizeLocale(t *testing.T) {
	for in, want := range map[string]string{"ja-JP,ja;q=0.9,en;q=0.8": "ja", "pt-BR": "pt-BR", "pt-PT": "pt-PT", "zh-CN": "zh-Hans",
		"zh-TW": "zh-Hant", "zh-Hant-HK": "zh-Hant", "en-US,en;q=0.9": "en", "de": "de", "": "", "!!": ""} {
		if got := normalizeLocale(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

// BL-25: flag off → no intro fields; on → 3 s previews, 4 s otherwise, in
// the account's or the browser's language; a Business/Studio plan's
// opt-out sends 0, the setting is ignored without a plan; the intro never
// changes a quote (so neither a hold nor a charge, which use the quote).
func TestLifelikeIntro(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	rates := pricing.DefaultsFor("test")
	s.Pricing = pricing.NewStatic(rates)
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1", LifelikeIntroOff: true})
	r := httptest.NewRequest("POST", "/", nil)
	r.Header.Set("Accept-Language", "zh-TW,zh;q=0.9")

	var off store.Params
	s.applyIntro(ctx, r, uid, store.StepProduction, &off)
	body := lifelikeBody(&store.Conversion{Method: store.MethodLifelike, Params: off}, 4)
	if _, ok := body["intro_s"]; ok || off.IntroS != nil {
		t.Fatal("flag off: no intro fields")
	}

	rates.LifelikeIntroEnabled = true
	var prod, prev store.Params
	s.applyIntro(ctx, r, uid, store.StepProduction, &prod) // opt-out set, but no plan: ignored
	s.applyIntro(ctx, r, uid, store.StepLifelikePreview, &prev)
	if *prod.IntroS != 4 || *prev.IntroS != 3 || prod.IntroLanguage != "zh-Hant" {
		t.Fatalf("intro %v %v %q", *prod.IntroS, *prev.IntroS, prod.IntroLanguage)
	}
	body = lifelikeBody(&store.Conversion{Method: store.MethodLifelike, Params: prod}, 4)
	if body["intro_s"] != 4 || body["intro_language"] != "zh-Hant" {
		t.Fatalf("body %v", body)
	}

	// An active Business plan with the opt-out: 0; the saved locale wins.
	end := time.Now().Add(20 * 24 * time.Hour)
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		c.Plan = &store.Plan{Tier: "business", SubscriptionID: "sub_1", Status: "active", CurrentPeriodEnd: &end}
		c.Locale = "ja"
		return nil
	})
	var optOut store.Params
	s.applyIntro(ctx, r, uid, store.StepProduction, &optOut)
	if *optOut.IntroS != 0 || optOut.IntroLanguage != "ja" {
		t.Fatalf("opt-out %v %q", *optOut.IntroS, optOut.IntroLanguage)
	}

	// Quotes are the customer's own length, intro or not.
	p := lifelikeProject()
	base := resolveOKP(t, &stepConvReq{Step: store.StepProduction, Preset: "4k"}, p)
	with := base
	s.applyIntro(ctx, r, uid, store.StepProduction, &with)
	q1, _, e1 := s.quoteStep(ctx, p, base, store.StepProduction, 0)
	q2, _, e2 := s.quoteStep(ctx, p, with, store.StepProduction, 0)
	if e1 != nil || e2 != nil || q1.AmountCents != q2.AmountCents || q1.AmountCents <= 0 {
		t.Fatalf("quotes %v %v %v %v", q1, q2, e1, e2)
	}
}

// GET/PATCH /v1/account/settings: lifelike_intro only with a plan.
func TestAccountSettings(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	call := func(method, body string) (int, map[string]any) {
		rec := httptest.NewRecorder()
		s.HandleAccountSettings(rec, httptest.NewRequest(method, "/", strings.NewReader(body)), &AuthedUser{UID: uid})
		var out map[string]any
		json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	if code, out := call("GET", ""); code != 200 || out["lifelike_intro"] != true || out["lifelike_intro_editable"] != false || out["locale"] != nil {
		t.Fatalf("get %d %v", code, out)
	}
	if code, out := call("PATCH", `{"lifelike_intro":false}`); code != http.StatusConflict || out["error"] != "plan_required" {
		t.Fatalf("no plan %d %v", code, out)
	}
	if code, out := call("PATCH", `{"locale":"pt_BR"}`); code != 200 || out["locale"] != "pt-BR" {
		t.Fatalf("locale %d %v", code, out)
	}
	end := time.Now().Add(20 * 24 * time.Hour)
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		c.Plan = &store.Plan{Tier: "studio", SubscriptionID: "sub_2", Status: "active", CurrentPeriodEnd: &end}
		return nil
	})
	if code, out := call("PATCH", `{"lifelike_intro":false,"locale":null}`); code != 200 || out["lifelike_intro"] != false || out["lifelike_intro_editable"] != true || out["locale"] != nil {
		t.Fatalf("plan %d %v", code, out)
	}
}
