// Package api: HTTP handlers and the conversion orchestration shared by the
// webhook, the reconciler sweep, and read-through polling on GET.
//
// Money invariant: every state transition that implies a Stripe action is
// committed FIRST with pi_status capture_pending/cancel_pending, and the
// Stripe call happens after. A crash between the two leaves a pending marker
// the reconciler sweeps, so holds are never silently leaked and captures are
// never silently lost.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/auth"
	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/gcsx"
	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/notify"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

const (
	pollStaleness = 10 * time.Second // read-through poll budget on GET
	createTTL     = 24 * time.Hour   // unpaid conversions expire after this
	paidTTL       = 2 * time.Hour    // paid but unsubmittable → fail + release hold
	processingTTL = 24 * time.Hour   // hard ceiling (Modal orchestrator cap is 8h)
	uploadURLTTL  = 15 * time.Minute
	downloadTTL   = 24 * time.Hour
)

type Service struct {
	Cfg     *config.Config
	Auth    *auth.Verifier
	Store   *store.Store
	Pricing *pricing.Service
	Stripe  *stripex.Client
	Modal   *modalapi.Client
	GCS     *gcsx.Client
	Slack   *notify.Slack
}

// ---------------------------------------------------------------- submission

// submitToModal moves paid → processing. Called from the Stripe webhook and,
// as a lost-webhook fallback, from the reconciler. The paid-state transaction
// guard makes double submission impossible.
func (s *Service) submitToModal(ctx context.Context, id string) error {
	conv, err := s.Store.GetConversion(ctx, id)
	if err != nil {
		return err
	}
	if conv.State != store.StatePaid {
		return nil // already submitted (or terminal) — idempotent no-op
	}

	body := s.modalBody(conv)
	var resp *modalapi.SubmitResponse
	if conv.Kind == "image" {
		resp, err = s.Modal.SubmitImage(ctx, body)
	} else {
		resp, err = s.Modal.SubmitVideo(ctx, body)
	}
	if err != nil {
		slog.ErrorContext(ctx, "modal submit failed",
			"conversion_id", id, "uid", conv.UID, "err", err)
		// Leave state=paid: the reconciler retries until paidTTL, then fails
		// the conversion and releases the hold.
		return err
	}

	now := time.Now().UTC()
	_, err = s.Store.Transition(ctx, id, []string{store.StatePaid}, func(c *store.Conversion) error {
		c.State = store.StateProcessing
		c.Modal.JobID = resp.JobID
		c.Modal.SubmittedAt = &now
		return nil
	})
	if errors.Is(err, store.ErrStateConflict) {
		// Lost the race with another submitter; cancel the duplicate job.
		_ = s.Modal.CancelJob(ctx, resp.JobID)
		return nil
	}
	slog.InfoContext(ctx, "submitted to modal", "conversion_id", id, "modal_job_id", resp.JobID)
	return err
}

// modalBody builds the whitelisted request forwarded to Modal. Nothing from
// the client reaches Modal without being re-encoded here.
func (s *Service) modalBody(c *store.Conversion) map[string]any {
	body := map[string]any{
		"input_path": c.Source.GCSKey, // bucket-prefix-relative is accepted; full key is unambiguous
		"notify":     true,
	}
	if c.Kind == "image" {
		body["formats"] = []string{"lr"}
		if c.Params.Displacement > 0 {
			body["displacement"] = c.Params.Displacement
		}
		return body
	}
	body["preset"] = c.Params.Preset
	body["formats"] = c.Params.Formats
	if c.Params.Displacement > 0 {
		body["displacement"] = c.Params.Displacement
	}
	if c.Params.TargetFPS > 0 {
		body["target_fps"] = c.Params.TargetFPS
	}
	// trim is frame-exact, half-open [from_frame, to_frame) — never seconds
	if c.Params.FromFrame > 0 {
		body["from_frame"] = c.Params.FromFrame
	}
	if c.Params.ToFrame > 0 {
		body["to_frame"] = c.Params.ToFrame
	}
	if c.Step != "" {
		// The pro flow's cut list is authoritative and ALWAYS sent — [] means
		// "one scene", which Modal honors. Omitting an empty list would make
		// Modal re-run auto detection and silently override the user's scene
		// edit (and mistarget scene_overrides). nil-coalesce: a nil slice
		// would marshal to JSON null, which Modal reads as "absent".
		cuts := c.Params.SceneCuts
		if cuts == nil {
			cuts = []int{}
		}
		body["scene_cuts"] = cuts
	} else if len(c.Params.SceneCuts) > 0 {
		body["scene_cuts"] = c.Params.SceneCuts
	}
	if c.Params.Inpaint != "" {
		body["inpaint"] = c.Params.Inpaint
	}
	if c.Params.DepthRes > 0 {
		body["depth_res"] = c.Params.DepthRes
	}
	if c.Params.DepthScale > 0 {
		body["depth_scale"] = c.Params.DepthScale
	}
	if len(c.Params.SceneOverrides) > 0 {
		body["scene_overrides"] = encodeSceneOverrides(c.Params.SceneOverrides)
	}
	if c.Step != "" {
		// Pro steps always run the adaptive per-shot profiler (product
		// default); its depth_script is folded back into project.scene_profile
		// on success. Legacy mobile conversions keep the non-adaptive path.
		body["adaptive"] = true
	}
	if c.Params.SkipReuse { // from-scratch: nothing stale picked up silently
		body["skip_reuse_preprocess"] = true
		body["skip_reuse_depth"] = true
		body["skip_reuse_scenes"] = true
	}
	return body
}

