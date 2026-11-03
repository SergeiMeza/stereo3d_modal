package api

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/probe"
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
	if requested > 0 || src <= fpsFreeMax*1.0005 || src > fpsPlanMax*1.001 || !s.webClient(r) {
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

// countSource counts the source's frames from the file (a variable so
// tests can stand in for ffprobe).
var countSource = func(ctx context.Context, s *Service, p *store.Project) (*probe.Counted, error) {
	if s.GCS == nil || p.Source.GCSKey == "" {
		return nil, nil
	}
	url, err := s.GCS.SignedGetURL(p.Source.GCSKey, 10*time.Minute)
	if err != nil {
		return nil, err
	}
	return probe.Count(ctx, url)
}

// countedFrames is the source's counted frames, 0 when it couldn't be
// counted (the header's then stand; the settle check still catches a run
// that renders more than it was quoted).
func (s *Service) countedFrames(ctx context.Context, p *store.Project) int {
	c, err := countSource(ctx, s, p)
	if err != nil {
		slog.WarnContext(ctx, "source frame count failed", "project_id", p.ID, "err", err)
		return 0
	}
	if c == nil {
		return 0
	}
	return c.Frames
}

func countedRate(frames int, durationS float64) float64 {
	if frames <= 0 || durationS <= 0 {
		return 0
	}
	return float64(frames) / durationS
}

// quotedFrames is the output frames a run was priced for: its length
// times the rate it renders at (0 = unknown).
func quotedFrames(c *store.Conversion) int {
	secs := runSeconds(c)
	if secs <= 0 && c.Source.FPS > 0 && c.Params.ToFrame == 0 && c.Source.Frames > 0 {
		secs = float64(c.Source.Frames-c.Params.FromFrame) / c.Source.FPS
	}
	fps := c.Params.TargetFPS
	if fps <= 0 {
		fps = max(c.Source.FPS, c.Source.PricingFPS)
	}
	if secs <= 0 || fps <= 0 {
		return 0
	}
	return int(math.Round(secs * fps))
}

// checkFramesOverQuote: a run whose job rendered more than 1% over the
// frames it was quoted for still settles at the quote (holds and charges
// are the quote); the owner hears of it and a case records it for review.
func (s *Service) checkFramesOverQuote(ctx context.Context, c *store.Conversion) {
	quoted := quotedFrames(c)
	if c.ProjectID == "" || c.Modal.VideoFrames <= 0 || quoted <= 0 || float64(c.Modal.VideoFrames) <= float64(quoted)*1.01 {
		return
	}
	text := fmt.Sprintf("run `%s` rendered %d frames against %d quoted (+%.1f%%); settled at the quote (%s)",
		c.ID, c.Modal.VideoFrames, quoted, 100*(float64(c.Modal.VideoFrames)/float64(quoted)-1), money(c.Quote.AmountCents))
	slog.WarnContext(ctx, "frames over quote", "conversion_id", c.ID, "uid", c.UID,
		"video_frames", c.Modal.VideoFrames, "quoted_frames", quoted)
	if s.Slack != nil {
		s.Slack.Alert(ctx, "frames_over_quote", text)
	}
	if s.Store == nil {
		return
	}
	cs := &store.Case{UID: c.UID, Type: store.CaseSupport, Reason: "frames_over_quote", Mode: "manual",
		Source: "system", Status: store.CaseOpen, Open: true, Currency: "usd",
		Related: store.CaseRelated{ConversionIDs: []string{c.ID}}, DedupeKey: "frames_over_quote:" + c.ID}
	if _, err := s.openCase(ctx, cs, "system", text); err != nil {
		slog.ErrorContext(ctx, "frames over quote case failed", "conversion_id", c.ID, "err", err)
	}
}

// fpsTooHighError is the render pipeline's plan-time refusal of a source
// above 120 fps (before any GPU work); failureCopy maps it to plain copy.
const fpsTooHighError = "Frame rate above 120 fps is not supported"

// foldSourceVFR copies the pipeline's read of the source (source_vfr,
// source_counted_frames) onto the project for support cases, once per run.
func (s *Service) foldSourceVFR(ctx context.Context, conv *store.Conversion, job *modalapi.Job) {
	vfr, counted := job.SourceVFR()
	if vfr == nil || conv.ProjectID == "" || conv.Modal.SourceVFR != nil || s.Store == nil {
		return
	}
	_, err := s.Store.UpdateProject(ctx, conv.ProjectID, func(p *store.Project) error {
		if p.Probe == nil {
			p.Probe = &store.Probe{}
		}
		p.Probe.SourceVFR, p.Probe.SourceCountedFrames = vfr, counted
		return nil
	})
	if err != nil {
		slog.WarnContext(ctx, "source vfr fold failed", "conversion_id", conv.ID, "project_id", conv.ProjectID, "err", err)
	}
}
