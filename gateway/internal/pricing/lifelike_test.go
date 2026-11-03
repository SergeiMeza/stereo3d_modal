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
		// a 5 s preview hits the $0.50 minimum (450 × 5/60 = 38¢)
		{"1080p", 5, 24, 50},
	}
	for _, tc := range cases {
		for _, step := range []string{"production", StepLifelikePreview} {
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
	// ADR-0019: 1 minute of 4K on 4 GPUs = 45 + 530/4 + 20 + 1440 × 0.13 = 385.7
	if got := s.EstimateLifelikeETA(ctx, LifelikeInputs{Step: "production", Preset: "4k", OutputSeconds: 60, EffectiveFPS: 24, GPUs: 4}); got != 385 {
		t.Errorf("1 min 4k on 4 GPUs: want 385, got %d", got)
	}
	// The encode tail caps at 7,200 frames: 60 min of 1080p on 8 GPUs =
	// 45 + 31,800/8 + 20 + 7200 × 0.035 = 4292
	if got := s.EstimateLifelikeETA(ctx, LifelikeInputs{Step: "production", Preset: "1080p", OutputSeconds: 3600, EffectiveFPS: 24, GPUs: 8}); got != 4292 {
		t.Errorf("60 min 1080p on 8 GPUs: want 4292, got %d", got)
	}
	// Frames, not seconds: 48 fps doubles render and tail.
	a := s.EstimateLifelikeETA(ctx, LifelikeInputs{Preset: "qhd", OutputSeconds: 30, EffectiveFPS: 24, GPUs: 1})
	b := s.EstimateLifelikeETA(ctx, LifelikeInputs{Preset: "qhd", OutputSeconds: 30, EffectiveFPS: 48, GPUs: 1})
	if b-65 != 2*(a-65) {
		t.Errorf("48 fps should double the frame terms: %d vs %d", a, b)
	}
	// Config overrides take effect; zero values keep the defaults.
	r := defaults()
	r.LifelikeETA = LifelikeETA{OverheadSeconds: 100, EncodeSecondsPerFrame: map[string]float64{"4k": 0.2}}
	got := defaultsService(r).EstimateLifelikeETA(ctx, LifelikeInputs{Preset: "4k", OutputSeconds: 60, EffectiveFPS: 24, GPUs: 4})
	if want := int64(540); got != want && got != want+1 { // 100 + 132.5 + 20 + 288
		t.Errorf("overrides: want ~%d, got %d", want, got)
	}
}

func TestLifelikeConfigDefaults(t *testing.T) {
	var absent Rates // a config doc written before Lifelike: every key zero
	if absent.DefaultMethod() != "lifelike" {
		t.Error("default method must be lifelike")
	}
	if absent.GPUWorkersFor("lifelike") != 4 {
		t.Errorf("lifelike workers default 4, got %d", absent.GPUWorkersFor("lifelike"))
	}
	if absent.PrechargeThreshold() != 2500 {
		t.Errorf("precharge threshold default $25, got %d", absent.PrechargeThreshold())
	}
	if absent.MaxSourceDurationFor("lifelike") != 0 {
		t.Error("lifelike is unlimited by default")
	}
	r := Rates{MaxGPUWorkers: 10, LifelikeMaxGPUWorkers: 12, MaxSourceDurationS: 600, DefaultProjectMethod: "classic"}
	if r.GPUWorkersFor("classic") != 8 || r.GPUWorkersFor("lifelike") != 8 {
		t.Error("max_gpu_workers clamps to 8 for both methods")
	}
	if r.MaxSourceDurationFor("classic") != 600 {
		t.Error("classic keeps max_source_duration_s")
	}
	if r.DefaultMethod() != "classic" {
		t.Error("default_project_method classic must be honored")
	}
}
