package pricing

import (
	"context"
	"testing"
)

func defaultsService(r *Rates) *Service {
	if r == nil {
		r = defaults()
	}
	return &Service{cached: r, fetchedAt: maxTime()}
}

// Lifelike has its own price table (owner change 2026-11-03): price per
// output minute at 24 fps, no margin, no Classic multipliers or reuse.
func TestQuoteLifelikePriceTable(t *testing.T) {
	ctx := context.Background()
	s := defaultsService(nil)
	cases := []struct {
		preset string
		secs   float64
		fps    float64
		want   int64
	}{
		{"1080p", 60, 24, 450},
		{"qhd", 60, 24, 650},
		{"3k", 60, 24, 800},
		// 2 min of 4k = $20 → 10% bulk discount → $18
		{"4k", 120, 24, 1800},
		// 48 fps doubles the frames: 1 min of 1080p = $9 (under the $10 discount)
		{"1080p", 60, 48, 900},
		// a 5 s production floors at the 50¢ minimum (450 × 5/60 = 38¢)
		{"1080p", 5, 24, 50},
	}
	for _, tc := range cases {
		for _, step := range []string{"production"} { // previews are flat (TestLifelikePreviewIsFlat)
			q, err := s.QuoteLifelike(ctx, StepInputs{
				Step: step, Preset: tc.preset, BillableS: tc.secs, EffectiveFPS: tc.fps,
				ContentWidth: 3840, ContentHeight: 1608, // no depth factor on a wide source
				DepthRes: 2520, Inpaint: "none", ReuseStages: []string{"depth"}, // ignored
			})
			if err != nil {
				t.Fatal(err)
			}
			if q.AmountCents != tc.want {
				t.Errorf("%s %s %gs @%g: want %d, got %d (%v)", step, tc.preset, tc.secs, tc.fps, tc.want, q.AmountCents, q.Breakdown)
			}
			if q.Breakdown["method"] != "lifelike" || q.Breakdown["step"] != step {
				t.Errorf("breakdown must name the method and step: %v", q.Breakdown)
			}
		}
	}
}

func TestQuoteLifelikeConfigAndDraft(t *testing.T) {
	ctx := context.Background()
	r := defaults()
	r.LifelikePriceCentsPerMinute = map[string]int64{"4k": 1200} // partial doc
	s := defaultsService(r)
	if q, _ := s.QuoteLifelike(ctx, StepInputs{Step: "production", Preset: "4k", BillableS: 30, EffectiveFPS: 24}); q.AmountCents != 600 {
		t.Errorf("config price: want 600, got %d", q.AmountCents)
	}
	if q, _ := s.QuoteLifelike(ctx, StepInputs{Step: "production", Preset: "qhd", BillableS: 60, EffectiveFPS: 24}); q.AmountCents != 650 {
		t.Errorf("preset missing from the doc keeps its default: got %d", q.AmountCents)
	}
	if _, err := s.QuoteLifelike(ctx, StepInputs{Step: "production", Preset: "draft", BillableS: 60}); err == nil {
		t.Error("lifelike has no draft price")
	}
}

func TestQuoteLifelikeRejectsClassicSteps(t *testing.T) {
	if _, err := defaultsService(nil).QuoteLifelike(context.Background(), StepInputs{Step: "stereo_preview", Preset: "1080p", BillableS: 5}); err == nil {
		t.Fatal("stereo_preview is not a lifelike step")
	}
}

func TestEstimateLifelikeETA(t *testing.T) {
	ctx := context.Background()
	s := defaultsService(nil)
	// 1 minute on 4 GPUs: 45 + 530/4 + 150 = 327.5
	if got := s.EstimateLifelikeETA(ctx, LifelikeInputs{Step: "production", Preset: "4k", OutputSeconds: 60, EffectiveFPS: 24, GPUs: 4}); got != 328 {
		t.Errorf("1 min on 4 GPUs: want 328, got %d", got)
	}
	// the tail is flat: 60 min on 8 GPUs = 45 + 31,800/8 + 150 = 4170
	if got := s.EstimateLifelikeETA(ctx, LifelikeInputs{Step: "production", Preset: "1080p", OutputSeconds: 3600, EffectiveFPS: 24, GPUs: 8}); got != 4170 {
		t.Errorf("60 min on 8 GPUs: want 4170, got %d", got)
	}
	// a 5 s preview on one GPU: 45 + 530 × 120/1440 + 30 = 119
	if got := s.EstimateLifelikeETA(ctx, LifelikeInputs{Step: StepLifelikePreview, Preset: "4k", OutputSeconds: 5, EffectiveFPS: 24, GPUs: 1}); got != 119 {
		t.Errorf("5 s preview: want 119, got %d", got)
	}
	// Frames, not seconds: 48 fps doubles the render term only.
	a := s.EstimateLifelikeETA(ctx, LifelikeInputs{Step: "production", Preset: "qhd", OutputSeconds: 30, EffectiveFPS: 24, GPUs: 1})
	b := s.EstimateLifelikeETA(ctx, LifelikeInputs{Step: "production", Preset: "qhd", OutputSeconds: 30, EffectiveFPS: 48, GPUs: 1})
	if b-195 != 2*(a-195) {
		t.Errorf("48 fps should double the render term: %d vs %d", a, b)
	}
	// Config overrides take effect; zero values keep the defaults.
	r := defaults()
	r.LifelikeETA = LifelikeETA{OverheadSeconds: 100, EncodeTailSeconds: 200}
	if got := defaultsService(r).EstimateLifelikeETA(ctx, LifelikeInputs{Step: "production", Preset: "4k", OutputSeconds: 60, EffectiveFPS: 24, GPUs: 4}); got != 433 {
		t.Errorf("overrides: want 433 (100 + 132.5 + 200), got %d", got)
	}
}

