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
	if body.Methods.Lifelike.Production["1080p"] != 450 || body.Methods.Lifelike.PerFrame["4k"] != 0.6944 || body.Precharge != 2500 {
		t.Errorf("body: %s", w.Body)
	}
}

// S3D-01/30/44: classic → lifelike any time; lifelike → classic only
// before the first paid run.
func TestMethodSwitchRule(t *testing.T) {
	run := func(state string, captured int64) *store.Conversion {
		return &store.Conversion{State: state, Stripe: store.Stripe{CapturedCents: captured}}
	}
	free := []*store.Conversion{
		run(store.StateFailed, 0),   // failed before any charge
		run(store.StateCanceled, 0), // canceled in line, never charged
		run(store.StateExpired, 0),  // 3DS never completed
	}
	if e := methodSwitchError(store.MethodLifelike, store.MethodClassic, nil); e != nil {
		t.Errorf("a new lifelike project may go back: %v", e)
	}
	if e := methodSwitchError(store.MethodLifelike, store.MethodClassic, free); e != nil {
		t.Errorf("runs that never charged don't count: %v", e)
	}
	for _, paid := range []*store.Conversion{
		run(store.StateSucceeded, 0),   // batched preview
		run(store.StateProcessing, 0),  // running, billed after
		run(store.StatePaid, 4000),     // pre-charged, waiting to submit
		run(store.StateCanceled, 4000), // pre-charged then refunded: was paid
		run(store.StateCreated, 0),     // awaiting 3DS on a pre-charge
	} {
		e := methodSwitchError(store.MethodLifelike, store.MethodClassic, append(free, paid))
		if e == nil || e.Code != "method_switch_not_allowed" || e.Status != 400 {
			t.Errorf("%s/%d must lock the project on lifelike: %v", paid.State, paid.Stripe.CapturedCents, e)
		}
	}
	paid := []*store.Conversion{run(store.StateSucceeded, 900)}
	if e := methodSwitchError(store.MethodClassic, store.MethodLifelike, paid); e != nil {
		t.Errorf("classic → lifelike after paid runs: %v", e)
	}
	if e := methodSwitchError(store.MethodOr(""), store.MethodLifelike, paid); e != nil {
		t.Errorf("legacy project → lifelike: %v", e)
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
	params := resolveOKP(t, &stepConvReq{Step: store.StepProduction, Preset: "1080p", Foveation: "static"}, p)
	if params.Foveation != "static" {
		t.Fatalf("%+v", params)
	}
	if b := lifelikeBody(&store.Conversion{Params: params}, 4); b["foveation"] != "static" {
		t.Errorf("body: %v", b)
	}
	llResolveErr(t, &stepConvReq{Step: store.StepProduction, Preset: "4k", Foveation: "static"}, p, "invalid_request", "below")
	llResolveErr(t, &stepConvReq{Step: store.StepProduction, Preset: "1080p", Foveation: "dynamic"}, p, "invalid_request", "static")
	scope := lifelikeProject()
	scope.Probe.Width, scope.Probe.Height = 3840, 1606
	llResolveErr(t, &stepConvReq{Step: store.StepProduction, Preset: "full", Foveation: "static"}, scope, "invalid_request", "below")
	llResolveErr(t, &stepConvReq{Step: store.StepProduction, Foveation: "static"}, proProject(), "invalid_request", "lifelike projects only")

	// the switch: off by default
	off := &Service{Pricing: pricing.NewStatic(nil)}
	req := &stepConvReq{Step: store.StepProduction, Preset: "1080p", Foveation: "static"}
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
	if plain.AmountCents != 450 || fov.AmountCents != 585 {
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