// encodeSceneOverrides re-encodes the validated overrides into the exact
// Modal request shape — only the keys the user actually set are sent.
func encodeSceneOverrides(overrides []store.SceneOverride) []map[string]any {
	out := make([]map[string]any, 0, len(overrides))
	for _, o := range overrides {
		m := map[string]any{"first": o.First}
		if o.Displacement > 0 {
			m["displacement"] = o.Displacement
		}
		if o.ShotType != "" {
			m["shot_type"] = o.ShotType
		}
		if len(o.Placement) == 2 {
			m["placement"] = o.Placement
		}
		if o.Passthrough {
			m["passthrough"] = true
		}
		out = append(out, m)
	}
	return out
}

// ---------------------------------------------------------------- settlement

// refreshFromModal polls the Modal job behind an active conversion and
// settles terminal states. Shared by the reconciler sweep and GET
// read-through. Safe under concurrency: terminal transitions go through the
// transaction guard and Stripe calls are idempotent per PaymentIntent.
func (s *Service) refreshFromModal(ctx context.Context, conv *store.Conversion) (*store.Conversion, error) {
	if conv.State != store.StateProcessing || conv.Modal.JobID == "" {
		return conv, nil
	}
	job, err := s.Modal.GetJob(ctx, conv.Modal.JobID)
	if err != nil {
		var upstream *modalapi.UpstreamError
		if errors.As(err, &upstream) && upstream.StatusCode == 404 {
			// Modal's job Dict has ~7-day retention; a 404 means the record
			// is gone and will never come back — fail and release the hold.
			return s.settleFailure(ctx, conv, "job record lost upstream (404): "+conv.Modal.JobID)
		}
		if conv.Modal.SubmittedAt != nil && time.Since(*conv.Modal.SubmittedAt) > processingTTL {
			return s.settleFailure(ctx, conv, fmt.Sprintf("processing exceeded %s; last poll error: %v", processingTTL, err))
		}
		slog.WarnContext(ctx, "modal poll failed", "conversion_id", conv.ID, "err", err)
		return conv, nil // transient; next poll retries
	}

	now := time.Now().UTC()
	switch job.Status {
	case "completed":
		return s.settleSuccess(ctx, conv, job)
	case "failed":
		return s.settleFailure(ctx, conv, job.Error)
	default: // pending | in_progress
		if conv.Modal.SubmittedAt != nil && time.Since(*conv.Modal.SubmittedAt) > processingTTL {
			return s.settleFailure(ctx, conv, fmt.Sprintf("processing exceeded %s (job still %s)", processingTTL, job.Status))
		}
		updated, err := s.Store.Transition(ctx, conv.ID, []string{store.StateProcessing}, func(c *store.Conversion) error {
			c.Modal.Progress = job.Progress
			c.Modal.Stage = job.Stage
			c.Modal.ETASeconds = job.ProgressDetail.ETASeconds
			c.Modal.LastPolledAt = &now
			return nil
		})
		if errors.Is(err, store.ErrStateConflict) {
			return s.Store.GetConversion(ctx, conv.ID)
		}
		return updated, err
	}
}

