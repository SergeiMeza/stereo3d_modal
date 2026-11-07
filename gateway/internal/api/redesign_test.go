package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// S3D-42: a client that says how big the file is (and for which method)
// is refused before uploading anything over that method's cap.
func TestUploadSizeCapPerMethod(t *testing.T) {
	s, _ := uploadService(t)
	s.Pricing = pricing.NewStatic(nil)
	s.Lifelike = modalapi.New("https://x", "", "")
	h := uploadHandler(s)
	post := func(body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/v1/uploads", strings.NewReader(body))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	twelveGB := `"bytes": 12884901888`
	if w := post(`{"filename":"a.mp4","content_type":"video/mp4",` + twelveGB + `}`); w.Code != 400 || !strings.Contains(w.Body.String(), "source_too_large") {
		t.Errorf("12 GB with no method (classic, 8 GB): %d %s", w.Code, w.Body)
	}
	if w := post(`{"filename":"a.mp4","content_type":"video/mp4","method":"lifelike",` + twelveGB + `}`); w.Code != 200 {
		t.Errorf("12 GB lifelike (25 GB cap): %d %s", w.Code, w.Body)
	}
	if w := post(`{"filename":"a.mp4","content_type":"video/mp4","method":"lifelike","bytes": 30000000000}`); w.Code != 400 {
		t.Errorf("30 GB lifelike: %d %s", w.Code, w.Body)
	}
	// clients that don't say keep the old behavior (checked at project create)
	if w := post(`{"filename":"a.mp4","content_type":"video/mp4"}`); w.Code != 200 {
		t.Errorf("no size: %d %s", w.Code, w.Body)
	}
}

func TestMethodSourceErrorBytes(t *testing.T) {
	rates := pricing.Defaults()
	p := lifelikeProject()
	p.Source.Bytes = 12 << 30
	if methodSourceError(rates, p, store.MethodLifelike) != nil {
		t.Error("12 GB fits lifelike")
	}
	if e := methodSourceError(rates, p, store.MethodClassic); e == nil || e.Code != "source_too_large" {
		t.Errorf("12 GB is over classic's 8 GB: %v", e)
	} else if !strings.Contains(e.Message, "12 GB") || !strings.Contains(e.Message, "8 GB") {
		t.Errorf("message: %q", e.Message)
	}
}

// S3D-35: what a project has cost counts money taken or owed for delivered
// work, never refunded, released or uncharged runs.
func TestProjectSummary(t *testing.T) {
	run := func(state, step, pi string, quote, captured int64) *store.Conversion {
		return &store.Conversion{State: state, Step: step, Quote: store.Quote{AmountCents: quote},
			Stripe: store.Stripe{PIStatus: pi, CapturedCents: captured}}
	}
	convs := []*store.Conversion{ // newest first
		run(store.StateProcessing, store.StepProduction, store.PISucceeded, 4000, 4000), // pre-charged, running
		run(store.StateSucceeded, store.StepLifelikePreview, store.PIBatched, 50, 0),
		run(store.StateSucceeded, store.StepProduction, store.PIChargeFailed, 900, 0),
		run(store.StateFailed, store.StepProduction, store.PIRefunded, 3000, 3000),
		run(store.StateFailed, store.StepProduction, store.PICancelPending, 3000, 3000), // refund on its way
		run(store.StateCanceled, store.StepStereoPreview, store.PICanceled, 120, 0),
		run(store.StateSucceeded, store.StepStereoPreview, store.PISucceeded, 200, 180), // charged amount wins
	}
	got := summarize(convs)
	if got.LatestState != store.StateProcessing || got.LatestStep != store.StepProduction {
		t.Errorf("latest: %+v", got)
	}
	if want := int64(4000 + 50 + 900 + 180); got.SpentCents != want {
		t.Errorf("spent: want %d, got %d", want, got.SpentCents)
	}
	if empty := summarize(nil); empty.SpentCents != 0 || empty.LatestState != "" {
		t.Errorf("no runs: %+v", empty)
	}
}

// S3D-21: one customer-facing payment state per run.
func TestPaymentStatus(t *testing.T) {
	c := func(state, mode, pi string, captured, quote int64) *store.Conversion {
		return &store.Conversion{State: state, Quote: store.Quote{AmountCents: quote},
			Stripe: store.Stripe{Mode: mode, PIStatus: pi, CapturedCents: captured}}
	}
	pre, auto := store.BillingModeAutoPrecharge, store.BillingModeAuto
	cases := []struct {
		conv *store.Conversion
		want string
	}{
		{c(store.StateProcessing, pre, store.PISucceeded, 4000, 4000), "paid"}, // charged up front
		{c(store.StateSucceeded, pre, store.PISucceeded, 4000, 4000), "paid"},
		{c(store.StateFailed, pre, store.PICancelPending, 4000, 4000), "refunded"},
		{c(store.StateCanceled, pre, store.PIRefunded, 4000, 4000), "refunded"},
		{c(store.StateExpired, pre, store.PICanceled, 0, 4000), "not_charged"},
		{c(store.StateProcessing, auto, "", 0, 900), "pending"},
		{c(store.StateSucceeded, auto, store.PIBatched, 0, 900), "pending"},
		{c(store.StateSucceeded, auto, store.PIChargePending, 0, 900), "pending"},
		{c(store.StateSucceeded, auto, store.PISucceeded, 900, 900), "paid"},
		{c(store.StateSucceeded, auto, store.PIChargeFailed, 0, 900), "payment_needed"},
		{c(store.StateCanceled, auto, store.PICanceled, 0, 900), "not_charged"},
		{c(store.StateFailed, auto, store.PICancelPending, 0, 900), "not_charged"},
		{c(store.StateSucceeded, "", "", 0, 0), "not_charged"}, // free still
	}
	for i, tc := range cases {
		if got := paymentStatus(tc.conv); got != tc.want {
			t.Errorf("%d %s/%s/%s: want %s, got %s", i, tc.conv.State, tc.conv.Stripe.Mode, tc.conv.Stripe.PIStatus, tc.want, got)
		}
	}
	waiting := c(store.StateCreated, pre, "", 0, 4000)
	waiting.Stripe.ClientSecret = "secret"
	if paymentStatus(waiting) != "payment_needed" {
		t.Error("a pre-charge waiting for the bank's check needs the user")
	}
	if r := (&Service{}).conversionResponse(cases[9].conv, nil); r["payment"] != "payment_needed" {
		t.Errorf("response payment: %v", r["payment"])
	}
}

// S3D-22: a failed charge blocks new paid runs, not downloads.
func TestStepBillingError(t *testing.T) {
	overdue := httpx.Err(402, "billing_overdue", "x")
	overdue.Details = map[string]any{"unpaid_cents": int64(900)}
	got, ok := stepBillingError(overdue).(*httpx.APIError)
	if !ok || got.Code != "payment_method_needed" || got.Status != 402 || got.Details["unpaid_cents"] != int64(900) {
		t.Errorf("renamed: %+v", got)
	}
	if overdue.Code != "billing_overdue" {
		t.Error("the mobile error must not be mutated")
	}
	noCard := httpx.Err(402, "no_payment_method", "x")
	if stepBillingError(noCard) != error(noCard) {
		t.Error("other errors pass through")
	}
}

// S3D-18: the public price list, cacheable.
func TestPublicPricingRoute(t *testing.T) {
	s := &Service{Pricing: pricing.NewStatic(nil)}
	w := httptest.NewRecorder()
	s.HandlePublicPricing(w, httptest.NewRequest(http.MethodGet, "/v1/pricing", nil))
	if w.Code != 200 || !strings.Contains(w.Header().Get("Cache-Control"), "max-age") {
		t.Fatalf("%d %v", w.Code, w.Header())
	}
	var body struct {
		Methods struct {
			Lifelike struct {
				Production map[string]int64   `json:"production_cents_per_minute"`
				PerFrame   map[string]float64 `json:"preview_cents_per_frame"`
			} `json:"lifelike"`
		} `json:"methods"`
		Precharge int64 `json:"precharge_threshold_cents"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Methods.Lifelike.Production["1080p"] != 300 || body.Methods.Lifelike.PerFrame["4k"] != 0.5903 || body.Precharge != 2500 {
		t.Errorf("body: %s", w.Body)
	}
}

// S3D-01/30/44: classic → lifelike any time; lifelike → classic never.
func TestMethodSwitchOneWay(t *testing.T) {
	if e := methodSwitchError(store.MethodLifelike, store.MethodClassic); e == nil || e.Code != "method_switch_not_allowed" || e.Status != 400 {
		t.Errorf("lifelike → classic must be refused, runs or not: %v", e)
	}
	for _, c := range [][2]string{
		{store.MethodClassic, store.MethodLifelike},
		{store.MethodLifelike, store.MethodLifelike},
		{store.MethodClassic, store.MethodClassic},
		{store.MethodOr(""), store.MethodLifelike}, // legacy records are classic
	} {
		if e := methodSwitchError(c[0], c[1]); e != nil {
			t.Errorf("%s → %s: %v", c[0], c[1], e)
		}
	}
}

// S3D-12: Classic pro steps stop at 3K; the mobile one-shot keeps 4k.
func TestClassicStepsRefuse4K(t *testing.T) {
	for _, step := range []string{store.StepDepthPreview, store.StepStereoPreview, store.StepProduction} {
		llResolveErr(t, &stepConvReq{Step: step, Preset: "4k"}, proProject(), "preset_unavailable", "3K")
	}
	resolveOK(t, &stepConvReq{Step: store.StepProduction, Preset: "3k"})
	mobile := createConversionReq{GCSKey: "stereo3d/test/users/u1/abc/source.mp4", Preset: "4k"}
	if err := mobile.validate(); err != nil {
		t.Errorf("mobile 4k must stay: %v", err)
	}
	for _, p := range pricing.ClassicPresets {
		if p == "4k" {
			t.Error("4k must leave the classic preset list")
		}
	}
}

// S3D-19/S3D-23: in line = cancelable; started = one minute.
func TestCancelWindow(t *testing.T) {
	now := time.Now()
	at := func(d time.Duration) *time.Time { t := now.Add(-d); return &t }
	c := &store.Conversion{State: store.StatePaid}
	if !cancelable(c, now) {
		t.Error("not submitted yet: cancelable")
	}
	c.State = store.StateProcessing
	c.Modal.SubmittedAt = at(3 * time.Hour)
	c.Modal.WaitingForGPU = true
	if !cancelable(c, now) {
		t.Error("3 h in line with nothing started: cancelable")
	}
	// it leaves the queue: the window opens at that poll
	noteStart(c, true, false, now.Add(-30*time.Second))
	c.Modal.WaitingForGPU = false
	if c.Modal.StartedAt == nil || !cancelable(c, now) {
		t.Error("30 s after starting: cancelable")
	}
	if cancelable(c, now.Add(time.Minute)) {
		t.Error("90 s after starting: closed")
	}
	// queued again mid-run: still closed (something started)
	c.Modal.WaitingForGPU = true
	if cancelable(c, now.Add(time.Minute)) {
		t.Error("a mid-run queue doesn't reopen the window")
	}
	// a run that never queued counts from submission
	d := &store.Conversion{State: store.StateProcessing}
	d.Modal.SubmittedAt = at(20 * time.Second)
	noteStart(d, false, false, now)
	if d.Modal.StartedAt != nil || !cancelable(d, now) {
		t.Error("20 s after submit, never queued: open, start not fixed yet")
	}
	noteStart(d, false, false, now.Add(time.Minute))
	if d.Modal.StartedAt == nil || !d.Modal.StartedAt.Equal(*d.Modal.SubmittedAt) {
		t.Error("past the window without queueing: started at submission")
	}
	d.Modal.WaitingForGPU = true // a later queue doesn't reopen it
	if cancelable(d, now.Add(time.Minute)) {
		t.Error("closed")
	}
	if cancelable(&store.Conversion{State: store.StateCanceled}, now) {
		t.Error("terminal runs are not cancelable")
	}
}

// S3D-33: a canceled run tells refunded from not charged.
func TestCanceledBillingStatus(t *testing.T) {
	s := &Service{}
	refunded := s.conversionResponse(&store.Conversion{State: store.StateCanceled, ProjectID: "p",
		Stripe: store.Stripe{Mode: store.BillingModeAutoPrecharge, PIStatus: store.PIRefunded, CapturedCents: 4000, RefundedCents: 4000}}, nil)
	if b := refunded["billing"].(map[string]any); b["status"] != "refunded" || b["refunded_cents"] != int64(4000) {
		t.Errorf("refunded: %v", b)
	}
	batched := s.conversionResponse(&store.Conversion{State: store.StateCanceled, ProjectID: "p",
		Stripe: store.Stripe{Mode: store.BillingModeAuto, PIStatus: store.PICanceled}}, nil)
	if b := batched["billing"].(map[string]any); b["status"] != "not_charged" {
		t.Errorf("batched run canceled: %v", b)
	}
}

// A Lifelike job that waited 6 h in line fails as "servers busy", with the
// money back or never taken.
func TestFailureCopy(t *testing.T) {
	pre := &store.Conversion{ID: "c1", Stripe: store.Stripe{Mode: store.BillingModeAutoPrecharge, PIStatus: store.PICancelPending, CapturedCents: 4000}}
	code, msg := failureCopy(pre, "All our servers are busy right now. Please try again later.")
	if code != "servers_busy" || !strings.Contains(msg, "refunded in full") {
		t.Errorf("pre-charged: %s %q", code, msg)
	}
	auto := &store.Conversion{ID: "c2", Stripe: store.Stripe{Mode: store.BillingModeAuto, PIStatus: store.PICancelPending}}
	if code, msg := failureCopy(auto, "All our servers are busy right now. Please try again later."); code != "servers_busy" || !strings.Contains(msg, "not charged") {
		t.Errorf("batched: %s %q", code, msg)
	}
	if code, _ := failureCopy(auto, "We couldn't read this video."); code != "pipeline_failed" {
		t.Errorf("other failures: %s", code)
	}
}

// S3D-49: original_eye passes through on lifelike steps; same price.
func TestOriginalEye(t *testing.T) {
	p := lifelikeProject()
	eye := func(v string) *string { return &v }
	for _, step := range []string{store.StepProduction, store.StepLifelikePreview} {
		params := resolveOKP(t, &stepConvReq{Step: step, ToFrame: 120, OriginalEye: eye("left")}, p)
		if params.OriginalEye != "left" {
			t.Errorf("%s: %+v", step, params)
		}
		if b := lifelikeBody(&store.Conversion{Step: step, Params: params}, 4); b["original_eye"] != "left" {
			t.Errorf("%s body: %v", step, b)
		}
	}
	if params := resolveOKP(t, &stepConvReq{Step: store.StepProduction, OriginalEye: nil}, p); params.OriginalEye != "" {
		t.Error("null = both eyes rendered")
	}
	if _, ok := lifelikeBody(&store.Conversion{Params: store.Params{Preset: "4k"}}, 4)["original_eye"]; ok {
		t.Error("absent unless set")
	}
	llResolveErr(t, &stepConvReq{Step: store.StepProduction, OriginalEye: eye("center")}, p, "invalid_request", "original_eye")
	llResolveErr(t, &stepConvReq{Step: store.StepProduction, OriginalEye: eye("left")}, proProject(), "invalid_request", "lifelike projects only")
}

// S3D-50: foveation only below the source's size, behind a switch, +30%.
func TestFoveation(t *testing.T) {
	p := lifelikeProject() // 3840×2160
	params := resolveOKP(t, &stepConvReq{Step: store.StepProduction, Preset: "qhd", Foveation: fovReq("static")}, p)
	if params.Foveation != "static" {
		t.Fatalf("%+v", params)
	}
	if b := lifelikeBody(&store.Conversion{Params: params}, 4); b["foveation"] != "static" {
		t.Errorf("body: %v", b)
	}
	llResolveErr(t, &stepConvReq{Step: store.StepProduction, Preset: "4k", Foveation: fovReq("static")}, p, "invalid_request", "below")
	llResolveErr(t, &stepConvReq{Step: store.StepProduction, Preset: "qhd", Foveation: fovReq("dynamic")}, p, "invalid_request", "static")
	scope := lifelikeProject()
	scope.Probe.Width, scope.Probe.Height = 3840, 1606
	llResolveErr(t, &stepConvReq{Step: store.StepProduction, Preset: "full", Foveation: fovReq("static")}, scope, "invalid_request", "below")
	llResolveErr(t, &stepConvReq{Step: store.StepProduction, Foveation: fovReq("static")}, proProject(), "invalid_request", "lifelike projects only")

	// the switch: off by default
	off := &Service{Pricing: pricing.NewStatic(nil)}
	req := &stepConvReq{Step: store.StepProduction, Preset: "qhd", Foveation: fovReq("static")}
	if _, err := off.resolveParams(context.Background(), req, p); err == nil || err.Code != "feature_unavailable" {
		t.Errorf("foveation_enabled false: %v", err)
	}
	r := pricing.Defaults()
	r.FoveationEnabled = true
	on := &Service{Pricing: pricing.NewStatic(r)}
	if _, err := on.resolveParams(context.Background(), req, p); err != nil {
		t.Errorf("foveation_enabled true: %v", err)
	}
	// +30% on the price
	plain, _ := on.Pricing.QuoteLifelike(context.Background(), pricing.StepInputs{Step: "production", Preset: "1080p", BillableS: 60, EffectiveFPS: 24})
	fov, _ := on.Pricing.QuoteLifelike(context.Background(), pricing.StepInputs{Step: "production", Preset: "1080p", BillableS: 60, EffectiveFPS: 24, Foveated: true})
	if plain.AmountCents != 300 || fov.AmountCents != 390 {
		t.Errorf("foveation price: %d → %d", plain.AmountCents, fov.AmountCents)
	}
}

// S3D-48: a preset Lifelike doesn't render yet comes back as a clear 400.
func TestRejectSubmitCopy(t *testing.T) {
	err := (&submitRejected{Code: "preset_unavailable", Message: "5K isn't available yet; choose 4K or lower"})
	if !strings.Contains(err.Error(), "preset_unavailable") {
		t.Error(err.Error())
	}
}

func fovReq(v string) optString { return optString{Set: true, Value: &v} }

// S3D-50: with foveation switched on it's the default below the source;
// explicit null turns it off; switched off, nothing changes.
func TestFoveationDefault(t *testing.T) {
	ctx := context.Background()
	p := lifelikeProject() // 3840×2160
	on := pricing.Defaults()
	on.FoveationEnabled = true
	sOn, sOff := &Service{Pricing: pricing.NewStatic(on)}, &Service{Pricing: pricing.NewStatic(nil)}
	resolve := func(s *Service, body string) store.Params {
		t.Helper()
		var req stepConvReq
		if err := json.Unmarshal([]byte(body), &req); err != nil {
			t.Fatal(err)
		}
		params, err := s.resolveParams(ctx, &req, p)
		if err != nil {
			t.Fatalf("%s: %v", body, err)
		}
		return params
	}
	if got := resolve(sOn, `{"step":"production","preset":"1080p"}`).Foveation; got != "static" {
		t.Errorf("enabled, below the source, absent: want static, got %q", got)
	}
	if got := resolve(sOn, `{"step":"lifelike_preview","preset":"qhd","to_frame":120}`).Foveation; got != "static" {
		t.Errorf("previews too: got %q", got)
	}
	if got := resolve(sOn, `{"step":"production","preset":"qhd","foveation":null}`).Foveation; got != "" {
		t.Errorf("explicit null turns it off: got %q", got)
	}
	// 1080p: included and always on, whatever the request says (owner 2026-11-07)
	for _, body := range []string{`{"step":"production","preset":"1080p","foveation":null}`, `{"step":"production","preset":"1080p","foveation":"static"}`} {
		if got := resolve(sOn, body).Foveation; got != "static" {
			t.Errorf("%s: want static, got %q", body, got)
		}
	}
	small := lifelikeProject()
	small.Probe.Width, small.Probe.Height = 1920, 1080
	var sreq stepConvReq
	_ = json.Unmarshal([]byte(`{"step":"production","preset":"1080p","foveation":"static"}`), &sreq)
	sp, serr := sOn.resolveParams(ctx, &sreq, small)
	if serr != nil || sp.Foveation != "" {
		t.Fatalf("a 1080p source at 1080p: a no-op, never an error or a bigger render: %q %v", sp.Foveation, serr)
	}
	if v := foveationView(small, sp, store.MethodLifelike); v["applied"] != false || v["included"] != true || v["reason"] != "output_not_below_source" {
		t.Errorf("view %v", v)
	}
	if got := resolve(sOn, `{"step":"production","preset":"4k"}`).Foveation; got != "" {
		t.Errorf("at the source's own size: never, got %q", got)
	}
	if got := resolve(sOff, `{"step":"production","preset":"1080p"}`).Foveation; got != "" {
		t.Errorf("switched off: nothing changes, got %q", got)
	}
	if got := resolve(sOff, `{"step":"production","preset":"1080p","foveation":null}`).Foveation; got != "" {
		t.Errorf("switched off, null: got %q", got)
	}
	// classic accepts an explicit null (nothing to turn off)
	var req stepConvReq
	_ = json.Unmarshal([]byte(`{"step":"production","foveation":null}`), &req)
	if _, err := resolveStepParams(&req, proProject()); err != nil {
		t.Errorf("classic with foveation null: %v", err)
	}
	// its own line in the breakdown
	q, _ := sOn.Pricing.QuoteLifelike(ctx, pricing.StepInputs{Step: "production", Preset: "1080p", BillableS: 60, EffectiveFPS: 24, Foveated: true})
	if q.Breakdown["foveation_cents"] != int64(90) || q.AmountCents != 390 {
		t.Errorf("breakdown: %d %v", q.AmountCents, q.Breakdown)
	}
	pq, _ := sOn.Pricing.QuoteLifelike(ctx, pricing.StepInputs{Step: pricing.StepLifelikePreview, Preset: "4k", BillableS: 10, EffectiveFPS: 24, Foveated: true})
	if pq.Breakdown["foveation_cents"] != int64(43) || pq.AmountCents != 185 { // 142 + 43
		t.Errorf("preview breakdown: %d %v", pq.AmountCents, pq.Breakdown)
	}
}

// S3D-56: the bitrate choice, both methods, every step; same price.
func TestBitrate(t *testing.T) {
	decode := func(body string) stepConvReq {
		var req stepConvReq
		if err := json.Unmarshal([]byte(body), &req); err != nil {
			t.Fatalf("%s: %v", body, err)
		}
		return req
	}
	ll := lifelikeProject()         // 4K, 100 s
	ll.Source.Bytes = 1_250_000_000 // 100 Mbit/s over 100 s
	cases := []struct {
		body string
		want int64
	}{
		{`{"step":"production"}`, 0},
		{`{"step":"production","bitrate":"auto"}`, 0},
		{`{"step":"production","bitrate":null}`, 0},
		{`{"step":"production","bitrate":40}`, 40_000_000},
		{`{"step":"production","bitrate":"100"}`, 100_000_000},
		{`{"step":"lifelike_preview","to_frame":120,"bitrate":20}`, 20_000_000},
		{`{"step":"production","bitrate":"match_source"}`, 100_000_000}, // size × 8 / duration
	}
	for _, tc := range cases {
		req := decode(tc.body)
		params := resolveOKP(t, &req, ll)
		if params.OutputBitrateBps != tc.want {
			t.Errorf("%s: want %d, got %d", tc.body, tc.want, params.OutputBitrateBps)
		}
		b := lifelikeBody(&store.Conversion{Step: req.Step, Params: params}, 4)
		if v, ok := b["output_bitrate_bps"]; (tc.want == 0) == ok || (ok && v != tc.want) {
			t.Errorf("%s: body output_bitrate_bps %v (present %v)", tc.body, v, ok)
		}
	}
	// match_source: the analyzed stream bit_rate wins, capped at 200 Mbit/s
	ll.Probe.BitRate = 350_000_000
	req := decode(`{"step":"production","bitrate":"match_source"}`)
	if params := resolveOKP(t, &req, ll); params.OutputBitrateBps != 200_000_000 || params.Bitrate != "match_source" {
		t.Errorf("capped match_source: %+v", params)
	}
	noProbe := lifelikeProject()
	noProbe.Probe = nil
	req = decode(`{"step":"production","bitrate":"match_source"}`)
	if _, err := resolveStepParams(&req, noProbe); err == nil || err.Code != "conflict" {
		t.Errorf("match_source before analysis: %v", err)
	}
	for _, bad := range []string{`30`, `"fast"`, `0`} {
		req := decode(`{"step":"production","bitrate":` + bad + `}`)
		if _, err := resolveStepParams(&req, lifelikeProject()); err == nil {
			t.Errorf("bitrate %s must be refused", bad)
		}
	}
	// classic too, every step, into the stereo3d body (pro steps only)
	for _, step := range []string{store.StepDepthPreview, store.StepStereoPreview, store.StepProduction} {
		req := decode(`{"step":"` + step + `","bitrate":60}`)
		params := resolveOKP(t, &req, proProject())
		conv := &store.Conversion{Kind: "video", Step: step, Params: params}
		if b := (&Service{}).modalBody(conv, 8); b["output_bitrate_bps"] != int64(60_000_000) {
			t.Errorf("classic %s body: %v", step, b["output_bitrate_bps"])
		}
	}
	mobile := &store.Conversion{Kind: "video", Params: store.Params{Preset: "1080p", OutputBitrateBps: 60_000_000}}
	if _, ok := (&Service{}).modalBody(mobile, 8)["output_bitrate_bps"]; ok {
		t.Error("the mobile one-shot never sends a bitrate")
	}
	// one size estimate per file
	if got := estimatedSizeBytes(store.Params{OutputBitrateBps: 40_000_000}, 60); got != 300_000_000 {
		t.Errorf("40 Mbit/s × 60 s: %d", got)
	}
	if estimatedSizeBytes(store.Params{}, 60) != 0 {
		t.Error("auto: no estimate")
	}
}

// S3D-65: above 4K the source is always one eye.
func TestOriginalEyeRequiredAbove4K(t *testing.T) {
	all := []string{"1080p", "qhd", "3k", "4k", "5k", "6k", "8k"}
	eight := lifelikeProject()
	eight.Probe.Width, eight.Probe.Height = 8192, 4320
	for _, q := range lifelikeQualities(eight, all) {
		if want := q.LabelShortSide > 2160; q.OriginalEyeRequired != want {
			t.Errorf("%s: original_eye_required %v", q.ID, q.OriginalEyeRequired)
		}
	}
	between := lifelikeProject()
	between.Probe.Width, between.Probe.Height = 5120, 2560
	qs := lifelikeQualities(between, all)
	if last := qs[len(qs)-1]; last.ID != "full" || !last.OriginalEyeRequired {
		t.Errorf("full at 2560p: %+v", last)
	}
	eye := func(v string) *string { return &v }
	for _, tc := range []struct {
		req  *string
		want string
	}{{nil, "left"}, {eye(""), "left"}, {eye("right"), "right"}, {eye("left"), "left"}} {
		params, err := resolveLifelikeParams(&stepConvReq{Step: store.StepProduction, Preset: "8k", OriginalEye: tc.req}, eight, all)
		if err != nil || params.OriginalEye != tc.want {
			t.Errorf("8k with %v: %+v %v", tc.req, params.OriginalEye, err)
		}
	}
	// 4K and below keep it optional
	if params := resolveOKP(t, &stepConvReq{Step: store.StepProduction, Preset: "4k"}, lifelikeProject()); params.OriginalEye != "" {
		t.Errorf("4k default: %q", params.OriginalEye)
	}
	// still out of the default enabled list until the service confirms them
	if _, err := resolveStepParams(&stepConvReq{Step: store.StepProduction, Preset: "8k"}, eight); err == nil || err.Code != "preset_unavailable" {
		t.Errorf("8k not enabled by default: %v", err)
	}
}
