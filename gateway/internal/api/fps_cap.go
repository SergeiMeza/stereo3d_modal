package api

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Output frame rates above 30 fps need an active Business or Studio plan
// (owner 2026-11-04), for every method and for previews. Without one, a
// source above 30 fps converts at the largest whole-number division of
// its rate that's at most 30 (60 → 30, 59.94 → 29.97, 50 → 25, 48 → 24,
// 120 → 30, 100 → 25, 90 → 30, 40 → 20), reported as params.target_fps
// with fps_capped; an explicit target_fps above 30 is 422
// plan_required_fps. With a plan, today's rules (sources up to 120 fps).
// Pricing is unchanged (the fps factor against 24): the cap only limits
// what's allowed. The web makes the rate a required choice above 30 fps:
// a web run (preview or full) on such a source without target_fps is 422
// fps_choice_required; API callers keep the default.

const (
	fpsFreeMax = 30.0
	fpsPlanMax = 120.0
)

func errPlanRequiredFPS() *httpx.APIError {
	return httpx.Err(http.StatusUnprocessableEntity, "plan_required_fps", "Frame rates above 30 fps need a Business or Studio plan.")
}

func errFPSChoiceRequired(choices []float64) *httpx.APIError {
	e := httpx.Err(http.StatusUnprocessableEntity, "fps_choice_required", "Choose the frame rate for this video.")
	e.Details = map[string]any{"target_fps_choices": choices}
	return e
}

// cappedFPS is the largest whole-number division of src that's at most
// max (src itself when it fits).
func cappedFPS(src, max float64) float64 {
	if src <= max*1.0005 {
		return src
	}
	n := math.Ceil(src/max - 1e-9)
	return math.Round(src/n*1000) / 1000
}

// fpsChoices are the target rates offered for a source: its whole-number
// divisions from the highest allowed down to about 10 fps.
func fpsChoices(src, max float64) []float64 {
	if src <= 0 {
		return []float64{}
	}
	var out []float64
	for n := 1.0; n <= 12; n++ {
		f := math.Round(src/n*1000) / 1000
		if f > max*1.0005 {
			continue
		}
		if f < 10 && len(out) > 0 {
			break
		}
		out = append(out, f)
	}
	return out
}

// planFPSMax is the account's highest output rate.
func (s *Service) planFPSMax(ctx context.Context, uid string) float64 {
	if s.Store == nil {
		return fpsFreeMax
	}
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err == nil && cust.Plan.Active(time.Now()) && (cust.Plan.Tier == pricing.TierBusiness || cust.Plan.Tier == pricing.TierStudio) {
		return fpsPlanMax
	}
	return fpsFreeMax
}

// sourceFPS is the rate a run converts at without a target: the source's
// (its pricing rate, with VFR taken into account).
func sourceFPS(p *store.Project) float64 {
	if p.Probe == nil {
		return 0
	}
	return p.Probe.PricingFPS()
}

// applyFPSCap enforces the plan rule on resolved params (both methods,
// previews included). requested is the client's target_fps (0 = none).
func (s *Service) applyFPSCap(ctx context.Context, p *store.Project, requested float64, params *store.Params) *httpx.APIError {
	src := sourceFPS(p)
	max := s.planFPSMax(ctx, p.UID)
	if requested > fpsFreeMax*1.001 && max <= fpsFreeMax {
		return errPlanRequiredFPS()
	}
	eff := params.TargetFPS
	if eff <= 0 {
		eff = src
	}
	if max <= fpsFreeMax && eff > fpsFreeMax*1.0005 {
		if params.DepthSource != "" {
			// an uploaded depth map is frame-exact against every source
			// frame, so the run can't drop to a lower rate
			return errPlanRequiredFPS()
		}
		params.TargetFPS = cappedFPS(eff, fpsFreeMax)
		params.FPSCapped = true
	}
	return nil
}

// fpsInfo is the quote's frame-rate block for this account and source.
func (s *Service) fpsInfo(ctx context.Context, p *store.Project, params store.Params) map[string]any {
	src := sourceFPS(p)
	max := s.planFPSMax(ctx, p.UID)
	out := map[string]any{"max_fps": max, "source_fps": src, "target_fps_choices": fpsChoices(src, max), "fps_capped": params.FPSCapped}
	if params.FPSCapped {
		out["reason"] = "plan_required_above_30fps"
	}
	if params.TargetFPS > 0 {
		out["target_fps"] = params.TargetFPS
	} else {
		out["target_fps"] = src
	}
	return out
}

// webClient: the request came from the web app (a browser naming one of
// our origins), not an API caller.
func (s *Service) webClient(r *http.Request) bool {
	o := strings.TrimRight(r.Header.Get("Origin"), "/")
	if o == "" {
		return false
	}
	return slices.Contains(s.Cfg.CORSOrigins, o) || slices.Contains(s.Cfg.CORSOrigins, "*")
}

// requireFPSChoice: a web run on a source above 30 fps names its rate.
func (s *Service) requireFPSChoice(ctx context.Context, r *http.Request, p *store.Project, requested float64) *httpx.APIError {
	src := sourceFPS(p)
	if requested > 0 || src <= fpsFreeMax*1.0005 || !s.webClient(r) {
		return nil
	}
	return errFPSChoiceRequired(fpsChoices(src, s.planFPSMax(ctx, p.UID)))
}

// fpsLabel prints a rate for receipts: "60 fps", "29.97 fps".
func fpsLabel(f float64) string {
	if f <= 0 {
		return ""
	}
	return strconv.FormatFloat(math.Round(f*100)/100, 'f', -1, 64) + " fps"
}

// runSpec is a run's receipt and invoice detail: "4K · 60 fps · 3 min"
// (production bills whole minutes; previews show their seconds).
func runSpec(c *store.Conversion) string {
	var parts []string
	if l := resolutionLabel(c, nil); l != "" {
		parts = append(parts, l)
	}
	fps := c.Params.TargetFPS
	if fps <= 0 {
		fps = c.Source.FPS
	}
	if l := fpsLabel(fps); l != "" {
		parts = append(parts, l)
	}
	if m := billedMinutesOf(c); m > 0 {
		parts = append(parts, fmt.Sprintf("%d min", m))
	} else if secs := runSeconds(c); secs > 0 && c.Step != store.StepProduction {
		parts = append(parts, fmt.Sprintf("%d s", int64(math.Round(secs))))
	}
	return strings.Join(parts, " · ")
}

func billedMinutesOf(c *store.Conversion) int64 {
	switch v := c.Quote.Breakdown["billable_minutes"].(type) {
	case int64:
		return v
	case int:
		return int64(v)
	case float64:
		return int64(v)
	}
	if c.Step == store.StepProduction {
		return pricing.BillableMinutes(runSeconds(c))
	}
	return 0
}

func runSeconds(c *store.Conversion) float64 {
	if c.Source.FPS <= 0 || c.Params.ToFrame <= c.Params.FromFrame {
		if v, ok := c.Quote.Breakdown["billable_seconds"].(float64); ok {
			return v
		}
		return 0
	}
	return float64(c.Params.ToFrame-c.Params.FromFrame) / c.Source.FPS
}
