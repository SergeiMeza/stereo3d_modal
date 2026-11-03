package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Lifelike 3D (2026-11-03): a second conversion method next to Classic,
// chosen per project and switchable any time (owner decisions LL-D1..D8;
// contract in the lifelike-gateway-web brief). Lifelike runs on the shared
// lifelike3d Modal service (ml-sharp-modal ADR-0019, docs/LIFELIKE_API.md),
// whose submit/job shape is the stereo3d API's, so the conversion state
// machine, billing and settlement are shared; only the steps, the request
// body, the price inputs and the ETA differ. Projects without a stored
// method are classic.

const (
	// split_max_seconds rails (the service's own floor is 10 s).
	minSplitSeconds = 60
	maxSplitSeconds = 3600
	// splitSuggestSeconds: outputs longer than this make Deliver offer
	// "Split into parts" (LL-D6); quotes flag them.
	splitSuggestSeconds = 900
)

var lifelikeFormats = []string{"mvhevc", "sbs", "half_sbs"}

func projectMethod(p *store.Project) string { return store.MethodOr(p.Method) }

// errMethodUnavailable: the Lifelike service isn't configured for this
// environment (LIFELIKE_BASE_URL empty).
func errMethodUnavailable() *httpx.APIError {
	return httpx.Err(http.StatusBadRequest, "method_unavailable", "Lifelike is not available right now; use Classic")
}

// resolveMethod validates a client-named method. "" is classic: clients
// that predate Lifelike send no method and only know the classic steps, so
// they must keep getting classic projects. The web app names the method
// explicitly and defaults its own UI to lifelike (defaultMethod).
func (s *Service) resolveMethod(requested string) (string, *httpx.APIError) {
	return s.resolveMethodFor(requested, s.assignWorkspace().Lifelike != nil) // new projects' workspace
}

// resolveMethodFor is resolveMethod against a workspace whose Lifelike
// is (not) configured (S3D-40).
func (s *Service) resolveMethodFor(requested string, lifelike bool) (string, *httpx.APIError) {
	switch requested {
	case "":
		return store.MethodClassic, nil
	case store.MethodLifelike:
		if !lifelike {
			return "", errMethodUnavailable()
		}
		return requested, nil
	case store.MethodClassic:
		return requested, nil
	}
	return "", httpx.ErrInvalid("method must be lifelike|classic")
}

// methodSourceError enforces a method's source-length cap against the
// analyzed probe: Classic keeps max_source_duration_s, Lifelike is unlimited
// unless lifelike_max_source_duration_s says otherwise. nil before the
// probe lands (the analyze fold applies the cap then).
func methodSourceError(rates *pricing.Rates, p *store.Project, method string) *httpx.APIError {
	if err := sourceBytesError(rates, p.Source.Bytes, method); err != nil {
		return err
	}
	maxS := rates.MaxSourceDurationFor(method)
	if p.Probe == nil || maxS <= 0 || p.Probe.DurationS <= maxS {
		return nil
	}
	msg := fmt.Sprintf("This video is %s long. Classic works on videos up to %s; Lifelike has no length limit.",
		formatMinSec(p.Probe.DurationS), formatMinSec(maxS))
	if method == store.MethodLifelike {
		msg = fmt.Sprintf("This video is %s long. Lifelike works on videos up to %s.",
			formatMinSec(p.Probe.DurationS), formatMinSec(maxS))
	}
	return httpx.Err(http.StatusBadRequest, "source_too_long_for_method", msg)
}

// sourceBytesError enforces a method's source-file cap (S3D-42: Lifelike
// 25 GiB, Classic max_source_bytes). 400 source_too_large, as before.
func sourceBytesError(rates *pricing.Rates, bytes int64, method string) *httpx.APIError {
	maxB := rates.MaxSourceBytesFor(method)
	if maxB <= 0 || bytes <= maxB {
		return nil
	}
	name := "Classic"
	if method == store.MethodLifelike {
		name = "Lifelike"
	}
	return httpx.ErrSource("source_too_large", fmt.Sprintf(
		"This file is %s. %s works on files up to %s.", formatGB(bytes), name, formatGB(maxB)))
}

