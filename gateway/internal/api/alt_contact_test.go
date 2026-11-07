package api

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// alt_prices are the same run at each tier, exactly what the quote gives
// an account on that tier (rounded minutes, fps, add-ons included).
func TestAltPrices(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	p := fpsProject(uid, store.MethodLifelike, 30)
	p.Probe.NumFrames, p.Probe.DurationS = 30*130, 130 // 2:10 → 3 minutes
	params, perr := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "4k", Express: true}, p)
	if perr != nil {
		t.Fatal(perr)
	}
	alt := s.altPrices(ctx, p, params, store.StepProduction, 0)
	if alt == nil || !(alt["pro"] > alt["business"] && alt["business"] > alt["studio"] && alt["studio"] > 0) {
		t.Fatalf("alt %v", alt)
	}
	end := time.Now().Add(20 * 24 * time.Hour)
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		c.Plan = &store.Plan{Tier: "business", SubscriptionID: "sub_1", Status: "active", CurrentPeriodEnd: &end}
		return nil
	})
	q, _, qerr := s.quoteStep(ctx, p, params, store.StepProduction, 0)
	if qerr != nil || q.AmountCents != alt["business"] {
		t.Fatalf("business quote %v vs alt %d (%v)", q, alt["business"], qerr)
	}
	if s.altPrices(ctx, &store.Project{Probe: p.Probe, Method: store.MethodClassic}, params, store.StepProduction, 0) != nil {
		t.Fatal("classic gets none")
	}
}

func TestContact(t *testing.T) {
	s, _ := e0Service(t)
	s.Cfg = &config.Config{Env: "test"}
	uid := "u" + store.NewID()
	post := func(body string) (int, map[string]any) {
		return callJSON(t, func(w http.ResponseWriter, r *http.Request) {
			s.HandleContact(w, r, &AuthedUser{UID: uid, Email: "ann@example.com"})
		}, "POST", body)
	}
	for _, bad := range []string{`{"topic":"sales","message":"hi"}`, `{"topic":"business","message":"  "}`,
		`{"topic":"business","message":"` + strings.Repeat("a", 2001) + `"}`, `{"topic":"studio","message":"hi","company":"` + strings.Repeat("c", 121) + `"}`} {
		if code, _ := post(bad); code != 400 {
			t.Fatalf("%.60s: %d", bad, code)
		}
	}
	for i := 0; i < contactsPerDay; i++ {
		if code, out := post(`{"topic":"business","message":"We need 40 videos a month.","company":"Acme","team_size":12}`); code != 200 || out["sent"] != true {
			t.Fatalf("send %d: %d %v", i, code, out)
		}
	}
	if code, out := post(`{"topic":"other","message":"again"}`); code != 429 || out["error"] != "rate_limited" {
		t.Fatalf("sixth %d %v", code, out)
	}
	m := s.contactMail(store.Contact{UID: uid, Email: "ann@example.com", Plan: "none", Topic: "business", Message: "hi", Company: "Acme", TeamSize: "12"})
	if m.Subject != "Spatial Video Studio: business enquiry from ann@example.com (test)" || m.ReplyTo != "ann@example.com" ||
		!strings.Contains(m.Text, "Team size: 12") {
		t.Fatalf("mail %+v", m)
	}
	if txt := contactSlack(store.Contact{UID: uid, Email: "ann@example.com", Plan: "pro", Topic: "studio", Message: "x"}); !strings.Contains(txt, uid) || !strings.Contains(txt, "plan pro") {
		t.Fatalf("slack %q", txt)
	}
}
