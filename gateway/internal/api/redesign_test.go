package api

import (
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

// S3D-21: the balance block is always there.
func TestBalanceEntry(t *testing.T) {
	none := balanceEntry(nil, 5000, "usd")
	if none["amount_cents"] != int64(0) || none["due_at"] != nil || none["cap_cents"] != int64(5000) {
		t.Errorf("no open batch: %v", none)
	}
	due := time.Date(2026, 11, 3, 6, 0, 0, 0, time.UTC)
	open := balanceEntry(&store.Batch{TotalCents: 1240, DueAt: due, CapCents: 15000, Currency: "usd"}, 5000, "usd")
	if open["amount_cents"] != int64(1240) || open["due_at"] != due || open["cap_cents"] != int64(15000) {
		t.Errorf("open batch: %v", open)
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

// S3D-01/30/44: switching is one way, classic → lifelike.
func TestMethodSwitchOneWay(t *testing.T) {
	if e := methodSwitchError(store.MethodLifelike, store.MethodClassic); e == nil || e.Code != "method_switch_not_allowed" || e.Status != 400 {
		t.Errorf("lifelike → classic must be refused: %v", e)
	}
	for _, c := range [][2]string{
		{store.MethodClassic, store.MethodLifelike},
		{store.MethodLifelike, store.MethodLifelike},
		{store.MethodClassic, store.MethodClassic},
	} {
		if e := methodSwitchError(c[0], c[1]); e != nil {
			t.Errorf("%s → %s: %v", c[0], c[1], e)
		}
	}
	// records without a method are classic, so they may move to lifelike
	if e := methodSwitchError(store.MethodOr(""), store.MethodLifelike); e != nil {
		t.Errorf("legacy project → lifelike: %v", e)
	}
}
