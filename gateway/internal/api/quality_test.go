package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The web's quality tiers (owner 2026-11-07): standard free and capped,
// high and master target rates, master 10-bit; old clients mapped; API
// callers without a choice keep the pipeline default.
func TestQualityTiers(t *testing.T) {
	ctx := context.Background()
	s := &Service{Pricing: pricing.NewStatic(pricing.DefaultsFor("test"))}
	p := lifelikeProject() // 3840×2160
	resolve := func(body string, web bool) store.Params {
		t.Helper()
		var req stepConvReq
		if err := json.Unmarshal([]byte(body), &req); err != nil {
			t.Fatal(err)
		}
		req.web = web
		params, err := s.resolveParams(ctx, &req, p)
		if err != nil {
			t.Fatalf("%s: %v", body, err)
		}
		return params
	}
	std := resolve(`{"step":"production","preset":"1080p"}`, true)
	if std.OutputQuality != "standard" || std.MaxBitrateBps != 25_000_000 || std.OutputBitrateBps != 0 {
		t.Fatalf("web default %+v", std)
	}
	if b := lifelikeBody(&store.Conversion{Params: std}, 4); b["max_bitrate_bps"] != int64(25_000_000) || b["output_bitrate_bps"] != nil {
		t.Fatalf("standard body %v", b)
	}
	if api := resolve(`{"step":"production","preset":"1080p"}`, false); api.OutputQuality != "" || api.MaxBitrateBps != 0 || api.OutputBitrateBps != 0 {
		t.Fatalf("an API caller keeps the pipeline default %+v", api)
	}
	high := resolve(`{"step":"production","preset":"4k","quality":"high"}`, true)
	if high.OutputQuality != "high" || high.OutputBitrateBps != 80_000_000 || high.BitDepth != 0 {
		t.Fatalf("high %+v", high)
	}
	master := resolve(`{"step":"production","preset":"4k","quality":"master"}`, true)
	if master.OutputQuality != "master" || master.OutputBitrateBps != 150_000_000 || master.BitDepth != 10 || master.Bitrate != bitrateMaster {
		t.Fatalf("master %+v", master)
	}
	if b := lifelikeBody(&store.Conversion{Params: master}, 4); b["output_bit_depth"] != 10 || b["output_bitrate_bps"] != int64(150_000_000) {
		t.Fatalf("master body %v", b)
	}
	if old := resolve(`{"step":"production","preset":"4k","bitrate":"master"}`, true); old.OutputQuality != "master" || old.OutputBitrateBps != 150_000_000 {
		t.Fatalf("legacy master %+v", old)
	}
	if ms := resolve(`{"step":"production","preset":"1080p","bitrate":"match_source"}`, true); ms.OutputQuality != "standard" || ms.OutputBitrateBps != 0 {
		t.Fatalf("match_source %+v", ms)
	}
	if n := resolve(`{"step":"production","preset":"1080p","bitrate":40}`, true); n.OutputQuality != "" || n.OutputBitrateBps != 40_000_000 {
		t.Fatalf("a number keeps today's %+v", n)
	}
	var bad stepConvReq
	json.Unmarshal([]byte(`{"step":"production","preset":"1080p","quality":"ultra"}`), &bad)
	if _, err := s.resolveParams(ctx, &bad, p); err == nil || err.Code != "invalid_request" {
		t.Fatalf("bad quality %v", err)
	}
	// 60 fps: standard and high ×1.4 (here with a plan-free cap at 30 fps, so a 60 fps source runs at 30)
	hfr := lifelikeProject()
	hfr.Probe.FPS, hfr.Probe.FPSRational = 60, "60/1"
	var hreq stepConvReq
	json.Unmarshal([]byte(`{"step":"production","preset":"1080p","quality":"high","target_fps":30}`), &hreq)
	hreq.web = true
	if hp, err := s.resolveParams(ctx, &hreq, hfr); err != nil || hp.OutputBitrateBps != 40_000_000 {
		t.Fatalf("capped to 30 fps: no ×1.4 %+v %v", hp, err)
	}
	// the quote's block
	qv := s.qualityView(ctx, high, 60)
	if qv["tier"] != "high" || qv["mbps"] != 80.0 || qv["price_pct"] != 0.3 || qv["label"] != "High quality +30%" || qv["estimated_size_bytes"] != int64(600_000_000) {
		t.Fatalf("high view %v", qv)
	}
	sv := s.qualityView(ctx, std, 60)
	if sv["max_mbps"] != 25.0 || sv["mbps"] != 12.5 || sv["price_pct"] != 0.0 || sv["approx"] != true {
		t.Fatalf("standard view %v", sv)
	}
}

