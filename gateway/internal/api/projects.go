package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/stripe/stripe-go/v78"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Pro step pipeline (web/DESIGN.md): 1 video = 1 project, N paid step
// conversions. The free analyze job runs at project creation; its cost is
// credited against the project's first paid conversion.

// Target fps rules: NEVER above the source fps (the pipeline can only
// decimate, and offering "30" on a 23.976 clip misleads), and previews
// default to HALF the source rate. The pipeline snaps near-divisor targets
// to exact frame-select, so half-rate is always pixel-perfect decimation.
func maxTargetFPS(p *store.Project) float64 {
	if p.Probe == nil || p.Probe.FPS <= 0 {
		return 120
	}
	return p.Probe.FPS
}

func halfSourceFPS(p *store.Project) float64 {
	if p.Probe == nil || p.Probe.FPS <= 0 {
		return 0
	}
	return p.Probe.FPS / 2
}

// ------------------------------------------------------------- create/list

// POST /v1/projects {gcs_key, name?}
func (s *Service) HandleCreateProject(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		GCSKey string `json:"gcs_key"`
		Name   string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	ext := strings.ToLower(path.Ext(req.GCSKey))
	if !slices.Contains(videoExts, ext) {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("projects need a video source (.mp4/.mov/.m4v)"))
		return
	}
	if !s.GCS.InPrefix(req.GCSKey) || !strings.Contains(req.GCSKey, "/users/"+user.UID+"/") {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("gcs_key is not one of your uploads"))
		return
	}
	rates := s.Pricing.Rates(ctx)
	size, err := s.GCS.Stat(ctx, req.GCSKey)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("upload not found; PUT the file to the signed URL first"))
		return
	}
	if size > rates.MaxSourceBytes {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("source file too large"))
		return
	}

	// Project id = upload id (same identifier across storage, analyze job
	// logs, and support). A re-created project on the same upload gets a
	// fresh id.
	id := uploadIDFromKey(req.GCSKey)
	if id == "" || len(id) != 12 {
		id = store.NewID()
	} else if _, err := s.Store.GetProject(ctx, id); err == nil {
		id = store.NewID()
	}

	// Free analyze job — submitted before the record so a Modal outage
	// fails the request instead of stranding a never-analyzed project.
	resp, err := s.Modal.SubmitAnalyze(ctx, map[string]any{"input_path": req.GCSKey, "notify": false})
	if err != nil {
		httpx.Log(ctx).Error("analyze submit failed", "project_id", id, "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "upstream_error",
			"analysis could not be started; try again"))
		return
	}

	p := &store.Project{
		ID: id, UID: user.UID, Env: s.Cfg.Env,
		Name:    strings.TrimSpace(req.Name),
		Source:  store.Source{GCSKey: req.GCSKey, Bytes: size},
		Analyze: store.Analyze{JobID: resp.JobID, State: store.AnalyzeRunning},
	}
	if err := s.Store.CreateProject(ctx, p); err != nil {
		_ = s.Modal.CancelJob(ctx, resp.JobID)
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.Log(ctx).Info("project created",
		"project_id", id, "uid", user.UID, "analyze_job_id", resp.JobID)
	httpx.WriteOK(w, s.projectResponse(p, nil))
}

// GET /v1/projects — active projects; ?archived=1 lists archived ones
// instead (restorable via PATCH {archived: false}).
func (s *Service) HandleListProjects(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	wantArchived := r.URL.Query().Get("archived") == "1"
	projects, err := s.Store.ListUserProjects(ctx, user.UID, 50)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	out := make([]map[string]any, 0, len(projects))
	for _, p := range projects {
		if p.Archived != wantArchived {
			continue
		}
		// Read-through poll for running analyzes so list polling (the
		// Projects screen) sees live progress, not just the reconciler's
		// 60s-stale state.
		if p.Analyze.State == store.AnalyzeRunning {
			if refreshed, rerr := s.refreshAnalyze(ctx, p); rerr == nil && refreshed != nil {
				p = refreshed
			}
		}
		out = append(out, s.projectResponse(p, nil))
	}
	httpx.WriteOK(w, map[string]any{"projects": out})
}