// formatGB renders a byte count as "8 GB" / "12.4 GB" for limit messages.
func formatGB(b int64) string {
	gb := float64(b) / (1 << 30)
	if gb == math.Trunc(gb) {
		return fmt.Sprintf("%.0f GB", gb)
	}
	return fmt.Sprintf("%.1f GB", gb)
}

// methodSwitchError enforces the one-way switch (owner decisions S3D-01,
// S3D-30, S3D-44): a classic project may move to lifelike at any time, even
// after paid runs; a lifelike project never goes back, runs or not.
func methodSwitchError(from, to string) *httpx.APIError {
	if from == store.MethodLifelike && to == store.MethodClassic {
		return httpx.Err(http.StatusBadRequest, "method_switch_not_allowed",
			"A Lifelike project can't be switched to Classic.")
	}
	return nil
}

func errStepForMethod(step, method string) *httpx.APIError {
	steps := "depth_preview|stereo_preview|production"
	if method == store.MethodLifelike {
		steps = "lifelike_preview|production"
	}
	return httpx.Err(http.StatusBadRequest, "step_not_supported_for_method",
		fmt.Sprintf("step %q is not available for %s projects (use %s)", step, method, steps))
}

// resolveLifelikeParams is resolveStepParams for Lifelike projects: the
// steps are lifelike_preview and production, the knobs preset (1080p|qhd|
// 3k|4k, never above the source), formats (mvhevc|sbs|half_sbs),
// target_fps, the trim and split_max_seconds. Every Classic-only knob is a
// 400 rather than silently dropped.
func resolveLifelikeParams(req *stepConvReq, p *store.Project, enabled []string) (store.Params, *httpx.APIError) {
	var params store.Params
	switch req.Step {
	case store.StepLifelikePreview:
		params.Formats = []string{"sbs"} // half_sbs where full width is refused, below
	case store.StepProduction:
		params.Formats = []string{"mvhevc", "half_sbs"}
	default:
		return params, errStepForMethod(req.Step, store.MethodLifelike)
	}
	classicOnly := map[string]bool{
		"depth_res":          req.DepthRes != 0,
		"depth_scale":        req.DepthScale != 0,
		"inpaint":            req.Inpaint != "",
		"warp":               req.Warp != "",
		"scene_overrides":    len(req.SceneOverrides) > 0,
		"use_uploaded_depth": req.UseUploadedDepth,
		"displacement":       req.Displacement != 0,
	}
	for _, knob := range []string{"depth_res", "depth_scale", "inpaint", "warp", "scene_overrides", "use_uploaded_depth", "displacement"} {
		if classicOnly[knob] {
			return params, httpx.ErrInvalid(knob + " applies to classic projects only")
		}
	}
	q, qerr := pickQuality(lifelikeQualities(p, enabled), req.Preset, sourceShortSide(p), enabled)
	if qerr != nil {
		return params, qerr
	}
	params.Preset, params.Quality = q.Preset, q.ID
	if q.PricePreset != q.Preset {
		params.PricePreset = q.PricePreset
	}
	if req.OriginalEye != nil && *req.OriginalEye != "" {
		if *req.OriginalEye != "left" && *req.OriginalEye != "right" {
			return params, httpx.ErrInvalid("original_eye must be left, right or null")
		}
		params.OriginalEye = *req.OriginalEye
	}
	if q.OriginalEyeRequired && params.OriginalEye == "" {
		// S3D-65: above 4K the source is always one eye; absent or null
		// means the left.
		params.OriginalEye = "left"
	}
	if fov := req.Foveation.value(); fov != "" {
		if fov != "static" {
			return params, httpx.ErrInvalid("foveation must be static")
		}
		if short := sourceShortSide(p); short > 0 && !foveationFits(p, params) {
			return params, httpx.ErrInvalid(fmt.Sprintf(
				"foveation needs a size below this video's own (%dp); pick a smaller quality", short))
		}
		params.Foveation = fov
	}
	if req.Formats != nil && len(req.Formats) == 0 {
		return params, httpx.ErrInvalid("formats cannot be empty: select at least one output format")
	}
	if len(req.Formats) > 0 {
		for _, f := range req.Formats {
			if !slices.Contains(lifelikeFormats, f) {
				return params, httpx.ErrInvalid("unsupported format " + f + " (lifelike outputs mvhevc|sbs|half_sbs)")
			}
		}
		params.Formats = req.Formats
	}
	if sbsTooWide[q.Preset] && slices.Contains(params.Formats, "sbs") {
		if req.Step == store.StepLifelikePreview {
			params.Formats = []string{"half_sbs"} // the preview's look, at a width that works
		} else {
			return params, httpx.Err(http.StatusBadRequest, "format_unavailable",
				"full-width side-by-side isn't available at this size; choose half side-by-side or a smaller quality")
		}
	}
	if req.TargetFPS < 0 || req.TargetFPS > maxTargetFPS(p)*1.001 {
		return params, httpx.ErrInvalid("target_fps cannot exceed the source frame rate")
	}
	params.TargetFPS = req.TargetFPS // 0 = the source rate
	if req.FromFrame < 0 || req.ToFrame < 0 ||
		(req.ToFrame > 0 && req.ToFrame <= req.FromFrame) ||
		(p.Probe != nil && req.FromFrame >= p.Probe.NumFrames) {
		return params, httpx.ErrInvalid("invalid trim range: need 0 <= from_frame < to_frame <= num_frames")
	}
	params.FromFrame, params.ToFrame = req.FromFrame, req.ToFrame
	if req.Step == store.StepLifelikePreview {
		if req.ToFrame == 0 {
			return params, httpx.ErrInvalid("lifelike_preview needs from_frame and to_frame")
		}
		// its length rule is config (checkPreviewSpan, from resolveParams)
		if req.SplitMaxSeconds != 0 {
			return params, httpx.ErrInvalid("split_max_seconds applies to production only")
		}
	}
	if req.SplitMaxSeconds != 0 {
		if req.SplitMaxSeconds < minSplitSeconds || req.SplitMaxSeconds > maxSplitSeconds {
			return params, httpx.ErrInvalid(fmt.Sprintf(
				"split_max_seconds must be in [%d, %d]", minSplitSeconds, maxSplitSeconds))
		}
		params.SplitMaxSeconds = req.SplitMaxSeconds
	}
	if p.Scenes != nil {
		params.SceneCuts = p.Scenes.Cuts
	}
	if berr := applyBitrate(&params, req.Bitrate, p); berr != nil {
		return params, berr
	}
	return params, nil
}