// settleSuccess: claim processing→succeeded (with outputs) FIRST, then
// capture. A concurrent user cancel can no longer race the capture — once
// succeeded is committed, cancel conflicts and returns the terminal state.
func (s *Service) settleSuccess(ctx context.Context, conv *store.Conversion, job *modalapi.Job) (*store.Conversion, error) {
	outputs := s.collectOutputs(ctx, conv.ID, job)
	now := time.Now().UTC()
	updated, err := s.Store.Transition(ctx, conv.ID, []string{store.StateProcessing}, func(c *store.Conversion) error {
		c.State = store.StateSucceeded
		c.Outputs = outputs
		c.Modal.Progress = 1
		c.Modal.Stage = ""
		c.Modal.CostUSD = job.CostSummary.TotalUSD
		c.Modal.LastPolledAt = &now
		c.Stripe.PIStatus = store.PICapturePending
		return nil
	})
	if errors.Is(err, store.ErrStateConflict) {
		return s.Store.GetConversion(ctx, conv.ID)
	}
	if err != nil {
		return nil, err
	}
	slog.InfoContext(ctx, "conversion succeeded",
		"conversion_id", conv.ID, "uid", conv.UID, "modal_cost_usd", job.CostSummary.TotalUSD)
	if updated.ProjectID != "" && updated.Kind == "video" {
		s.foldSceneProfile(ctx, updated, job)
	}
	return s.captureHold(ctx, updated)
}

// foldSceneProfile persists the adaptive profiler's per-shot depth script
// (job metadata depth_script) onto the project, so the web Stereo page can
// seed per-scene displacement / shot-type editors from what the pipeline
// actually measured. Latest succeeded run wins. Best-effort: a fold failure
// never blocks money settlement.
func (s *Service) foldSceneProfile(ctx context.Context, conv *store.Conversion, job *modalapi.Job) {
	shots := profileShots(job.Metadata)
	if len(shots) == 0 {
		return
	}
	now := time.Now().UTC()
	if _, err := s.Store.UpdateProject(ctx, conv.ProjectID, func(p *store.Project) error {
		p.SceneProfile = &store.SceneProfile{
			ConversionID:  conv.ID,
			ScenesVersion: conv.ScenesVer,
			Shots:         shots,
			UpdatedAt:     now,
		}
		return nil
	}); err != nil {
		slog.WarnContext(ctx, "scene profile fold failed",
			"conversion_id", conv.ID, "project_id", conv.ProjectID, "err", err)
	} else {
		slog.InfoContext(ctx, "scene profile folded",
			"conversion_id", conv.ID, "project_id", conv.ProjectID, "shots", len(shots))
	}
}

// profileShots decodes metadata.depth_script defensively: entries carry extra
// research keys (keyframes etc — ignored), and entries missing first_src /
// last_src (older pipeline versions) are unusable in SOURCE-frame space and
// skipped. Any decode problem yields nil, never an error — the profile is a
// UX seed, not a settlement input.
func profileShots(meta json.RawMessage) []store.ProfileShot {
	if len(meta) == 0 {
		return nil
	}
	var m struct {
		DepthScript []struct {
			FirstSrc     *int      `json:"first_src"`
			LastSrc      *int      `json:"last_src"`
			ShotType     string    `json:"shot_type"`
			Displacement float64   `json:"displacement"`
			Placement    []float64 `json:"placement"`
		} `json:"depth_script"`
	}
	if err := json.Unmarshal(meta, &m); err != nil {
		return nil
	}
	shots := make([]store.ProfileShot, 0, len(m.DepthScript))
	for _, e := range m.DepthScript {
		if e.FirstSrc == nil || e.LastSrc == nil {
			continue
		}
		shots = append(shots, store.ProfileShot{
			FirstSrc:     *e.FirstSrc,
			LastSrc:      *e.LastSrc,
			ShotType:     e.ShotType,
			Displacement: e.Displacement,
			Placement:    e.Placement,
		})
	}
	return shots
}