// PATCH /v1/projects/{id} {name?, pinned?, archived?} — project management
// metadata. archived:true runs the full archive flow (cancels active
// conversions, same as DELETE); archived:false restores.
func (s *Service) HandleUpdateProject(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	if _, err := s.ownedProject(ctx, user, id); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	var req struct {
		Name     *string `json:"name"`
		Pinned   *bool   `json:"pinned"`
		Archived *bool   `json:"archived"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	if req.Name == nil && req.Pinned == nil && req.Archived == nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("body needs at least one of name, pinned, archived"))
		return
	}
	if req.Name != nil && len(strings.TrimSpace(*req.Name)) > maxProjectNameLen {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid(fmt.Sprintf("name must be at most %d characters", maxProjectNameLen)))
		return
	}
	if req.Archived != nil && *req.Archived {
		// Archiving cancels in-flight work first, exactly like DELETE.
		s.cancelActiveConversions(ctx, id)
	}
	p, err := s.Store.UpdateProject(ctx, id, func(pp *store.Project) error {
		if req.Name != nil {
			pp.Name = strings.TrimSpace(*req.Name)
		}
		if req.Pinned != nil {
			pp.Pinned = *req.Pinned
		}
		if req.Archived != nil {
			pp.Archived = *req.Archived
		}
		return nil
	})
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.Log(ctx).Info("project updated", "project_id", id, "uid", user.UID,
		"pinned", p.Pinned, "archived", p.Archived)
	httpx.WriteOK(w, s.projectResponse(p, nil))
}

const maxProjectNameLen = 120

// GET /v1/projects/{id}
func (s *Service) HandleGetProject(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	p, err := s.ownedProject(ctx, user, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if refreshed, rerr := s.refreshAnalyze(ctx, p); rerr == nil && refreshed != nil {
		p = refreshed
	}
	if refreshed, rerr := s.refreshProfile(ctx, p); rerr == nil && refreshed != nil {
		p = refreshed
	}
	convs, err := s.Store.ListProjectConversions(ctx, id, 100)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	convOut := make([]map[string]any, 0, len(convs))
	for _, c := range convs {
		convOut = append(convOut, s.conversionResponse(c, nil))
	}
	httpx.WriteOK(w, s.projectResponse(p, convOut))
}

// cancelActiveConversions cancels every non-terminal conversion of a project
// (releasing payment holds); errors on individual conversions are tolerated —
// the reconciler sweeps whatever a concurrent settle left behind.
func (s *Service) cancelActiveConversions(ctx context.Context, projectID string) {
	convs, err := s.Store.ListProjectConversions(ctx, projectID, 100)
	if err != nil {
		httpx.Log(ctx).Error("archive: list conversions failed", "project_id", projectID, "err", err)
		return
	}
	for _, c := range convs {
		if store.IsTerminal(c.State) {
			continue
		}
		canceled, terr := s.Store.Transition(ctx, c.ID, store.ActiveStates, func(cc *store.Conversion) error {
			cc.State = store.StateCanceled
			cc.Stripe.PIStatus = store.PICancelPending
			return nil
		})
		if terr != nil {
			continue // settled concurrently — fine
		}
		if canceled.Modal.JobID != "" {
			_ = s.Modal.CancelJob(ctx, canceled.Modal.JobID)
		}
		_, _ = s.releaseHold(ctx, canceled)
	}
}

// DELETE /v1/projects/{id} — archive + cancel active conversions.
func (s *Service) HandleArchiveProject(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	if _, err := s.ownedProject(ctx, user, id); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	s.cancelActiveConversions(ctx, id)
	p, err := s.Store.UpdateProject(ctx, id, func(pp *store.Project) error {
		pp.Archived = true
		return nil
	})
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.Log(ctx).Info("project archived", "project_id", id, "uid", user.UID)
	httpx.WriteOK(w, s.projectResponse(p, nil))
}

// POST /v1/projects/{id}/profile — start the FREE standalone shot-profiling
// job: the adaptive profiler runs over the analyze proxy + CURRENT cuts and
// its depth script folds into project.scene_profile, so the Stereo page has
// measured per-scene defaults before the first paid render.
func (s *Service) HandleProfileProject(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	p, err := s.ownedProject(ctx, user, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if p.Analyze.State != store.AnalyzeSucceeded || p.Scenes == nil {
		httpx.WriteErr(ctx, w, httpx.ErrConflict("profiling needs a completed analysis"))
		return
	}
	if p.PreviewURL == "" {
		httpx.WriteErr(ctx, w, httpx.ErrConflict("project has no preview proxy to profile"))
		return
	}
	if p.Profile != nil && p.Profile.State == "running" {
		httpx.WriteErr(ctx, w, httpx.ErrConflict("a profiling job is already running"))
		return
	}
	proxyKey, kerr := s.GCS.KeyFromPublicURL(p.PreviewURL)
	if kerr != nil || !s.GCS.InPrefix(proxyKey) {
		httpx.WriteErr(ctx, w, httpx.ErrConflict("preview proxy is not addressable for profiling"))
		return
	}
	cuts := p.Scenes.Cuts
	if cuts == nil {
		cuts = []int{}
	}
	resp, merr := s.Modal.SubmitProfile(ctx, map[string]any{
		"input_path": proxyKey,
		"scene_cuts": cuts,
		"notify":     false,
	})
	if merr != nil {
		httpx.Log(ctx).Error("profile submit failed", "project_id", id, "err", merr)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "upstream_error",
			"profiling could not be started; try again"))
		return
	}
	updated, uerr := s.Store.UpdateProject(ctx, id, func(pp *store.Project) error {
		pp.Profile = &store.ProfileJob{
			JobID:         resp.JobID,
			State:         "running",
			ScenesVersion: pp.Scenes.Version,
			UpdatedAt:     time.Now().UTC(),
		}
		return nil
	})
	if uerr != nil {
		httpx.WriteErr(ctx, w, uerr)
		return
	}
	httpx.Log(ctx).Info("profile started",
		"project_id", id, "uid", user.UID, "profile_job_id", resp.JobID)
	httpx.WriteOK(w, s.projectResponse(updated, nil))
}

// ------------------------------------------------------------- scene edits

// PATCH /v1/projects/{id}/scenes {cuts: [int], expect_version: int}
func (s *Service) HandleUpdateScenes(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	p, err := s.ownedProject(ctx, user, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	var req struct {
		Cuts          []int `json:"cuts"`
		ExpectVersion *int  `json:"expect_version"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Cuts == nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("body needs cuts: [int] (source-frame indices)"))
		return
	}
	if p.Probe == nil {
		httpx.WriteErr(ctx, w, httpx.ErrConflict("analysis has not completed yet"))
		return
	}
	for i, c := range req.Cuts {
		if c <= 0 || c >= p.Probe.NumFrames {
			httpx.WriteErr(ctx, w, httpx.ErrInvalid("cuts must be source-frame indices in (0, num_frames)"))
			return
		}
		if i > 0 && c <= req.Cuts[i-1] {
			httpx.WriteErr(ctx, w, httpx.ErrInvalid("cuts must be strictly increasing"))
			return
		}
	}
	expect := -1
	if req.ExpectVersion != nil {
		expect = *req.ExpectVersion
	}
	updated, err := s.Store.UpdateScenes(ctx, id, req.Cuts, expect)
	if errors.Is(err, store.ErrStateConflict) {
		httpx.WriteErr(ctx, w, httpx.ErrConflict("scene list changed since you loaded it — reload and retry"))
		return
	}
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.Log(ctx).Info("scenes updated",
		"project_id", id, "uid", user.UID, "version", updated.Scenes.Version, "cuts", len(req.Cuts))
	httpx.WriteOK(w, map[string]any{"scenes": updated.Scenes})
}