// lifelikeBody builds the whitelisted lifelike3d submit body (the service
// ignores unknown keys, but nothing unvalidated is sent). The project's cut
// list is always sent ([] = one scene), so the service skips its own scene
// scan and the run matches the user's scene edit.
func lifelikeBody(c *store.Conversion, maxGPUWorkers int) map[string]any {
	cuts := c.Params.SceneCuts
	if cuts == nil {
		cuts = []int{}
	}
	body := map[string]any{
		"input_path": c.Source.GCSKey,
		"preset":     c.Params.Preset,
		"formats":    c.Params.Formats,
		"scene_cuts": cuts,
	}
	if c.Params.FromFrame > 0 {
		body["from_frame"] = c.Params.FromFrame
	}
	if c.Params.ToFrame > 0 {
		body["to_frame"] = c.Params.ToFrame
	}
	if c.Params.TargetFPS > 0 {
		body["target_fps"] = c.Params.TargetFPS
	}
	if c.Params.SplitMaxSeconds > 0 {
		body["split_max_seconds"] = c.Params.SplitMaxSeconds
	}
	if c.Params.OriginalEye != "" {
		body["original_eye"] = c.Params.OriginalEye
	}
	if c.Params.OutputBitrateBps > 0 {
		body["output_bitrate_bps"] = c.Params.OutputBitrateBps // absent = auto
	}
	if c.Params.Foveation != "" {
		body["foveation"] = c.Params.Foveation
	}
	if c.Params.Stabilize {
		body["stabilize"] = true // absent = off (the service default)
	}
	if c.Step == store.StepLifelikePreview {
		maxGPUWorkers = 1 // a preview runs in one container anyway
	}
	body["max_gpu_workers"] = max(1, min(maxGPUWorkers, pricing.MaxGPUWorkersPerJob))
	return body
}