func (s *Service) settleFailure(ctx context.Context, conv *store.Conversion, internalErr string) (*store.Conversion, error) {
	now := time.Now().UTC()
	updated, err := s.Store.Transition(ctx, conv.ID, []string{store.StateProcessing}, func(c *store.Conversion) error {
		c.State = store.StateFailed
		c.Modal.LastPolledAt = &now
		c.Stripe.PIStatus = store.PICancelPending
		c.Error = &store.Error{
			Code:            "pipeline_failed",
			UserMessage:     "The conversion failed and you were not charged. Quote this ID to support: " + c.ID,
			InternalMessage: internalErr,
		}
		return nil
	})
	if errors.Is(err, store.ErrStateConflict) {
		return s.Store.GetConversion(ctx, conv.ID)
	}
	if err != nil {
		return nil, err
	}
	s.Slack.ConversionFailed(ctx, conv.ID, conv.UID, conv.Modal.Stage, internalErr)
	return s.releaseHold(ctx, updated)
}

// captureHold settles the money for a conversion whose state is already
// succeeded with pi_status=capture_pending. Retried by the reconciler sweep
// until it lands (or the PI turns out to be uncapturable → capture_failed,
// flagged to Slack: result delivered, revenue needs manual follow-up).
func (s *Service) captureHold(ctx context.Context, conv *store.Conversion) (*store.Conversion, error) {
	if conv.Stripe.PIStatus != store.PICapturePending {
		return conv, nil
	}
	captured, capErr := s.Stripe.Capture(conv.Stripe.PaymentIntentID)
	now := time.Now().UTC()
	updated, err := s.Store.Transition(ctx, conv.ID, []string{store.StateSucceeded}, func(c *store.Conversion) error {
		if capErr == nil {
			c.Stripe.PIStatus = store.PISucceeded
			c.Stripe.CapturedCents = captured
			c.Stripe.CapturedAt = &now
			c.Stripe.SettleError = ""
			return nil
		}
		firstFailure := c.Stripe.SettleError == ""
		c.Stripe.SettleError = fmt.Sprintf("capture: %v", capErr)
		if s.Stripe.IsTerminallyUncapturable(conv.Stripe.PaymentIntentID) {
			c.Stripe.PIStatus = store.PICaptureFailed // stop retrying
		}
		if firstFailure || c.Stripe.PIStatus == store.PICaptureFailed {
			s.Slack.SettleFailed(ctx, c.ID, c.UID, "capture", capErr)
		}
		return nil
	})
	if capErr != nil {
		slog.ErrorContext(ctx, "stripe capture failed",
			"conversion_id", conv.ID, "payment_intent", conv.Stripe.PaymentIntentID, "err", capErr)
	}
	if errors.Is(err, store.ErrStateConflict) {
		return s.Store.GetConversion(ctx, conv.ID)
	}
	return updated, err
}

// releaseHold cancels the PaymentIntent for a conversion already committed to
// a terminal state with pi_status=cancel_pending. Retried by the reconciler
// sweep. If the PI was already captured (should be impossible under the state
// machine, but money code assumes nothing), it flags Slack for a manual
// refund instead of retrying forever.
func (s *Service) releaseHold(ctx context.Context, conv *store.Conversion) (*store.Conversion, error) {
	if conv.Stripe.PIStatus != store.PICancelPending {
		return conv, nil
	}
	cancelErr := s.Stripe.CancelHold(conv.Stripe.PaymentIntentID)
	now := time.Now().UTC()
	updated, err := s.Store.Transition(ctx, conv.ID, []string{conv.State}, func(c *store.Conversion) error {
		if cancelErr == nil {
			c.Stripe.PIStatus = store.PICanceled
			c.Stripe.CanceledAt = &now
			c.Stripe.SettleError = ""
			return nil
		}
		firstFailure := c.Stripe.SettleError == ""
		c.Stripe.SettleError = fmt.Sprintf("cancel: %v", cancelErr)
		if s.Stripe.IsCaptured(conv.Stripe.PaymentIntentID) {
			c.Stripe.PIStatus = store.PICancelFailed // needs manual refund
		}
		if firstFailure || c.Stripe.PIStatus == store.PICancelFailed {
			s.Slack.SettleFailed(ctx, c.ID, c.UID, "cancel", cancelErr)
		}
		return nil
	})
	if cancelErr != nil {
		slog.ErrorContext(ctx, "stripe cancel failed",
			"conversion_id", conv.ID, "payment_intent", conv.Stripe.PaymentIntentID, "err", cancelErr)
	}
	// A conversion ending without a capture gives the project's analyze
	// credit back (idempotent: guarded by credit_consumed_by == this id).
	s.restoreCredit(ctx, conv)
	if errors.Is(err, store.ErrStateConflict) {
		return s.Store.GetConversion(ctx, conv.ID)
	}
	return updated, err
}