// ------------------------------------------------------- quotes/conversions

type stepConvReq struct {
	Step           string             `json:"step"`
	Preset         string             `json:"preset"`
	Formats        []string           `json:"formats"`
	Displacement   float64            `json:"displacement"` // legacy knob — rejected on pro steps (use scene_overrides / depth_scale)
	TargetFPS      float64            `json:"target_fps"`
	FromFrame      int                `json:"from_frame"`
	ToFrame        int                `json:"to_frame"`
	DepthRes       int                `json:"depth_res"`   // depth inference resolution: multiple of 14 in [140, 2520]
	DepthScale     float64            `json:"depth_scale"` // global scale on the adaptive depth script: [0.3, 1.5]
	Inpaint        string             `json:"inpaint"`     // none | propainter (stereo_preview + production)
	SceneOverrides []sceneOverrideReq `json:"scene_overrides"`
	FromScratch    bool               `json:"from_scratch"` // bypass content-addressed reuse
	AppVersion     string             `json:"app_version"`
	Platform       string             `json:"platform"`
}

// sceneOverrideReq is a per-scene stereo tweak; `first` is the scene's first
// SOURCE frame (0 or a current scene_cuts value). At least one override key
// (displacement, shot_type, placement) is required.
type sceneOverrideReq struct {
	First        int       `json:"first"`
	Displacement float64   `json:"displacement"`
	ShotType     string    `json:"shot_type"`
	Placement    []float64 `json:"placement"`
	// Passthrough ships the scene as 2D (both eyes = untouched source, no
	// warp/inpaint) — end credits etc. Mutually exclusive with the depth
	// knobs above.
	Passthrough bool `json:"passthrough"`
}

var allowedShotTypes = []string{"close_up", "standard", "dynamic", "wide"}
var allowedInpaint = []string{"none", "propainter"}

// depth_res rails mirror the Modal API contract exactly.
const (
	minDepthRes   = 140
	maxDepthRes   = 2520
	minDepthScale = 0.3
	maxDepthScale = 1.5
	maxPlacement  = 1.5
)

// depthB200MaxMP mirrors B200_MAX_MP in app/pipelines/video.py. Modal routes
// the depth GPU by WORKING MEGAPIXELS — depth_res² × elongation (elongation =
// long_side / short_side ≥ 1) — and FAILS FAST above the B200 (largest) tier.
// The flat [140, 2520] rail is only valid on near-square aspects; a wide source
// blows past this ceiling at a depth_res the rail otherwise allows (e.g. a
// 2.39:1 source at depth_res 2156 → 11.11 MP). We reject that here so the user
// gets an actionable 4xx instead of an opaque failure from Modal mid-job.
const depthB200MaxMP = 8.5

// depthWorkMP is the depth model's working megapixels for a given depth_res and
// source aspect: depth_res² × (long/short) / 1e6. Keep in lockstep with
// _route_depth_gpu in app/pipelines/video.py.
func depthWorkMP(depthRes, width, height int) float64 {
	long := max(width, height)
	short := max(min(width, height), 1)
	elongation := float64(long) / float64(short)
	return float64(depthRes) * float64(depthRes) * elongation / 1e6
}

// depthContentDims returns the dimensions the depth stage actually works on.
// Preprocess removes letterbox/pillarbox bars before depth runs, and Modal
// enforces the VRAM ceiling on that POST-CROP work file — so a 2.39:1 film
// delivered in a 16:9 container must be validated at 2.39:1, not at the
// container aspect (which passes values Modal then rejects mid-job). Analyze
// stores the detected crop on the project as "W:H:X:Y"; use its W×H when
// parseable, else fall back to the container probe. cropped reports whether
// the crop changed the dims (for the error message).
func depthContentDims(p *store.Project) (width, height int, cropped bool) {
	if p.Probe == nil || p.Probe.Width <= 0 || p.Probe.Height <= 0 {
		return 0, 0, false
	}
	if p.Crop != "" {
		var w, h, x, y int
		if n, err := fmt.Sscanf(p.Crop, "%d:%d:%d:%d", &w, &h, &x, &y); n == 4 && err == nil && w > 0 && h > 0 {
			return w, h, w != p.Probe.Width || h != p.Probe.Height
		}
	}
	return p.Probe.Width, p.Probe.Height, false
}

