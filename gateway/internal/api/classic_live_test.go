package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Classic stays live (owner 2026-11-07): on a project that ran Classic,
// a production re-export (depth and preprocess cached) quotes and starts on
// its bitrate list (auto, match_source, 40/60/100) at its own price, with
// no quality, foveation or campaign fields in the price (no launch offer
// on Classic, owner 2026-11-07), the web and the app at the same price; the
// created run carries the quoted price.
func TestClassicReexportQuoteAndStart(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	s.Cfg = &config.Config{Env: "test", CORSOrigins: []string{"https://web.example.test"}}
	modal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/reuse/lookup") {
			json.NewEncoder(w).Encode(map[string]any{"depth": map[string]any{"cached": true}, "preprocess": map[string]any{"cached": true}})
			return
		}
		w.WriteHeader(503) // never submitted in this test
	}))
	t.Cleanup(modal.Close)
	s.Modal = modalapi.New(modal.URL, "", "")
	uid := "u" + store.NewID()
	p := proProject()
	p.ID, p.UID, p.Method, p.ClassicRan = store.NewID(), uid, store.MethodClassic, true
	p.Probe.BitRate = 30_000_000
	p.Analyze.State = store.AnalyzeSucceeded
	p.Source.GCSKey = "stereo3d/test/users/" + uid + "/" + p.ID + "/source.mp4"
	if err := s.Store.CreateProject(ctx, p); err != nil {
		t.Fatal(err)
	}
	prev := &store.Conversion{ID: store.NewID(), UID: uid, ProjectID: p.ID, State: store.StateSucceeded, Kind: "video", Step: store.StepProduction}
	now := time.Now()
	prev.Modal.SubmittedAt = &now
	s.Store.CreateConversion(ctx, prev)
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_classic", DefaultPaymentMethod: "pm_card", CardBrand: "visa", CardLast4: "4242"})
	// paid from usage credit, so the start never reaches Stripe (no charge)
	exp := time.Now().Add(24 * time.Hour)
	if _, _, err := s.Store.BalanceTx(ctx, uid, func(*store.Balance) ([]store.BalanceOp, error) {
		return []store.BalanceOp{{Kind: store.EntryPlanCredit, Cents: 1_000_000, EntryID: "cg_test", Ref: "admin:test", ExpiresAt: &exp, Additive: true}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	user := &AuthedUser{UID: uid}
	call := func(h func(http.ResponseWriter, *http.Request, *AuthedUser, string), body string, web bool) (int, map[string]any) {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		if web {
			r.Header.Set("Origin", "https://web.example.test")
		}
		w := httptest.NewRecorder()
		h(w, r, user, p.ID)
		var out map[string]any
		json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	want := map[string]float64{"": 0, "auto": 0, "match_source": 3e7, "40": 4e7, "60": 6e7, "100": 1e8}
	cents := map[bool][]float64{}
	for br, bps := range want {
		for _, web := range []bool{false, true} {
			body := `{"step":"production","preset":"1080p"` + map[bool]string{true: `,"bitrate":"` + br + `"`, false: ``}[br != ""] + `}`
			code, q := call(s.HandleQuoteStep, body, web)
			if code != 200 {
				t.Fatalf("quote %s web=%v: %d %v", br, web, code, q)
			}
			bd, _ := q["breakdown"].(map[string]any)
			if bd == nil {
				if qq, ok := q["quote"].(map[string]any); ok {
					bd, _ = qq["breakdown"].(map[string]any)
				}
			}
			stages, _ := bd["reuse_stages"].([]any)
			if len(stages) != 2 || bd["quality"] != nil || bd["foveation_cents"] != float64(0) || bd["campaign_cents"] != nil {
				t.Fatalf("quote breakdown %s web=%v: %v", br, web, bd)
			}
			code, run := call(s.HandleCreateStepConversion, body, web)
			if code != 200 && code != 201 && code != 202 {
				t.Fatalf("start %s web=%v: %d %v", br, web, code, run)
			}
			id, _ := run["conversion_id"].(string)
			c, err := s.Store.GetConversion(ctx, id)
			if err != nil {
				t.Fatalf("start %s: no run (%v) %v", br, err, run)
			}
			if float64(c.Params.OutputBitrateBps) != bps || c.Params.OutputQuality != "" || c.Params.MaxBitrateBps != 0 || c.Params.BitDepth != 0 ||
				c.Params.Foveation != "" || c.Method == store.MethodLifelike {
				t.Fatalf("run params %s web=%v: %+v", br, web, c.Params)
			}
			mb := s.modalBody(c, 4)
			if bps > 0 && mb["output_bitrate_bps"] != int64(bps) || bps == 0 && mb["output_bitrate_bps"] != nil || mb["max_bitrate_bps"] != nil || mb["output_bit_depth"] != nil {
				t.Fatalf("worker body %s: %v", br, mb)
			}
			cents[web] = append(cents[web], float64(c.Quote.AmountCents))
			// out of the active limit for the next one
			s.Store.Transition(ctx, id, []string{store.StateCreated, store.StatePaid, store.StateProcessing}, func(x *store.Conversion) error {
				x.State = store.StateCanceled
				return nil
			})
		}
	}
	for _, web := range []bool{false, true} {
		for _, c := range cents[web] {
			if c != cents[web][0] {
				t.Fatalf("Classic price varied by bitrate: %v", cents)
			}
		}
	}
	if app, web := cents[false][0], cents[true][0]; web != app {
		t.Fatalf("Classic web %v and app %v differ", web, app)
	}
}

// A Classic run's changes reach the live stream as run.state and
// run.progress like any run.
func TestEventsClassicRun(t *testing.T) {
	s, srv := eventsService(t, nil)
	ctx := context.Background()
	uid := "u" + store.NewID()
	c := &store.Conversion{ID: store.NewID(), UID: uid, ProjectID: "p1", Kind: "video", Step: store.StepProduction,
		Method: store.MethodClassic, State: store.StateProcessing, Quote: store.Quote{AmountCents: 360, Currency: "usd"}}
	if err := s.Store.CreateConversion(ctx, c); err != nil {
		t.Fatal(err)
	}
	cl := openStream(t, srv, uid, "", "")
	_, snap := cl.next("snapshot", 5*time.Second)
	if runs, _ := snap["runs"].([]any); len(runs) != 1 || runs[0].(map[string]any)["method"] != "classic" {
		t.Fatalf("snapshot %v", snap)
	}
	setProgress(t, s, c.ID, 0.3)
	if _, d := cl.next("run.progress", 5*time.Second); d["run_id"] != c.ID || d["progress"] != 0.3 {
		t.Fatalf("progress %v", d)
	}
	if _, err := s.Store.Transition(ctx, c.ID, []string{store.StateProcessing}, func(x *store.Conversion) error { x.State = store.StateSucceeded; return nil }); err != nil {
		t.Fatal(err)
	}
	if _, d := cl.next("run.state", 5*time.Second); d["run_id"] != c.ID || d["state"] != store.StateSucceeded {
		t.Fatalf("state %v", d)
	}
}
