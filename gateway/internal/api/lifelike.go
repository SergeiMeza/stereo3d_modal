package api

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"slices"
	"strings"

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
	// lifelikePreviewMaxSeconds bounds a lifelike_preview's source span
	// (the web sends ~5 s).
	lifelikePreviewMaxSeconds = 10.0
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
	switch requested {
	case "":
		return store.MethodClassic, nil
	case store.MethodLifelike:
		if s.Lifelike == nil {
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

// methodSwitchError enforces the one-way switch (owner decision S3D-01,
// S3D-30, S3D-44): a classic project may move to lifelike at any time, even
// after paid runs; a lifelike project — new or not — never goes back.
func methodSwitchError(from, to string) *httpx.APIError {
	if from == store.MethodLifelike && to == store.MethodClassic {
		return httpx.Err(http.StatusBadRequest, "method_switch_not_allowed",
			"A Lifelike project can't be switched back to Classic.")
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
func resolveLifelikeParams(req *stepConvReq, p *store.Project) (store.Params, *httpx.APIError) {
	var params store.Params
	switch req.Step {
	case store.StepLifelikePreview:
		params.Formats = []string{"sbs"}
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
	params.Preset = "1080p"
	if req.Preset != "" {
		if !slices.Contains(pricing.LifelikePresets, req.Preset) {
			return params, httpx.ErrInvalid("lifelike preset must be one of " + strings.Join(pricing.LifelikePresets, "|"))
		}
		params.Preset = req.Preset
	}
	// Lifelike never upscales: a preset above the source's short side is
	// not offered (1080p always is; below 1080 it renders at source size).
	if h := presetOutputHeight[params.Preset]; params.Preset != "1080p" && p.Probe != nil &&
		p.Probe.Width > 0 && p.Probe.Height > 0 && h > min(p.Probe.Width, p.Probe.Height) {
		return params, httpx.Err(http.StatusBadRequest, "preset_above_source", fmt.Sprintf(
			"%s needs a source at least %d pixels on its short side; this one is %d",
			params.Preset, h, min(p.Probe.Width, p.Probe.Height)))
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
		if p.Probe != nil && p.Probe.FPS > 0 {
			end := min(req.ToFrame, p.Probe.NumFrames)
			// one frame of slack so a client rounding 10 s to frames passes
			if float64(end-req.FromFrame-1)/p.Probe.FPS > lifelikePreviewMaxSeconds {
				return params, httpx.ErrInvalid(fmt.Sprintf(
					"lifelike_preview covers at most %g s of the source", lifelikePreviewMaxSeconds))
			}
		}
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
	if c.Step == store.StepLifelikePreview {
		maxGPUWorkers = 1 // a preview runs in one container anyway
	}
	body["max_gpu_workers"] = max(1, min(maxGPUWorkers, pricing.MaxGPUWorkersPerJob))
	return body
}

// modalFor is the pipeline service a conversion runs on; nil when it is a
// Lifelike run and Lifelike is no longer configured.
func (s *Service) modalFor(c *store.Conversion) *modalapi.Client {
	if c.Method == store.MethodLifelike {
		return s.Lifelike
	}
	return s.Modal
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
	Filename string `json:"filename"`
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

// formatLabels names an output in the downloaded file's name. Anything
// not listed keeps its output name.
var formatLabels = map[string]string{
	"mvhevc":   "3D",
	"sbs":      "3D SBS",
	"half_sbs": "3D Half SBS",
	"tb":       "3D TB",
	"half_tb":  "3D Half TB",
}

// downloadFilename: "<name> 3D Part 2.mov" for a split part, "<name> 3D.mov"
// otherwise. base is the project name (or "Video"); ext comes from the key.
func downloadFilename(base, outputName, ext string) string {
	format, part := splitOutputName(outputName)
	label, ok := formatLabels[format]
	if !ok {
		label = format
	}
	name := strings.TrimSpace(base)
	if name == "" {
		name = "Video"
	}
	name = strings.NewReplacer("/", "-", "\\", "-").Replace(name)
	if part > 0 {
		return fmt.Sprintf("%s %s Part %d%s", name, label, part, ext)
	}
	return fmt.Sprintf("%s %s%s", name, label, ext)
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
	if s.Lifelike != nil {
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