// resolveStepParams clamps the request into a step template. Only fields
// validated here reach Modal (via modalBody). All pro steps run the adaptive
// per-shot profiler upstream (modalBody sets adaptive=true); scene_overrides
// and depth_scale are the user's handles on it.
func resolveStepParams(req *stepConvReq, p *store.Project) (store.Params, *httpx.APIError) {
	var params store.Params
	switch req.Step {
	case store.StepDepthPreview:
		// The Depth page: pick the FINAL depth resolution here — production
		// reuses the depth artifact when depth_res + fps match. Formats stay
		// anaglyph (cheap); the UI centers the depth_vis output.
		params.Preset = "draft"
		params.Formats = []string{"anaglyph"}
		params.Inpaint = "none"
		params.TargetFPS = halfSourceFPS(p)
	case store.StepStereoPreview:
		params.Preset = "1080p"
		params.Formats = []string{"sbs"} // industry-standard preview default
		params.Inpaint = "none"
		params.TargetFPS = halfSourceFPS(p)
	case store.StepProduction:
		params.Preset = "1080p"
		params.Formats = []string{"mvhevc", "half_sbs"}
		params.Inpaint = "propainter"
	default:
		return params, httpx.ErrInvalid("step must be depth_preview|stereo_preview|production")
	}
	if req.Preset != "" && req.Step != store.StepDepthPreview {
		if !slices.Contains(allowedPresets, req.Preset) {
			return params, httpx.ErrInvalid("preset must be one of " + strings.Join(allowedPresets, "|"))
		}
		params.Preset = req.Preset
	}
	if len(req.Formats) > 0 && req.Step != store.StepDepthPreview {
		for _, f := range req.Formats {
			if !slices.Contains(allowedFormats, f) {
				return params, httpx.ErrInvalid("unsupported format " + f)
			}
		}
		params.Formats = req.Formats
	}
	// Global displacement is the legacy mobile knob; the pro pipeline's
	// equivalents are scene_overrides[].displacement and depth_scale.
	if req.Displacement != 0 {
		return params, httpx.ErrInvalid("displacement is not a pro-step parameter; use scene_overrides[].displacement or depth_scale")
	}
	if req.DepthRes != 0 {
		if req.DepthRes < minDepthRes || req.DepthRes > maxDepthRes || req.DepthRes%14 != 0 {
			return params, httpx.ErrInvalid(fmt.Sprintf(
				"depth_res %d invalid: must be a multiple of 14 in [%d, %d]", req.DepthRes, minDepthRes, maxDepthRes))
		}
		// Aspect-aware VRAM ceiling: mirror Modal's work_mp = depth_res² ×
		// elongation ≤ B200_MAX_MP. The flat rail above passes wide-aspect
		// values Modal cannot fit; reject them here with the largest depth_res
		// this source's aspect actually allows. Dims are POST-CROP (see
		// depthContentDims): Modal checks the ceiling on the bar-removed work
		// file, so a letterboxed wide film binds at its content aspect.
		if w, h, cropped := depthContentDims(p); w > 0 && h > 0 {
			if mp := depthWorkMP(req.DepthRes, w, h); mp > depthB200MaxMP {
				long := max(w, h)
				short := max(min(w, h), 1)
				elongation := float64(long) / float64(short)
				// max depth_res = floor(sqrt(ceiling / elongation)) rounded down to ×14
				maxRes := int(math.Sqrt(depthB200MaxMP*1e6/elongation)) / 14 * 14
				aspect := fmt.Sprintf("%.2f:1 aspect", elongation)
				if cropped {
					aspect += " after black-bar crop"
				}
				return params, httpx.ErrInvalid(fmt.Sprintf(
					"depth_res %d too high for this source: %.2f MP/frame (%s) exceeds the GPU VRAM ceiling (~%.1f MP). Lower depth_res to at most %d.",
					req.DepthRes, mp, aspect, depthB200MaxMP, maxRes))
			}
		}
		params.DepthRes = req.DepthRes
	}
	if req.Inpaint != "" {
		if !slices.Contains(allowedInpaint, req.Inpaint) {
			return params, httpx.ErrInvalid("inpaint must be none|propainter")
		}
		if req.Step == store.StepDepthPreview && req.Inpaint != "none" {
			return params, httpx.ErrInvalid("inpaint is fixed to none for depth_preview")
		}
		params.Inpaint = req.Inpaint
	}
	if req.DepthScale != 0 {
		if req.Step == store.StepDepthPreview {
			return params, httpx.ErrInvalid("depth_scale applies to stereo_preview and production only")
		}
		if req.DepthScale < minDepthScale || req.DepthScale > maxDepthScale {
			return params, httpx.ErrInvalid(fmt.Sprintf(
				"depth_scale %g invalid: must be in [%g, %g]", req.DepthScale, minDepthScale, maxDepthScale))
		}
		params.DepthScale = req.DepthScale
	}
	if len(req.SceneOverrides) > 0 {
		if p.Scenes == nil {
			return params, httpx.ErrInvalid("scene_overrides need a completed analysis (project has no scene list yet)")
		}
		overrides, oerr := validateSceneOverrides(req.SceneOverrides, p.Scenes.Cuts)
		if oerr != nil {
			return params, oerr
		}
		// depth_preview accepts PASSTHROUGH-ONLY overrides: a passthrough
		// scene ships as 2D, so Modal skips its AI depth pass and writes
		// black depth. The depth knobs (displacement/shot_type/placement)
		// style the stereo warp and are meaningless on the depth step.
		if req.Step == store.StepDepthPreview {
			for i, o := range overrides {
				if !o.Passthrough {
					return params, httpx.ErrInvalid(fmt.Sprintf(
						"scene_overrides[%d]: depth_preview accepts passthrough only; displacement/shot_type/placement apply to stereo_preview and production", i))
				}
			}
		}
		params.SceneOverrides = overrides
	}
	// 0.1% tolerance so a client sending "23.98" for a 23.976 source passes
	if req.TargetFPS < 0 || req.TargetFPS > maxTargetFPS(p)*1.001 {
		return params, httpx.ErrInvalid("target_fps cannot exceed the source frame rate")
	}
	if req.TargetFPS > 0 {
		params.TargetFPS = req.TargetFPS
	}
	if req.Step == store.StepProduction && req.TargetFPS == 0 {
		params.TargetFPS = 0 // full source fps
	}
	if req.FromFrame < 0 || req.ToFrame < 0 ||
		(req.ToFrame > 0 && req.ToFrame <= req.FromFrame) ||
		(p.Probe != nil && req.FromFrame >= p.Probe.NumFrames) {
		return params, httpx.ErrInvalid("invalid trim range: need 0 <= from_frame < to_frame <= num_frames")
	}
	params.FromFrame, params.ToFrame = req.FromFrame, req.ToFrame
	params.SkipReuse = req.FromScratch
	if p.Scenes != nil {
		params.SceneCuts = p.Scenes.Cuts
	}
	return params, nil
}