func (s *Service) restoreCredit(ctx context.Context, conv *store.Conversion) {
	if conv.ProjectID == "" {
		return
	}
	if err := s.Store.RestoreAnalyzeCredit(ctx, conv.ProjectID, conv.ID); err != nil {
		slog.WarnContext(ctx, "analyze credit restore failed",
			"conversion_id", conv.ID, "project_id", conv.ProjectID, "err", err)
	}
}

// ------------------------------------------------------------ analyze jobs

// refreshAnalyze polls the free analyze job behind a project and folds the
// result (probe, scenes, thumbnails, crop) into the project doc. Shared by
// GET read-through and the reconciler sweep.
func (s *Service) refreshAnalyze(ctx context.Context, p *store.Project) (*store.Project, error) {
	if p.Analyze.State != store.AnalyzeRunning || p.Analyze.JobID == "" {
		return p, nil
	}
	job, err := s.Modal.GetJob(ctx, p.Analyze.JobID)
	if err != nil {
		var upstream *modalapi.UpstreamError
		if errors.As(err, &upstream) && upstream.StatusCode == 404 {
			return s.failAnalyze(ctx, p, "job record lost upstream (404)")
		}
		slog.WarnContext(ctx, "analyze poll failed", "project_id", p.ID, "err", err)
		return p, nil
	}
	switch job.Status {
	case "completed":
		meta, derr := job.DecodeAnalyzeMetadata()
		if derr != nil {
			return s.failAnalyze(ctx, p, "undecodable analyze metadata: "+derr.Error())
		}
		credit := s.Pricing.Rates(ctx).AnalyzeCreditCents
		now := time.Now().UTC()
		updated, uerr := s.Store.UpdateProject(ctx, p.ID, func(pp *store.Project) error {
			if pp.Analyze.State != store.AnalyzeRunning {
				return nil // lost a race; the winner already folded results
			}
			pp.Analyze.State = store.AnalyzeSucceeded
			pp.Analyze.CostUSD = job.CostSummary.TotalUSD
			pp.Analyze.CreditCents = credit
			pp.Probe = &store.Probe{
				Width: meta.Probe.Width, Height: meta.Probe.Height,
				FPS: meta.Probe.FPS, FPSRational: meta.Probe.FPSRational,
				DurationS: meta.Probe.Duration, NumFrames: meta.Probe.NumFrames,
			}
			pp.Crop = meta.Crop
			pp.PreviewURL = meta.Preview.URL
			pp.Scenes = &store.Scenes{Version: 1, Cuts: meta.SceneCuts, UpdatedAt: now}
			pp.StripThumbs = make([]store.Thumb, 0, len(meta.Thumbnails.Strip))
			for _, t := range meta.Thumbnails.Strip {
				pp.StripThumbs = append(pp.StripThumbs, store.Thumb{Frame: t.Frame, URL: t.URL})
			}
			pp.SceneThumbs = make([]store.Thumb, 0, len(meta.Thumbnails.Scenes))
			for _, t := range meta.Thumbnails.Scenes {
				pp.SceneThumbs = append(pp.SceneThumbs, store.Thumb{Frame: t.Frame, URL: t.URL})
			}
			return nil
		})
		if uerr != nil {
			return nil, uerr
		}
		slog.InfoContext(ctx, "analyze succeeded",
			"project_id", p.ID, "scenes", len(meta.SceneCuts)+1, "cost_usd", job.CostSummary.TotalUSD)
		return updated, nil
	case "failed":
		return s.failAnalyze(ctx, p, job.Error)
	default:
		// Still running — surface live progress to the caller (transient;
		// see store.Analyze).
		pp := *p
		pp.Analyze.Progress = job.Progress
		pp.Analyze.Stage = job.Stage
		pp.Analyze.ETASeconds = job.ProgressDetail.ETASeconds
		return &pp, nil
	}
}