// Through the quote: a web request (our origin) gets standard free by
// default and high at +30%, with the quality block and breakdown line.
func TestQuoteQualityWeb(t *testing.T) {
	s, _, uid := splitFixture(t, 0)
	ctx := context.Background()
	s.Cfg.CORSOrigins = []string{"https://www.stereo3d.studio"}
	p := barsProject(3840, 2160, "3840:2160:0:0")
	p.ID, p.UID, p.Source.GCSKey, p.Analyze.State = store.NewID(), uid, "stereo3d/test/uploads/x.mp4", store.AnalyzeSucceeded
	p.Scenes = &store.Scenes{Version: 1, Cuts: []int{}}
	s.Store.CreateProject(ctx, p)
	quote := func(body string) map[string]any {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		r.Header.Set("Origin", "https://www.stereo3d.studio")
		w := httptest.NewRecorder()
		s.HandleQuoteStep(w, r, &AuthedUser{UID: uid}, p.ID)
		var out map[string]any
		json.Unmarshal(w.Body.Bytes(), &out)
		if w.Code != 200 {
			t.Fatalf("quote %d %s", w.Code, w.Body)
		}
		return out
	}
	std := quote(`{"step":"production","preset":"4k"}`)
	if q := std["quality"].(map[string]any); q["tier"] != "standard" || q["max_mbps"] != 40.0 || std["quote"].(map[string]any)["amount_cents"] != float64(1600) {
		t.Fatalf("standard %v %v", std["quality"], std["quote"])
	}
	high := quote(`{"step":"production","preset":"4k","quality":"high"}`)
	bd := high["quote"].(map[string]any)["breakdown"].(map[string]any)
	if high["quote"].(map[string]any)["amount_cents"] != float64(2080) || bd["quality_label"] != "High quality +30%" || high["quality"].(map[string]any)["mbps"] != 80.0 {
		t.Fatalf("high %v %v", high["quote"], high["quality"])
	}
}

// The launch offer reaches a web run's quote at 1080p and 1440p; an app
// caller's quote and a 4K run get nothing.
func TestCampaignQuote(t *testing.T) {
	ctx := context.Background()
	s := &Service{Pricing: pricing.NewStatic(pricing.DefaultsFor("test"))}
	p := lifelikeProject()
	quote := func(body string, web bool) map[string]any {
		t.Helper()
		var req stepConvReq
		json.Unmarshal([]byte(body), &req)
		req.web = web
		params, err := s.resolveParams(ctx, &req, p)
		if err != nil {
			t.Fatal(err)
		}
		q, _, qerr := s.quoteStep(ctx, p, params, store.StepProduction, 0)
		if qerr != nil {
			t.Fatal(qerr)
		}
		return q.Breakdown
	}
	if bd := quote(`{"step":"production","preset":"qhd"}`, true); bd["campaign_cents"].(int64) <= 0 || bd["campaign_label"] != "Launch offer −25%" {
		t.Fatalf("web qhd %v", bd)
	}
	if bd := quote(`{"step":"production","preset":"1080p","quality":"master"}`, true); bd["campaign_cents"].(int64) <= 0 {
		t.Fatalf("web 1080p master %v", bd)
	}
	if bd := quote(`{"step":"production","preset":"qhd"}`, false); bd["campaign_cents"] != int64(0) {
		t.Fatalf("app %v", bd)
	}
	if bd := quote(`{"step":"production","preset":"4k"}`, true); bd["campaign_cents"] != int64(0) {
		t.Fatalf("4k %v", bd)
	}
	c := &store.Conversion{Quote: store.Quote{Breakdown: map[string]any{"campaign_cents": int64(120)}}}
	if adminRunJSON(c)["campaign_cents"] != int64(120) {
		t.Fatal("admin line")
	}
	c.Quote.Breakdown["campaign_label"] = "Launch offer −25%"
	if it := itemFor(c, ""); it.CampaignCents != 120 || it.CampaignLabel != "Launch offer −25%" {
		t.Fatalf("history item %+v", it)
	}
	if l := s.runLabel(ctx, c); !strings.HasSuffix(l, "Launch offer −25%") {
		t.Fatalf("payment description %q", l)
	}
}