// validateSceneOverrides checks each override against the project's CURRENT
// scene cuts. Error messages carry the failing index/value so a support
// ticket quoting the response is diagnosable without a repro.
func validateSceneOverrides(reqs []sceneOverrideReq, cuts []int) ([]store.SceneOverride, *httpx.APIError) {
	out := make([]store.SceneOverride, 0, len(reqs))
	prev := -1
	for i, o := range reqs {
		if o.First != 0 && !slices.Contains(cuts, o.First) {
			return nil, httpx.ErrInvalid(fmt.Sprintf(
				"scene_overrides[%d].first=%d is not a scene start: must be 0 or one of the project's current scene cuts", i, o.First))
		}
		if o.First <= prev {
			return nil, httpx.ErrInvalid(fmt.Sprintf(
				"scene_overrides[%d].first=%d: firsts must be strictly increasing", i, o.First))
		}
		prev = o.First
		so := store.SceneOverride{First: o.First}
		hasKey := false
		if o.Displacement != 0 {
			if o.Displacement < 0 || o.Displacement > maxDisplacement {
				return nil, httpx.ErrInvalid(fmt.Sprintf(
					"scene_overrides[%d].displacement=%g invalid: must be in (0, %g]", i, o.Displacement, maxDisplacement))
			}
			so.Displacement = o.Displacement
			hasKey = true
		}
		if o.ShotType != "" {
			if !slices.Contains(allowedShotTypes, o.ShotType) {
				return nil, httpx.ErrInvalid(fmt.Sprintf(
					"scene_overrides[%d].shot_type=%q invalid: must be %s", i, o.ShotType, strings.Join(allowedShotTypes, "|")))
			}
			so.ShotType = o.ShotType
			hasKey = true
		}
		if o.Placement != nil {
			if len(o.Placement) != 2 || o.Placement[0] >= o.Placement[1] ||
				o.Placement[0] < -maxPlacement || o.Placement[1] > maxPlacement {
				return nil, httpx.ErrInvalid(fmt.Sprintf(
					"scene_overrides[%d].placement invalid: need [far, near] with -%g <= far < near <= %g", i, maxPlacement, maxPlacement))
			}
			so.Placement = o.Placement
			hasKey = true
		}
		if o.Passthrough {
			if hasKey {
				return nil, httpx.ErrInvalid(fmt.Sprintf(
					"scene_overrides[%d]: passthrough cannot be combined with displacement, shot_type, or placement", i))
			}
			so.Passthrough = true
			hasKey = true
		}
		if !hasKey {
			return nil, httpx.ErrInvalid(fmt.Sprintf(
				"scene_overrides[%d] has no override keys: need at least one of displacement, shot_type, placement, passthrough", i))
		}
		out = append(out, so)
	}
	return out, nil
}

