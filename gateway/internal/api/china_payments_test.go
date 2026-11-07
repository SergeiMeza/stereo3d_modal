package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// China payments behind china_payments_enabled (owner 2026-11-07, off at
// launch): every China-mode payment entry answers 403
// china_payments_unavailable while it's off — Alipay run pay-now, a China
// run's pay-now, hand-off Alipay, Alipay top-up, plan checkout in China
// mode and starting a paid China run. Browsing, quotes and free previews
// keep working. On, they reach the payment code as before.
func TestChinaPaymentsFlag(t *testing.T) {
	for _, on := range []bool{false, true} {
		s, _, uid := splitFixture(t, 0)
		ctx := context.Background()
		r := pricing.DefaultsFor("test")
		r.ChinaPaymentsEnabled = on
		s.Pricing = pricing.NewStatic(r)
		s.Cfg.StripePMCWeb, s.Cfg.SiteURL = "pmc_web", "https://site"
		if got := s.Pricing.Public(ctx)["china_payments"]; got != on {
			t.Fatalf("on=%v: /v1/pricing china_payments %v", on, got)
		}
		user := &AuthedUser{UID: uid, Email: "a@example.com"}
		china := func(req *http.Request) *http.Request { req.Header.Set("X-Client-Mode", "china"); return req }
		send := func(name string, h func(http.ResponseWriter, *http.Request), req *http.Request) (int, map[string]any) {
			w := httptest.NewRecorder()
			h(w, req)
			var out map[string]any
			json.Unmarshal(w.Body.Bytes(), &out)
			blocked := w.Code == http.StatusForbidden && out["error"] == "china_payments_unavailable"
			if blocked == on {
				t.Fatalf("on=%v %s: %d %v", on, name, w.Code, out)
			}
			return w.Code, out
		}
		body := func(s string) *http.Request { return httptest.NewRequest("POST", "/", strings.NewReader(s)) }

		run := createdRun(t, s, nil)
		run.UID = uid
		s.Store.Update(ctx, run)
		send("alipay pay-now", func(w http.ResponseWriter, r *http.Request) { s.HandleRunPayNow(w, r, user, run.ID) }, body(`{"method":"alipay"}`))

		cr := createdRun(t, s, nil)
		cr.UID, cr.PaymentFlow = uid, store.FlowChina
		s.Store.Update(ctx, cr)
		if !on { // a China run made while it was on can't be paid either
			send("china run pay-now", func(w http.ResponseWriter, r *http.Request) { s.HandleRunPayNow(w, r, user, cr.ID) }, body(`{}`))
		}
		code := newHandoffCode()
		ho := createdRun(t, s, nil)
		ho.UID, ho.HandoffCode = uid, code
		s.Store.Update(ctx, ho)
		if err := s.Store.CreateHandoff(ctx, &store.Handoff{Code: code, ConversionID: ho.ID, UID: uid, Email: "a@example.com", State: "waiting"}); err != nil {
			t.Fatal(err)
		}
		hreq := body(`{"method":"alipay"}`)
		hreq.SetPathValue("code", code)
		send("hand-off alipay", s.HandleHandoffPay, hreq)

		send("alipay top-up", func(w http.ResponseWriter, r *http.Request) { s.HandleTopup(w, r, user) },
			china(body(`{"amount_cents":2500,"method":"alipay"}`)))
		send("china plan", func(w http.ResponseWriter, r *http.Request) { s.HandleStartPlan(w, r, user) }, china(body(`{"plan":"pro_monthly"}`)))

		// outside China mode nothing changes
		w := httptest.NewRecorder()
		s.HandleStartPlan(w, body(`{"plan":"pro_monthly"}`), user)
		if w.Code != 200 {
			t.Fatalf("on=%v plain plan %d %s", on, w.Code, w.Body)
		}
	}
}

// Starting a paid run in China mode is refused while it's off; the quote
// and a free preview still work there.
func TestChinaRunStartFlag(t *testing.T) {
	for _, on := range []bool{false, true} {
		s, _, uid := splitFixture(t, 0)
		ctx := context.Background()
		r := pricing.DefaultsFor("test")
		r.ChinaPaymentsEnabled = on
		s.Pricing = pricing.NewStatic(r)
		s.Cfg.StripePMCWeb, s.Cfg.SiteURL = "pmc_web", "https://site"
		s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"}) // nothing saved, no credit
		lifelike := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) }))
		t.Cleanup(lifelike.Close)
		s.Lifelike = modalapi.New(lifelike.URL, "", "")
		p := barsProject(3840, 2160, "3840:2160:0:0")
		p.ID, p.UID, p.Source.GCSKey, p.Analyze.State = store.NewID(), uid, "stereo3d/test/uploads/x.mp4", store.AnalyzeSucceeded
		p.Scenes = &store.Scenes{Version: 1, Cuts: []int{}}
		s.Store.CreateProject(ctx, p)
		user := &AuthedUser{UID: uid, Email: "a@example.com"}
		call := func(h func(http.ResponseWriter, *http.Request, *AuthedUser, string), b string) (int, map[string]any) {
			req := httptest.NewRequest("POST", "/", strings.NewReader(b))
			req.Header.Set("X-Client-Mode", "china")
			w := httptest.NewRecorder()
			h(w, req, user, p.ID)
			var out map[string]any
			json.Unmarshal(w.Body.Bytes(), &out)
			return w.Code, out
		}
		prod := `{"step":"production","preset":"4k"}`
		if code, q := call(s.HandleQuoteStep, prod); code != 200 || q["payment_flow"] != store.FlowChina {
			t.Fatalf("on=%v quote %d %v", on, code, q["payment_flow"])
		}
		code, out := call(s.HandleCreateStepConversion, prod)
		if blocked := code == http.StatusForbidden && out["error"] == "china_payments_unavailable"; blocked == on {
			t.Fatalf("on=%v start %d %v", on, code, out)
		}
		if !on {
			if runs, _ := s.Store.ListUserConversions(ctx, uid, 10); len(runs) != 0 {
				t.Fatalf("a refused start left %d runs", len(runs))
			}
			// the free first preview still runs in China mode
			prev := `{"step":"lifelike_preview","preset":"4k","from_frame":0,"to_frame":120}`
			if code, q := call(s.HandleQuoteStep, prev); code != 200 || q["payment_flow"] != store.FlowFreePreview {
				t.Fatalf("preview quote %d %v", code, q["payment_flow"])
			}
			if code, out := call(s.HandleCreateStepConversion, prev); code >= 300 || out["error"] != nil {
				t.Fatalf("free preview start %d %v", code, out)
			}
		}
		time.Sleep(time.Millisecond)
	}
}