func TestLifelikeConfigDefaults(t *testing.T) {
	var absent Rates // a config doc written before Lifelike: every key zero
	if absent.GPUWorkersFor("lifelike") != 4 {
		t.Errorf("lifelike workers default 4, got %d", absent.GPUWorkersFor("lifelike"))
	}
	if absent.PrechargeThreshold() != 2500 {
		t.Errorf("precharge threshold default $25, got %d", absent.PrechargeThreshold())
	}
	if absent.MaxSourceDurationFor("lifelike") != 0 {
		t.Error("lifelike is unlimited by default")
	}
	r := Rates{MaxGPUWorkers: 10, LifelikeMaxGPUWorkers: 12, MaxSourceDurationS: 600}
	if r.GPUWorkersFor("classic") != 8 || r.GPUWorkersFor("lifelike") != 8 {
		t.Error("max_gpu_workers clamps to 8 for both methods")
	}
	if r.MaxSourceDurationFor("classic") != 600 {
		t.Error("classic keeps max_source_duration_s")
	}
}

// S3D-13: a preview costs its frames at the production price per frame,
// floored at the 50¢ per-run minimum (S3D-17); no bulk discount.
func TestLifelikePreviewPerFrame(t *testing.T) {
	ctx := context.Background()
	s := defaultsService(nil)
	cases := []struct {
		preset string
		secs   float64
		fps    float64
		want   int64
	}{
		// 5 s at 24 fps: 1080p's 38¢ floors at 50; the rest are above it
		{"1080p", 5, 24, 50}, {"qhd", 5, 24, 54}, {"3k", 5, 24, 67}, {"4k", 5, 24, 83},
		// quick look at half the frame rate: half the frames (42¢ → 50)
		{"4k", 5, 12, 50},
		// 10 s of a 60 fps source: 600 frames × 1000/1440
		{"4k", 10, 60, 417},
		// 10 s 3k quick look: 120 frames × 800/1440 = 67¢
		{"3k", 10, 12, 67},
	}
	for _, tc := range cases {
		q, err := s.QuoteLifelike(ctx, StepInputs{Step: StepLifelikePreview, Preset: tc.preset, BillableS: tc.secs, EffectiveFPS: tc.fps})
		if err != nil {
			t.Fatal(err)
		}
		if q.AmountCents != tc.want {
			t.Errorf("%s %gs @%g: want %d, got %d (%v)", tc.preset, tc.secs, tc.fps, tc.want, q.AmountCents, q.Breakdown)
		}
	}
	if _, err := s.QuoteLifelike(ctx, StepInputs{Step: StepLifelikePreview, Preset: "draft", BillableS: 5}); err == nil {
		t.Error("draft is not a lifelike preset, previews included")
	}
	var absent Rates
	if got := absent.LifelikePreviewSeconds(); got.MinS != 2 || got.MaxS != 10 || got.DefaultS != 5 {
		t.Errorf("preview length defaults: %+v", got)
	}
}

// S3D-17: the 50¢ per-run minimum stays for both methods, Lifelike
// previews included.
func TestPerRunMinimum(t *testing.T) {
	ctx := context.Background()
	s := defaultsService(nil)
	q, err := s.QuoteStep(ctx, StepInputs{Step: "stereo_preview", Preset: "1080p", BillableS: 2, EffectiveFPS: 24})
	if err != nil {
		t.Fatal(err)
	}
	if q.AmountCents != 50 { // 120¢ × 3 × 2/60 = 12¢
		t.Errorf("classic 2 s preview floors at 50: %d", q.AmountCents)
	}
	if q, _ := s.QuoteLifelike(ctx, StepInputs{Step: "production", Preset: "1080p", BillableS: 5, EffectiveFPS: 24}); q.AmountCents != 50 {
		t.Errorf("lifelike 5 s production floors at 50: %d", q.AmountCents)
	}
}

func TestMaxSourceBytesFor(t *testing.T) {
	var absent Rates
	if absent.MaxSourceBytesFor("lifelike") != 25<<30 {
		t.Error("lifelike default 25 GiB")
	}
	if d := defaults(); d.MaxSourceBytesFor("classic") != 8<<30 {
		t.Error("classic keeps max_source_bytes")
	}
}

func TestPublicPricing(t *testing.T) {
	p := defaultsService(nil).Public(context.Background())
	methods := p["methods"].(map[string]any)
	ll := methods["lifelike"].(map[string]any)
	if ll["production_cents_per_minute"].(map[string]int64)["4k"] != 1000 || ll["preview_cents_per_frame"].(map[string]float64)["1080p"] != 0.3125 {
		t.Errorf("lifelike: %v", ll)
	}
	cl := methods["classic"].(map[string]any)["production_cents_per_minute"].(map[string]int64)
	// default classic 1080p production: 150¢ cost × 3 margin, depth factor 1
	if cl["1080p"] != 450 {
		t.Errorf("classic 1080p: %v", cl)
	}
	// 4k carries its preset depth size: 900 × (1 + 0.35 × ((1442/980)² − 1))
	if cl["4k"] <= 900 {
		t.Errorf("classic 4k must include the preset depth factor: %v", cl)
	}
	if p["precharge_threshold_cents"] != int64(2500) || p["minimum_cents"] != int64(50) {
		t.Errorf("thresholds: %v", p)
	}
	if _, ok := p["balance"]; ok {
		t.Error("the balance window and cap are internal (S3D-21)")
	}
	if methods["lifelike"].(map[string]any)["max_source_bytes"] != int64(25<<30) {
		t.Error("lifelike max_source_bytes")
	}
}