// quoteStep prices a step for a project, returning the quote plus which
// reuse discounts applied. peekCredit previews the analyze credit without
// consuming it (quote endpoint); creditCents applies an already-consumed
// amount (conversion create).
func (s *Service) quoteStep(ctx context.Context, p *store.Project, params store.Params,
	step string, creditCents int64) (*store.Quote, []string, *httpx.APIError) {
	if p.Probe == nil {
		return nil, nil, httpx.ErrConflict("analysis has not completed yet")
	}
	billable, berr := billableSeconds(p.Probe.NumFrames, p.Probe.FPS, params.FromFrame, params.ToFrame)
	if berr != nil {
		return nil, nil, berr
	}
	// Reuse discount (production, unless from-scratch): ask Modal's
	// content-addressed cache whether prior artifacts match these params.
	// Non-nil so reuse_stages serializes as [] (never null) in responses.
	reuseStages := []string{}
	if step == store.StepProduction && !params.SkipReuse {
		lookup, err := s.Modal.LookupReuse(ctx, s.reuseLookupBody(p, params))
		if err != nil {
			httpx.Log(ctx).Warn("reuse lookup failed (quoting full price)", "project_id", p.ID, "err", err)
		} else {
			if lookup.Depth.Cached {
				reuseStages = append(reuseStages, "depth")
			}
			if lookup.Preprocess.Cached {
				reuseStages = append(reuseStages, "preprocess")
			}
		}
	}
	in := s.stepQuoteInputs(p, params, step, billable)
	in.ReuseStages = reuseStages
	in.CreditCents = creditCents
	q, err := s.Pricing.QuoteStep(ctx, in)
	if err != nil {
		return nil, nil, httpx.ErrInvalid(err.Error())
	}
	return &store.Quote{
		AmountCents: q.AmountCents, Currency: q.Currency,
		RateVersion: q.RateVersion, Breakdown: q.Breakdown,
	}, reuseStages, nil
}

// stepQuoteInputs assembles the shape-knobs QuoteStep/EstimateStepETA price
// on: POST-CROP content dims (the depth stage works on the bar-removed
// frame, so a letterboxed 2.39:1 film prices at 2.39:1 — same dims the VRAM
// rail validates) and the effective frame rate the job renders at
// (target_fps, else the source rate).
func (s *Service) stepQuoteInputs(p *store.Project, params store.Params, step string, billable float64) pricing.StepInputs {
	in := pricing.StepInputs{
		Step:      step,
		Preset:    params.Preset,
		BillableS: billable,
		DepthRes:  params.DepthRes,
		Inpaint:   params.Inpaint,
	}
	if in.DepthRes == 0 {
		in.DepthRes = pricing.PresetInputSize[params.Preset] // 0 stays 0 for unknown presets
	}
	if w, h, _ := depthContentDims(p); w > 0 && h > 0 {
		in.ContentWidth, in.ContentHeight = w, h
	}
	in.EffectiveFPS = params.TargetFPS
	if in.EffectiveFPS <= 0 && p.Probe != nil {
		in.EffectiveFPS = p.Probe.FPS
	}
	return in
}

// reuseLookupBody mirrors modalBody's key-affecting fields for /v1/reuse/lookup.
// depth_res + adaptive shape the depth artifact key (the whole point of the
// Depth page: production reuses the depth pass when depth_res/fps match).
func (s *Service) reuseLookupBody(p *store.Project, params store.Params) map[string]any {
	body := map[string]any{"input_path": p.Source.GCSKey, "preset": params.Preset, "adaptive": true}
	// scene_cuts is part of the depth reuse key ("user" cuts vs "auto"
	// detection are distinct artifacts) — the lookup must mirror the submit
	// body exactly or the depth discount never fires. Always sent, [] means
	// one scene; nil would marshal to null (= absent) and key as "auto".
	cuts := params.SceneCuts
	if cuts == nil {
		cuts = []int{}
	}
	body["scene_cuts"] = cuts
	// scene_overrides too: the passthrough subset is part of the depth key
	// (passthrough scenes carry BLACK depth — a different passthrough set
	// is a different artifact), so omitting it here would misprice the
	// depth discount whenever any scene is 2D.
	if len(params.SceneOverrides) > 0 {
		body["scene_overrides"] = encodeSceneOverrides(params.SceneOverrides)
	}
	if params.DepthRes > 0 {
		body["depth_res"] = params.DepthRes
	}
	if params.TargetFPS > 0 {
		body["target_fps"] = params.TargetFPS
	}
	if params.FromFrame > 0 {
		body["from_frame"] = params.FromFrame
	}
	if params.ToFrame > 0 {
		body["to_frame"] = params.ToFrame
	}
	return body
}