// modalFor is the pipeline service a conversion runs on, in its
// workspace; nil when that workspace (or its Lifelike) is no longer
// configured.
func (s *Service) modalFor(c *store.Conversion) *modalapi.Client {
	ws, ok := s.workspace(c.Workspace) // S3D-40: the run's own workspace
	if !ok {
		return nil
	}
	if c.Method == store.MethodLifelike {
		return ws.Lifelike
	}
	return ws.Modal
}

// lifelikeIn: the project's workspace runs Lifelike.
func (s *Service) lifelikeIn(p *store.Project) bool {
	ws, ok := s.workspace(p.Workspace)
	return ok && ws.Lifelike != nil
}

// stepETA is the pre-run wall-clock estimate of a step for the method: the
// quote shows it and overdue runs are judged against it.
func (s *Service) stepETA(ctx context.Context, p *store.Project, params store.Params, step, method string, reuseStages []string) int64 {
	if p.Probe == nil {
		return 0
	}
	billable, berr := billableSeconds(p.Probe.NumFrames, p.Probe.FPS, params.FromFrame, params.ToFrame)
	if berr != nil {
		return 0
	}
	in := s.stepQuoteInputs(p, params, step, billable)
	if method == store.MethodLifelike {
		gpus := s.Pricing.Rates(ctx).GPUWorkersFor(store.MethodLifelike)
		if step == store.StepLifelikePreview {
			gpus = 1
		}
		return s.Pricing.EstimateLifelikeETA(ctx, pricing.LifelikeInputs{
			Step: step, Preset: params.Preset, OutputSeconds: billable,
			EffectiveFPS: in.EffectiveFPS, GPUs: gpus,
		})
	}
	in.ReuseStages = reuseStages
	return s.Pricing.EstimateStepETA(ctx, in)
}

// chargeTiming says when a pro step's money moves: "before" (charged up
// front, refunded on failure) above the precharge threshold, else "after"
// (joins the batch on success). Both methods (LL-D8).
func chargeTiming(rates *pricing.Rates, amountCents int64) string {
	if amountCents > rates.PrechargeThreshold() {
		return "before"
	}
	return "after"
}

// outputFile describes one output for GET .../downloads: split parts come
// back one entry per part with a 1-based part number.
type outputFile struct {
	Name     string `json:"name"`
	Format   string `json:"format"`
	Part     int    `json:"part,omitempty"`
	Filename string `json:"filename,omitempty"`
	URL      string `json:"url"`
	// SizeBytes from the stored object (S3D-31); absent when storage
	// didn't answer.
	SizeBytes int64 `json:"size_bytes,omitempty"`
}

// splitOutputName parses the lifelike3d part names ("mvhevc_part02" →
// mvhevc, 2); part 0 for an unsplit output.
func splitOutputName(name string) (format string, part int) {
	i := strings.LastIndex(name, "_part")
	if i <= 0 {
		return name, 0
	}
	n := 0
	for _, r := range name[i+5:] {
		if r < '0' || r > '9' {
			return name, 0
		}
		n = n*10 + int(r-'0')
	}
	if n == 0 {
		return name, 0
	}
	return name[:i], n
}

// sortOutputFiles orders by format, then part.
func sortOutputFiles(files []outputFile) {
	slices.SortFunc(files, func(a, b outputFile) int {
		if c := strings.Compare(a.Format, b.Format); c != 0 {
			return c
		}
		return a.Part - b.Part
	})
}

// overdueQueueAllowance is the GPU queueing a run has sat through: time the
// app-wide GPU cap held it back is not the run being slow.
func overdueQueueAllowance(c *store.Conversion) float64 {
	return math.Max(c.Modal.QueuedS, 0)
}

// defaultMethod is the method the web UI preselects (GET /v1/limits
// default_method; LL-D1): lifelike wherever the service is configured. The
// API's own default for a request without a method stays classic.
func (s *Service) defaultMethod() string {
	if s.assignWorkspace().Lifelike != nil {
		return store.MethodLifelike
	}
	return store.MethodClassic
}

// GET /v1/pricing — the public price list (S3D-18): both methods' customer
// prices, the preview price, the fps rule, discounts, minimum, pre-charge
// threshold, balance window and new-account cap, and per-method limits, all
// from the live config (pricing.Service.Public). No auth; the config cache
// is a minute, so five minutes of HTTP caching is plenty fresh.
func (s *Service) HandlePublicPricing(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "public, max-age=300")
	httpx.WriteOK(w, s.Pricing.Public(r.Context()))
}

