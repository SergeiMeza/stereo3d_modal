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
		{"1080p", 60, 24, 300},
		{"qhd", 60, 24, 450},
		{"3k", 60, 24, 700},
		// 2 min of 4k = $17 → 10% bulk discount → $15.30
		{"4k", 120, 24, 1530},
		// 48 fps doubles the frames: 1 min of 1080p = $6 (under the $10 discount)
		{"1080p", 60, 48, 600},
		// a 5 s production is billed as a whole minute (rounded up, 2026-11-04)
		{"1080p", 5, 24, 300},
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
	if q, _ := s.QuoteLifelike(ctx, StepInputs{Step: "production", Preset: "4k", BillableS: 30, EffectiveFPS: 24}); q.AmountCents != 1080 {
		t.Errorf("config price (30 s billed as 1 min = 1200, bulk 10%%): want 1080, got %d", q.AmountCents)
	}
	if q, _ := s.QuoteLifelike(ctx, StepInputs{Step: "production", Preset: "qhd", BillableS: 60, EffectiveFPS: 24}); q.AmountCents != 450 {
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
	eta := func(in LifelikeInputs) int64 { return s.EstimateLifelikeETA(ctx, in) }
	// 1 minute of 1080p on 4 GPUs, the pipeline's rate: 70 + 530/4 + 150 = 352.5
	if got := eta(LifelikeInputs{Step: "production", Preset: "1080p", OutputSeconds: 60, EffectiveFPS: 24, GPUs: 4}); got != 353 {
		t.Errorf("1 min 1080p on 4 GPUs: want 353, got %d", got)
	}
	// the tail follows the picture: 4K doubles it (70 + 132.5 + 300)
	if got := eta(LifelikeInputs{Step: "production", Preset: "4k", OutputSeconds: 60, EffectiveFPS: 24, GPUs: 4}); got != 503 {
		t.Errorf("1 min 4K on 4 GPUs: want 503, got %d", got)
	}
	// and the rate: 1080p Master (60 Mbit/s) ~300 s, 4K Master 150 ~600 s
	master := LifelikeInputs{Step: "production", Preset: "1080p", OutputSeconds: 60, EffectiveFPS: 24, GPUs: 4,
		OutputBitrateBps: 60_000_000, MasterBitrateBps: 60_000_000}
	if got := eta(master); got != 503 {
		t.Errorf("1080p Master: want 503 (70 + 132.5 + 300), got %d", got)
	}
	master.Preset, master.OutputBitrateBps, master.MasterBitrateBps = "4k", 150_000_000, 150_000_000
	if got := eta(master); got != 803 {
		t.Errorf("4K Master: want 803 (70 + 132.5 + 600), got %d", got)
	}
	// the owner's run (kc32a3bc174ea16f): 4 min of 1080p Master at 30 fps,
	// Express (8 GPUs): 70 + 530 × 4 × 30/24 / 8 + 300 ≈ 701 s (~11.7 min;
	// ~11.3 measured without the preemption bug; quoted 449 before)
	if got := eta(LifelikeInputs{Step: "production", Preset: "1080p", OutputSeconds: 240, EffectiveFPS: 30, GPUs: 8,
		OutputBitrateBps: 60_000_000, MasterBitrateBps: 60_000_000}); got != 701 {
		t.Errorf("owner's run: want 701, got %d", got)
	}
	// the tail is flat in length: 60 min of 1080p on 8 GPUs = 70 + 31,800/8 + 150
	if got := eta(LifelikeInputs{Step: "production", Preset: "1080p", OutputSeconds: 3600, EffectiveFPS: 24, GPUs: 8}); got != 4195 {
		t.Errorf("60 min on 8 GPUs: want 4195, got %d", got)
	}
	// a 5 s preview on one GPU: 70 + 530 × 120/1440 + 30 = 144
	if got := eta(LifelikeInputs{Step: StepLifelikePreview, Preset: "4k", OutputSeconds: 5, EffectiveFPS: 24, GPUs: 1}); got != 144 {
		t.Errorf("5 s preview: want 144, got %d", got)
	}
	// Frames, not seconds: 48 fps doubles the render term only.
	a := eta(LifelikeInputs{Step: "production", Preset: "qhd", OutputSeconds: 30, EffectiveFPS: 24, GPUs: 1})
	b := eta(LifelikeInputs{Step: "production", Preset: "qhd", OutputSeconds: 30, EffectiveFPS: 48, GPUs: 1})
	if fixed := int64(70 + 200); b-fixed != 2*(a-fixed) {
		t.Errorf("48 fps should double the render term: %d vs %d", a, b)
	}
	// Config overrides take effect; zero values keep the defaults.
	r := defaults()
	r.LifelikeETA = LifelikeETA{OverheadSeconds: 100, EncodeTailSeconds: 200}
	if got := defaultsService(r).EstimateLifelikeETA(ctx, LifelikeInputs{Step: "production", Preset: "1080p", OutputSeconds: 60, EffectiveFPS: 24, GPUs: 4}); got != 433 {
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
		// 5 s at 24 fps (25¢, 38¢, 58¢, 71¢) all floor at the $1 preview
		// minimum (S3D-13/17)
		{"1080p", 5, 24, 100}, {"qhd", 5, 24, 100}, {"3k", 5, 24, 100}, {"4k", 5, 24, 100},
		// 10 s of a 60 fps source: 600 frames × 850/1440
		{"4k", 10, 60, 354},
		// 10 s at 24 fps: 240 frames × 850/1440 = 142¢; quick look half
		// the frames (71¢ → 100)
		{"4k", 10, 24, 142}, {"4k", 10, 12, 100},
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
	if q.AmountCents != 100 { // 120¢ × 3 × 2/60 = 12¢
		t.Errorf("classic 2 s preview floors at the $1 preview minimum: %d", q.AmountCents)
	}
	r := defaults()
	r.PreviewMinimumCents = 75
	if q, _ := defaultsService(r).QuoteStep(ctx, StepInputs{Step: "depth_preview", Preset: "draft", BillableS: 2}); q.AmountCents != 75 {
		t.Errorf("preview_minimum_cents from config: %d", q.AmountCents)
	}
	if (&Rates{}).PreviewMinimum() != 100 {
		t.Error("preview minimum defaults to 100")
	}
	// Production rounds up to whole minutes (2026-11-04), so a short run
	// costs its first minute; the $1 floor stays under it.
	if q, _ := s.QuoteLifelike(ctx, StepInputs{Step: "production", Preset: "1080p", BillableS: 5, EffectiveFPS: 24}); q.AmountCents != 300 {
		t.Errorf("lifelike 5 s production is a whole minute: %d", q.AmountCents)
	}
	if q, _ := s.QuoteStep(ctx, StepInputs{Step: "production", Preset: "draft", BillableS: 2, EffectiveFPS: 24}); q.AmountCents != 360 {
		t.Errorf("classic 2 s production is a whole minute: %d", q.AmountCents)
	}
	if (&Rates{}).ProMinimum() != 100 {
		t.Error("pro minimum defaults to 100")
	}
	// the mobile one-shot keeps minimum_cents (50) — shipped apps unchanged
	m := defaults()
	m.MinBillableSeconds = 0
	if q, _ := defaultsService(m).QuoteVideo(ctx, VideoInputs{Preset: "draft", BillableS: 5}); q.AmountCents != 50 {
		t.Errorf("mobile minimum: %d", q.AmountCents)
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
	if ll["production_cents_per_minute"].(map[string]int64)["4k"] != 850 || ll["preview_cents_per_frame"].(map[string]float64)["1080p"] != 0.2083 ||
		ll["from_cents_per_minute"] != int64(300) {
		t.Errorf("lifelike: %v", ll)
	}
	cl := methods["classic"].(map[string]any)["production_cents_per_minute"].(map[string]int64)
	// default classic 1080p production (S3D-29 "Stretched" edges): 150¢
	// cost × 3 margin × 0.4 (inpaint none), depth factor 1
	if cl["1080p"] != 180 {
		t.Errorf("classic 1080p: %v", cl)
	}
	// 3k carries its preset depth size: 288 × (1 + 0.35 × ((1148/980)² − 1))
	if cl["3k"] <= 288 {
		t.Errorf("classic 3k must include the preset depth factor: %v", cl)
	}
	if _, ok := cl["4k"]; ok {
		t.Errorf("classic pro steps stop at 3k (S3D-12): %v", cl)
	}
	if p["precharge_threshold_cents"] != int64(2500) || p["minimum_cents"] != int64(100) {
		t.Errorf("thresholds: %v", p)
	}
	if _, ok := p["balance"]; ok {
		t.Error("the balance window and cap are internal (S3D-21)")
	}
	if methods["lifelike"].(map[string]any)["max_source_bytes"] != int64(25<<30) {
		t.Error("lifelike max_source_bytes")
	}
}

// S3D-48: the steps above 4K.
func TestLifelikeAbove4KPrices(t *testing.T) {
	s := defaultsService(nil)
	for preset, want := range map[string]int64{"5k": 1300, "6k": 1600, "8k": 2200} {
		q, err := s.QuoteLifelike(context.Background(), StepInputs{Step: "production", Preset: preset, BillableS: 60, EffectiveFPS: 24})
		if err != nil || q.Breakdown["subtotal_cents"] != want {
			t.Errorf("%s: %v %v", preset, q, err)
		}
	}
}