// POST /v1/projects/{id}/quotes — price a step without committing anything.
func (s *Service) HandleQuoteStep(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	p, err := s.ownedProject(ctx, user, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	var req stepConvReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	params, perr := resolveStepParams(&req, p)
	if perr != nil {
		httpx.WriteErr(ctx, w, perr)
		return
	}
	// Preview the credit without consuming it.
	credit := int64(0)
	if p.Analyze.State == store.AnalyzeSucceeded && p.Analyze.CreditConsumedBy == "" {
		credit = p.Analyze.CreditCents
	}
	quote, reuseStages, qerr := s.quoteStep(ctx, p, params, req.Step, credit)
	if qerr != nil {
		httpx.WriteErr(ctx, w, qerr)
		return
	}
	resp := map[string]any{
		"step":         req.Step,
		"params":       params,
		"quote":        quote,
		"reuse_stages": reuseStages,
	}
	// Pre-run wall-clock estimate for the same knobs the quote priced.
	if billable, berr := billableSeconds(p.Probe.NumFrames, p.Probe.FPS, params.FromFrame, params.ToFrame); berr == nil {
		in := s.stepQuoteInputs(p, params, req.Step, billable)
		in.ReuseStages = reuseStages
		resp["eta_seconds"] = s.Pricing.EstimateStepETA(ctx, in)
	}
	httpx.WriteOK(w, resp)
}

// POST /v1/projects/{id}/conversions — create a paid step conversion.
// Pay-as-you-go: billing is verified up front (402 with no_payment_method /
// billing_overdue otherwise), the job starts immediately, and the saved card
// is charged the quoted amount only when the conversion succeeds. There is
// no client-side payment confirmation step.
func (s *Service) HandleCreateStepConversion(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	p, err := s.ownedProject(ctx, user, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey != "" {
		prior, ferr := s.Store.FindByIdemKey(ctx, user.UID, idemKey)
		if ferr != nil && !errors.Is(ferr, store.ErrNotFound) {
			httpx.WriteErr(ctx, w, ferr)
			return
		}
		if ferr == nil {
			// Replays of a hold still awaiting 3DS re-serve the same billing
			// material (client_secret is stored on the record).
			httpx.WriteOK(w, s.conversionResponse(prior, nil))
			return
		}
	}

	var req stepConvReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	params, perr := resolveStepParams(&req, p)
	if perr != nil {
		httpx.WriteErr(ctx, w, perr)
		return
	}
	// Billing gate BEFORE any commitment: a saved card and no outstanding
	// failed charge, or the step never starts.
	cust, berr := s.requireBillable(ctx, user)
	if berr != nil {
		httpx.WriteErr(ctx, w, berr)
		return
	}
	rates := s.Pricing.Rates(ctx)
	if n, cerr := s.Store.CountActiveForUser(ctx, user.UID); cerr != nil {
		httpx.WriteErr(ctx, w, cerr)
		return
	} else if n >= rates.MaxActivePerUser {
		httpx.WriteErr(ctx, w, httpx.ErrConflict("too many active conversions; wait for one to finish"))
		return
	}

	convID := store.NewID()
	// Consume the analyze credit atomically for THIS conversion; every
	// failure path from here restores it.
	credit, cerr := s.Store.ConsumeAnalyzeCredit(ctx, p.ID, convID)
	if cerr != nil {
		httpx.WriteErr(ctx, w, cerr)
		return
	}
	conv := &store.Conversion{
		ID: convID, UID: user.UID, Env: s.Cfg.Env, Kind: "video",
		ProjectID: p.ID, Step: req.Step,
		Client: store.Client{AppVersion: req.AppVersion, Platform: req.Platform},
		Source: store.Source{
			GCSKey: p.Source.GCSKey, Bytes: p.Source.Bytes,
			DurationS: probeDuration(p), Frames: probeFrames(p),
			FPS: probeFPS(p), Width: probeWidth(p), Height: probeHeight(p),
		},
		Params:  params,
		IdemKey: idemKey,
	}
	stampScenes(conv, p)
	quote, _, qerr := s.quoteStep(ctx, p, params, req.Step, credit)
	if qerr != nil {
		s.restoreCredit(ctx, conv)
		httpx.WriteErr(ctx, w, qerr)
		return
	}
	conv.Quote = *quote

	// Threshold hybrid: expensive runs get an off-session hold up front (the
	// bank re-approves the money BEFORE GPU spend; capture on success), cheap
	// runs skip the hold and charge the saved card on success.
	if quote.AmountCents >= holdThresholdCents {
		conv.Stripe = store.Stripe{CustomerID: cust.StripeCustomerID, Mode: store.BillingModeAutoHold}
		pi, herr := s.Stripe.CreateOffSessionHold(cust.StripeCustomerID, cust.DefaultPaymentMethod,
			quote.AmountCents, quote.Currency, conv.ID, user.UID)
		if herr != nil {
			fail := stripex.ClassifyChargeError(herr)
			if fail.NeedsAction && fail.PaymentIntentID != "" {
				// Bank wants 3DS. Persist the record at "created" carrying the
				// PI; the client confirms with the saved card and the
				// amount_capturable_updated webhook flips it to paid.
				conv.State = store.StateCreated
				conv.Stripe.PaymentIntentID = fail.PaymentIntentID
				if got, gerr := s.Stripe.GetPaymentIntent(fail.PaymentIntentID); gerr == nil {
					conv.Stripe.ClientSecret = got.ClientSecret
				}
				if err := s.Store.CreateConversion(ctx, conv); err != nil {
					_ = s.Stripe.CancelHold(fail.PaymentIntentID)
					s.restoreCredit(ctx, conv)
					httpx.WriteErr(ctx, w, err)
					return
				}
				httpx.Log(ctx).Info("hold requires authentication",
					"conversion_id", conv.ID, "uid", user.UID, "payment_intent", fail.PaymentIntentID)
				httpx.WriteOK(w, s.conversionResponse(conv, nil))
				return
			}
			s.restoreCredit(ctx, conv)
			if fail.Transient {
				httpx.Log(ctx).Error("stripe hold failed", "conversion_id", conv.ID, "err", herr)
				httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error",
					"could not reserve the payment; try again"))
				return
			}
			httpx.Log(ctx).Info("hold declined",
				"conversion_id", conv.ID, "uid", user.UID, "code", fail.Code)
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusPaymentRequired, "card_declined",
				"your card declined the payment hold — update your payment method and retry"))
			return
		}
		if pi.Status == stripe.PaymentIntentStatusRequiresAction ||
			pi.Status == stripe.PaymentIntentStatusRequiresConfirmation {
			// Defensive: some flows return the PI in requires_action without
			// raising authentication_required.
			conv.State = store.StateCreated
			conv.Stripe.PaymentIntentID = pi.ID
			conv.Stripe.ClientSecret = pi.ClientSecret
		} else {
			conv.State = store.StatePaid
			conv.Stripe.PaymentIntentID = pi.ID
			conv.Stripe.PIStatus = string(pi.Status)
		}
	} else {
		// Enters at "paid": billing verified, cleared for submission (no
		// client payment confirmation step in auto mode).
		conv.State = store.StatePaid
		conv.Stripe = store.Stripe{CustomerID: cust.StripeCustomerID, Mode: store.BillingModeAuto}
	}
	if err := s.Store.CreateConversion(ctx, conv); err != nil {
		if conv.Stripe.PaymentIntentID != "" {
			_ = s.Stripe.CancelHold(conv.Stripe.PaymentIntentID)
		}
		s.restoreCredit(ctx, conv)
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.Log(ctx).Info("conversion created",
		"conversion_id", conv.ID, "uid", user.UID, "kind", conv.Kind,
		"step", conv.Step, "project_id", conv.ProjectID, "billing_mode", conv.Stripe.Mode,
		"amount_cents", conv.Quote.AmountCents, "payment_intent", conv.Stripe.PaymentIntentID)
	// Submit inline for latency; on failure the reconciler re-drives paid
	// conversions until paidTTL.
	if serr := s.submitToModal(ctx, conv.ID); serr != nil {
		httpx.Log(ctx).Warn("inline submit failed; reconciler will retry",
			"conversion_id", conv.ID, "err", serr)
	} else if fresh, gerr := s.Store.GetConversion(ctx, conv.ID); gerr == nil {
		conv = fresh // reflect processing state in the response
	}
	httpx.WriteOK(w, s.conversionResponse(conv, nil))
}