// ------------------------------------------------------------- qualities

// quality is one output size a Lifelike project offers (S3D-04). Lifelike
// keeps the source's shape, sizes by the short side per eye and never
// upscales, so a step is offered only when the source's short side reaches
// it; between steps (3840×1606) or below 1080 a "full" option renders the
// next step up — which Lifelike clamps to the source — labelled with the
// real size and priced at the step below (1080p below 1080). The top step
// is 8K (S3D-48); bigger sources are scaled down to it.
type quality struct {
	ID string `json:"id"` // a preset, or "full"
	// LabelShortSide is the output's short side per eye ("Full
	// resolution (1606p)"), odd sizes rounded down to even.
	LabelShortSide int `json:"label_short_side"`
	// OriginalEyeRequired: sizes above 4K always keep the source as one
	// eye (S3D-65); the tile says so.
	OriginalEyeRequired bool `json:"original_eye_required,omitempty"`
	// Experimental: the service marks these outputs experimental (5K-8K).
	Experimental bool   `json:"experimental,omitempty"`
	Preset       string `json:"preset"`       // what Lifelike is asked for
	PricePreset  string `json:"price_preset"` // the price table row
	// Formats this size can be delivered in: full-width SBS stops at 5K
	// (no video level covers a frame that wide at 6K/8K; half SBS works).
	Formats []string `json:"formats"`
}

// sbsTooWide: Lifelike refuses full-width SBS for these presets (400).
var sbsTooWide = map[string]bool{"6k": true, "8k": true}

// formatsFor lists the Lifelike formats a preset can be delivered in.
func formatsFor(preset string) []string {
	if sbsTooWide[preset] {
		return []string{"mvhevc", "half_sbs"}
	}
	return slices.Clone(lifelikeFormats)
}

// newQuality builds an offered size; above 4K the source is always one
// eye and the result experimental (S3D-65).
func newQuality(id string, shortSide int, preset, pricePreset string) quality {
	above4K := shortSide > originalEyeAboveShortSide
	return quality{ID: id, LabelShortSide: shortSide, Preset: preset, PricePreset: pricePreset,
		OriginalEyeRequired: above4K, Experimental: above4K, Formats: formatsFor(preset)}
}

const qualityFull = "full"

// originalEyeAboveShortSide: outputs whose short side is above this (4K's
// 2160) always keep the source as one eye (S3D-65).
const originalEyeAboveShortSide = 2160

// sourceShortSide is the source's short side, rotation-proof (min of the
// two sides), rounded down to even; 0 before analysis.
func sourceShortSide(p *store.Project) int {
	if p.Probe == nil || p.Probe.Width <= 0 || p.Probe.Height <= 0 {
		return 0
	}
	return min(p.Probe.Width, p.Probe.Height) &^ 1
}

// lifelikeQualities lists what a project's source can be rendered at,
// smallest first, among the enabled presets (lifelike_enabled_presets).
// Before analysis every enabled step is listed. A full option renders the
// first ENABLED step above the source (clamped to the source); with none
// enabled above it, the top enabled step is the top.
func lifelikeQualities(p *store.Project, enabled []string) []quality {
	short := sourceShortSide(p)
	var out []quality
	below := "" // the highest step the source reaches
	for _, preset := range pricing.LifelikePresets {
		if !slices.Contains(enabled, preset) {
			continue
		}
		h := presetOutputHeight[preset]
		if short == 0 || h <= short {
			out = append(out, newQuality(preset, h, preset, preset))
			below = preset
			continue
		}
		// first step above the source: full resolution, unless the source
		// sits exactly on a step (then the step itself is its full size)
		if presetOutputHeight[below] != short {
			price := below
			if price == "" {
				price = pricing.LifelikePresets[0] // below 1080: the 1080p price
			}
			out = append(out, newQuality(qualityFull, short, preset, price))
		}
		break
	}
	return out
}