// refreshProfile polls the standalone shot-profiling job and folds its
// depth script into project.scene_profile on completion. GET read-through
// only (the Stereo page polls while the job runs).
func (s *Service) refreshProfile(ctx context.Context, p *store.Project) (*store.Project, error) {
	if p.Profile == nil || p.Profile.State != "running" || p.Profile.JobID == "" {
		return p, nil
	}
	job, err := s.Modal.GetJob(ctx, p.Profile.JobID)
	if err != nil {
		var upstream *modalapi.UpstreamError
		if errors.As(err, &upstream) && upstream.StatusCode == 404 {
			return s.failProfile(ctx, p, "job record lost upstream (404)")
		}
		slog.WarnContext(ctx, "profile poll failed", "project_id", p.ID, "err", err)
		return p, nil
	}
	switch job.Status {
	case "completed":
		shots := profileShots(job.Metadata)
		if len(shots) == 0 {
			return s.failProfile(ctx, p, "profile job returned no usable shots")
		}
		now := time.Now().UTC()
		updated, uerr := s.Store.UpdateProject(ctx, p.ID, func(pp *store.Project) error {
			if pp.Profile == nil || pp.Profile.State != "running" {
				return nil // lost a race; the winner already folded
			}
			pp.Profile.State = "succeeded"
			pp.Profile.UpdatedAt = now
			pp.SceneProfile = &store.SceneProfile{
				ConversionID:  "profile:" + pp.Profile.JobID,
				ScenesVersion: pp.Profile.ScenesVersion,
				Shots:         shots,
				UpdatedAt:     now,
			}
			return nil
		})
		if uerr != nil {
			return nil, uerr
		}
		slog.InfoContext(ctx, "profile succeeded", "project_id", p.ID, "shots", len(shots))
		return updated, nil
	case "failed":
		return s.failProfile(ctx, p, job.Error)
	default:
		pp := *p
		prof := *pp.Profile
		prof.Progress = job.Progress
		prof.Stage = job.Stage
		pp.Profile = &prof
		return &pp, nil
	}
}

func (s *Service) failProfile(ctx context.Context, p *store.Project, internalErr string) (*store.Project, error) {
	slog.ErrorContext(ctx, "profile failed", "project_id", p.ID, "uid", p.UID, "err", internalErr)
	return s.Store.UpdateProject(ctx, p.ID, func(pp *store.Project) error {
		if pp.Profile == nil || pp.Profile.State != "running" {
			return nil
		}
		pp.Profile.State = "failed"
		pp.Profile.Error = "shot profiling failed — retry, or contact support with project ID " + p.ID
		pp.Profile.UpdatedAt = time.Now().UTC()
		return nil
	})
}

func (s *Service) failAnalyze(ctx context.Context, p *store.Project, internalErr string) (*store.Project, error) {
	slog.ErrorContext(ctx, "analyze failed", "project_id", p.ID, "uid", p.UID, "err", internalErr)
	s.Slack.ConversionFailed(ctx, "analyze:"+p.ID, p.UID, "analyze", internalErr)
	return s.Store.UpdateProject(ctx, p.ID, func(pp *store.Project) error {
		if pp.Analyze.State != store.AnalyzeRunning {
			return nil
		}
		pp.Analyze.State = store.AnalyzeFailed
		pp.Analyze.Error = "analysis failed — re-upload or contact support with project ID " + p.ID
		return nil
	})
}

// collectOutputs flattens Modal's outputs map to name → GCS key. Video jobs
// return {name: url}; image jobs return {item_id: {name: url}} — both are
// handled. Keys outside our env prefix are dropped (Modal is trusted, but
// signed URLs for foreign keys must never be issuable).
func (s *Service) collectOutputs(ctx context.Context, conversionID string, job *modalapi.Job) map[string]string {
	outputs := map[string]string{}
	add := func(name, publicURL string) {
		key, err := s.GCS.KeyFromPublicURL(publicURL)
		if err != nil || !s.GCS.InPrefix(key) {
			slog.ErrorContext(ctx, "dropping unexpected output URL",
				"conversion_id", conversionID, "name", name, "url", publicURL, "err", err)
			return
		}
		outputs[name] = key
	}
	for name, raw := range job.Outputs {
		var flat string
		if json.Unmarshal(raw, &flat) == nil {
			if flat != "" {
				add(name, flat)
			}
			continue
		}
		var nested map[string]string
		if json.Unmarshal(raw, &nested) == nil {
			for sub, u := range nested {
				if u != "" {
					add(name+"/"+sub, u)
				}
			}
		}
	}
	return outputs
}