// ---------------------------------------------------------------- helpers

// stampScenes snapshots the scene-list version the conversion's params
// (scene_cuts AND scene_overrides firsts) were validated against, so a later
// cut edit is detectable on any past run.
func stampScenes(conv *store.Conversion, p *store.Project) {
	if p.Scenes != nil {
		conv.ScenesVer = p.Scenes.Version
	}
}

func (s *Service) ownedProject(ctx context.Context, user *AuthedUser, id string) (*store.Project, error) {
	p, err := s.Store.GetProject(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, httpx.ErrNotFound("project")
	}
	if err != nil {
		return nil, err
	}
	if p.UID != user.UID {
		return nil, httpx.ErrNotFound("project") // 404, don't confirm existence
	}
	return p, nil
}

func analyzeResponse(a *store.Analyze) map[string]any {
	resp := map[string]any{
		"state":            a.State,
		"error":            a.Error,
		"credit_cents":     a.CreditCents,
		"credit_available": a.State == store.AnalyzeSucceeded && a.CreditConsumedBy == "",
	}
	if a.State == store.AnalyzeRunning {
		resp["progress"] = a.Progress
		resp["stage"] = a.Stage
		if a.ETASeconds > 0 {
			resp["eta_seconds"] = a.ETASeconds
		}
	}
	return resp
}

func (s *Service) projectResponse(p *store.Project, conversions []map[string]any) map[string]any {
	resp := map[string]any{
		"project_id":   p.ID,
		"name":         p.Name,
		"source_bytes": p.Source.Bytes,
		"analyze":      analyzeResponse(&p.Analyze),
		"archived":     p.Archived,
		"pinned":       p.Pinned,
		"created_at":   p.CreatedAt.Format(time.RFC3339),
		"updated_at":   p.UpdatedAt.Format(time.RFC3339),
	}
	if p.Probe != nil {
		resp["probe"] = p.Probe
	}
	if p.Scenes != nil {
		resp["scenes"] = p.Scenes
	}
	if p.SceneProfile != nil {
		resp["scene_profile"] = p.SceneProfile
	}
	if p.Profile != nil {
		resp["profile"] = p.Profile
	}
	if p.Crop != "" {
		resp["crop"] = p.Crop
	}
	if p.PreviewURL != "" {
		resp["preview_url"] = p.PreviewURL
	}
	if len(p.StripThumbs) > 0 {
		resp["strip_thumbs"] = p.StripThumbs
		resp["scene_thumbs"] = p.SceneThumbs
	}
	if conversions != nil {
		resp["conversions"] = conversions
	}
	return resp
}

func probeDuration(p *store.Project) float64 {
	if p.Probe == nil {
		return 0
	}
	return p.Probe.DurationS
}
func probeFrames(p *store.Project) int {
	if p.Probe == nil {
		return 0
	}
	return p.Probe.NumFrames
}
func probeFPS(p *store.Project) float64 {
	if p.Probe == nil {
		return 0
	}
	return p.Probe.FPS
}
func probeWidth(p *store.Project) int {
	if p.Probe == nil {
		return 0
	}
	return p.Probe.Width
}
func probeHeight(p *store.Project) int {
	if p.Probe == nil {
		return 0
	}
	return p.Probe.Height
}