// pickQuality resolves a requested preset against the offered qualities:
// "" picks 1080p, or full resolution on a source below 1080; "full" or the
// preset the full option renders pick full resolution. A step the source
// doesn't reach is 400 preset_above_source.
func pickQuality(offered []quality, requested string, short int, enabled []string) (quality, *httpx.APIError) {
	if requested == "" {
		requested = pricing.LifelikePresets[0]
	}
	for _, q := range offered {
		if q.ID == requested || (q.ID == qualityFull && q.Preset == requested) {
			return q, nil
		}
	}
	if !slices.Contains(pricing.LifelikePresets, requested) && requested != qualityFull {
		return quality{}, httpx.ErrInvalid("lifelike preset must be one of " +
			strings.Join(pricing.LifelikePresets, "|") + "|" + qualityFull)
	}
	if requested != qualityFull && !slices.Contains(enabled, requested) {
		// Refused before any charge: the service doesn't render it yet.
		return quality{}, errPresetUnavailable(requested, enabled)
	}
	return quality{}, httpx.Err(http.StatusBadRequest, "preset_above_source", fmt.Sprintf(
		"%s is above this video's own size (%dp); Lifelike never upscales", requested, short))
}

// outputShortSide is what a Lifelike run will deliver per eye: the preset,
// clamped to the source.
func outputShortSide(p *store.Project, params store.Params) int {
	h := presetOutputHeight[params.Preset]
	if short := sourceShortSide(p); short > 0 && short < h {
		return short
	}
	return h
}

// pricePreset is the preset a run is priced at (the full option prices at
// the step below its render preset).
func pricePreset(params store.Params) string {
	if params.PricePreset != "" {
		return params.PricePreset
	}
	return params.Preset
}

// checkPreviewSpan applies the Lifelike preview's length rule (config
// lifelike_preview, 2-10 s by default) in source seconds, with a frame of
// slack either way for clients rounding seconds to frames.
func checkPreviewSpan(p *store.Project, params store.Params, rule pricing.PreviewSeconds) *httpx.APIError {
	if p.Probe == nil || p.Probe.FPS <= 0 {
		return nil
	}
	end := params.ToFrame
	if end <= 0 || end > p.Probe.NumFrames {
		end = p.Probe.NumFrames
	}
	frames := float64(end - params.FromFrame)
	if (frames-1)/p.Probe.FPS > rule.MaxS || (frames+1)/p.Probe.FPS < rule.MinS {
		return httpx.ErrInvalid(fmt.Sprintf(
			"lifelike_preview covers %g-%g s of the source", rule.MinS, rule.MaxS))
	}
	return nil
}

// resolveParams is resolveStepParams plus the rules that live in config.
func (s *Service) resolveParams(ctx context.Context, req *stepConvReq, p *store.Project) (store.Params, *httpx.APIError) {
	var params store.Params
	var err *httpx.APIError
	if projectMethod(p) == store.MethodLifelike {
		params, err = resolveLifelikeParams(req, p, s.Pricing.Rates(ctx).EnabledLifelikePresets())
	} else {
		params, err = resolveStepParams(req, p)
	}
	if err != nil {
		return params, err
	}
	rates := s.Pricing.Rates(ctx)
	if params.Foveation != "" && !rates.FoveationEnabled {
		return params, httpx.Err(http.StatusBadRequest, "feature_unavailable", "foveation is not available yet")
	}
	// S3D-50: once switched on, foveation is the default whenever the size
	// is below the source; only an explicit "foveation": null turns it off.
	if rates.FoveationEnabled && !req.Foveation.Set && projectMethod(p) == store.MethodLifelike &&
		foveationFits(p, params) {
		params.Foveation = "static"
	}
	// Config only (lifelike_stabilize), never a client knob.
	params.Stabilize = projectMethod(p) == store.MethodLifelike && rates.LifelikeStabilize
	if projectMethod(p) == store.MethodLifelike && req.Step == store.StepLifelikePreview {
		if serr := checkPreviewSpan(p, params, s.Pricing.Rates(ctx).LifelikePreviewSeconds()); serr != nil {
			return params, serr
		}
	}
	return params, nil
}

// errPresetUnavailable: a Lifelike size the service doesn't render yet
// (not in lifelike_enabled_presets) — 400 before any charge.
func errPresetUnavailable(preset string, enabled []string) *httpx.APIError {
	top := "4K"
	if n := len(enabled); n > 0 {
		top = strings.ToUpper(enabled[n-1])
	}
	return httpx.Err(http.StatusBadRequest, "preset_unavailable", fmt.Sprintf(
		"%s isn't available yet; choose %s or lower", strings.ToUpper(preset), top))
}

// enabledLifelikePresets for responses built without a request context
// (projectResponse): the cached config, bounded so a cold read can't hang
// the response; defaults without a pricing service (tests).
func (s *Service) enabledLifelikePresets() []string {
	if s.Pricing == nil {
		return pricing.DefaultLifelikeEnabled
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return s.Pricing.Rates(ctx).EnabledLifelikePresets()
}

// optString is a JSON field that tells absent (Set false) from an explicit
// null (Set true, Value nil).
type optString struct {
	Set   bool
	Value *string
}

func (o *optString) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		o.Value = nil
		return nil
	}
	var v string
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	o.Value = &v
	return nil
}

// value is the string sent, "" when absent or null.
func (o optString) value() string {
	if o.Value == nil {
		return ""
	}
	return *o.Value
}

// foveationFits: foveation spends the source's extra pixels on the centre
// of view, so the output must be smaller than the source (S3D-50).
func foveationFits(p *store.Project, params store.Params) bool {
	short := sourceShortSide(p)
	return short > 0 && presetOutputHeight[params.Preset] < short
}

// ------------------------------------------------------------- bitrate

// bitrateReq is the request's bitrate (S3D-56): a string ("auto",
// "match_source") or a number of Mbit/s; absent or null = auto.
type bitrateReq struct {
	Choice string // "" = auto
}

func (b *bitrateReq) UnmarshalJSON(raw []byte) error {
	if string(raw) == "null" {
		b.Choice = ""
		return nil
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		b.Choice = s
		return nil
	}
	var n float64
	if err := json.Unmarshal(raw, &n); err != nil {
		return fmt.Errorf("bitrate must be auto, match_source or a number of Mbit/s")
	}
	b.Choice = strconv.FormatFloat(n, 'f', -1, 64)
	return nil
}

// Bitrate rails: the fixed choices in Mbit/s, and match_source's cap.
var bitrateChoicesMbps = []string{"20", "40", "60", "100"}

const maxMatchSourceBps = 200_000_000

// sourceBitrate is the source video's bits per second: the analyzed video
// stream's bit_rate, else file size × 8 / duration; 0 when unknown.
func sourceBitrate(p *store.Project) int64 {
	if p.Probe == nil {
		return 0
	}
	if p.Probe.BitRate > 0 {
		return p.Probe.BitRate
	}
	if p.Source.Bytes > 0 && p.Probe.DurationS > 0 {
		return int64(float64(p.Source.Bytes) * 8 / p.Probe.DurationS)
	}
	return 0
}

// applyBitrate resolves the request's bitrate into params: auto leaves
// both fields empty (the pipeline's own rate); match_source takes the
// source's, capped at 200 Mbit/s; a number is that many Mbit/s. Same price
// either way.
func applyBitrate(params *store.Params, b bitrateReq, p *store.Project) *httpx.APIError {
	switch b.Choice {
	case "", "auto":
		return nil
	case "match_source":
		src := sourceBitrate(p)
		if src <= 0 {
			return httpx.ErrConflict("match_source needs the analyzed source; try again once analysis is done")
		}
		params.Bitrate, params.OutputBitrateBps = b.Choice, min(src, maxMatchSourceBps)
		return nil
	}
	if !slices.Contains(bitrateChoicesMbps, b.Choice) {
		return httpx.ErrInvalid("bitrate must be auto, match_source, 20, 40, 60 or 100")
	}
	mbps, _ := strconv.ParseInt(b.Choice, 10, 64)
	params.Bitrate, params.OutputBitrateBps = b.Choice, mbps*1_000_000
	return nil
}

// estimatedSizeBytes is one output file's size at the run's bitrate over
// its output length (0 with auto: the pipeline picks the rate).
func estimatedSizeBytes(params store.Params, outputSeconds float64) int64 {
	if params.OutputBitrateBps <= 0 {
		return 0
	}
	return int64(float64(params.OutputBitrateBps) * outputSeconds / 8)
}
