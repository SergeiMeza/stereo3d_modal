package api

import (
	"context"
	"encoding/json"
	"errors"

	"log/slog"
	"net/http"
	"path"
	"slices"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// "Get another format" (ADR 0137): a finished Lifelike run's stored
// output is re-packed into a format the run doesn't have, by the Lifelike
// service (POST /repack with a signed GET of the source and a signed PUT
// for the new file beside it). Only while the files are stored; never
// from half side-by-side alone (no quality is invented); no full
// side-by-side at 6K/8K; one per format per run (a failed one can be
// retried); free for now (price_cents 0); starting one counts as use of
// the project. The new file joins the run's outputs and downloads like
// the others.

var repackFormats = []string{"mvhevc", "sbs", "half_sbs"}

// repackSources: per target, the outputs a repack may read, best first
// (3DS, 2026-11-04: half SBS from spatial, else full SBS, as full SBS
// files made before then carry a slight colour shift; spatial only from
// full SBS; full SBS only from spatial). Half SBS is never a source.
var repackSources = map[string][]string{
	"half_sbs": {"mvhevc", "sbs"},
	"mvhevc":   {"sbs"},
	"sbs":      {"mvhevc"},
}

const (
	repackPerHour   = 10
	repackTimeout   = 3 * time.Hour
	repackURLExpiry = 6 * time.Hour
	repackPrice     = 0 // ADR 0137 open question: free until the owner decides
)

func repackExt(format string) (ext, contentType string) {
	if format == "mvhevc" {
		return ".mov", "video/quicktime"
	}
	return ".mp4", "video/mp4"
}

// runFormats is what a run has, what it can get, and why not.
type runFormats struct {
	Have, Available, Pending []string
	Reason                   string // files_erased | half_only | run_failed | classic_retired | split_run
	Sources                  map[string]string // target → the output its repack reads
	Project                  *store.Project
}

func (s *Service) runFormatsOf(ctx context.Context, c *store.Conversion) runFormats {
	st := runFormats{Have: []string{}, Available: []string{}, Pending: []string{}, Sources: map[string]string{}}
	for _, f := range repackFormats {
		if c.Outputs[f] != "" {
			st.Have = append(st.Have, f)
		} else if r := c.Repacks[f]; r != nil && (r.Status == "pending" || r.Status == "processing") {
			st.Pending = append(st.Pending, f)
		}
	}
	switch {
	case c.State != store.StateSucceeded:
		st.Reason = "run_failed"
		return st
	case c.Method != store.MethodLifelike:
		st.Reason = "classic_retired"
		return st
	case len(c.Parts) > 0:
		st.Reason = "split_run"
		return st
	}
	if c.ProjectID != "" {
		if p, err := s.Store.GetProject(ctx, c.ProjectID); err == nil {
			st.Project = p
		}
	}
	if st.Project == nil || st.Project.Deleted || st.Project.FilesDeletedAt != nil || len(st.Have) == 0 {
		st.Reason = "files_erased"
		return st
	}
	if !slices.Contains(st.Have, "sbs") && !slices.Contains(st.Have, "mvhevc") {
		st.Reason = "half_only"
		return st
	}
	for _, f := range repackFormats {
		if slices.Contains(st.Have, f) || slices.Contains(st.Pending, f) || (f == "sbs" && sbsTooWide[c.Params.Preset]) {
			continue
		}
		for _, src := range repackSources[f] {
			if slices.Contains(st.Have, src) {
				st.Sources[f] = src
				break
			}
		}
		if st.Sources[f] != "" {
			st.Available = append(st.Available, f)
		}
	}
	return st
}

func repackJSON(r *store.Repack) map[string]any {
	out := map[string]any{"job_id": nilIfEmpty(r.RepackID), "status": r.Status, "source": r.Source, "price_cents": r.PriceCents,
		"requested_at": r.RequestedAt, "finished_at": r.FinishedAt}
	if r.Error != "" {
		out["error"] = r.Error
	}
	return out
}

func (st runFormats) json(c *store.Conversion) map[string]any {
	jobs := map[string]any{}
	for f, r := range c.Repacks {
		jobs[f] = repackJSON(r)
	}
	out := map[string]any{"available": st.Available, "have": st.Have, "pending": st.Pending, "price_cents": repackPrice, "jobs": jobs}
	if st.Reason != "" {
		out["unavailable_reason"] = st.Reason
	}
	return out
}

// GET /v1/runs/{id}/formats → {available, have, pending,
// unavailable_reason?, price_cents, jobs {format: {job_id, status, …}}}.
func (s *Service) HandleRunFormats(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	c, err := s.ownedConversion(ctx, user, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if c.RepackPending {
		if fresh := s.pollRepacks(ctx, c); fresh != nil {
			c = fresh
		}
	}
	httpx.WriteOK(w, s.runFormatsOf(ctx, c).json(c))
}

var errRepackTaken = errors.New("repack: format taken")

// POST /v1/runs/{id}/formats {format} → 202 {job_id, status, format,
// source, price_cents}.
func (s *Service) HandleRunFormatAdd(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	var req struct {
		Format string `json:"format"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&req); err != nil || !slices.Contains(repackFormats, req.Format) {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("format: mvhevc, sbs or half_sbs"))
		return
	}
	c, err := s.ownedConversion(ctx, user, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if c.Sample { // it has every format already (owner 2026-11-04)
		httpx.WriteErr(ctx, w, errSampleProject())
		return
	}
	st := s.runFormatsOf(ctx, c)
	unavailable := func(code, reason, msg string) {
		e := httpx.Err(http.StatusConflict, code, msg)
		e.Details = map[string]any{"reason": reason}
		httpx.WriteErr(ctx, w, e)
	}
	switch {
	case slices.Contains(st.Have, req.Format):
		unavailable("format_exists", "have", "This run already has that format.")
		return
	case slices.Contains(st.Pending, req.Format):
		unavailable("format_in_progress", "pending", "That format is being made.")
		return
	case st.Reason != "":
		unavailable("format_unavailable", st.Reason, formatUnavailableText(st.Reason))
		return
	case !slices.Contains(st.Available, req.Format):
		unavailable("format_unavailable", "too_wide", "Full side-by-side isn't available at this size.")
		return
	}
	if !eventAllowed("repack-uid:"+user.UID, repackPerHour, time.Now()) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusTooManyRequests, "rate_limited", "Too many format requests. Try again in a while."))
		return
	}
	cl := s.modalFor(c)
	if cl == nil || s.GCS == nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusServiceUnavailable, "repack_unavailable", "Getting another format isn't available right now."))
		return
	}
	srcKey := c.Outputs[st.Sources[req.Format]]
	ext, ctype := repackExt(req.Format)
	key := path.Dir(srcKey) + "/repack_" + req.Format + ext
	now := time.Now().UTC()
	if _, err := s.Store.Transition(ctx, c.ID, []string{store.StateSucceeded}, func(x *store.Conversion) error {
		if x.Outputs[req.Format] != "" {
			return errRepackTaken
		}
		prev := x.Repacks[req.Format]
		if prev != nil && prev.Status != "failed" {
			return errRepackTaken
		}
		attempts := 1
		if prev != nil {
			attempts = prev.Attempts + 1
		}
		if x.Repacks == nil {
			x.Repacks = map[string]*store.Repack{}
		}
		x.Repacks[req.Format] = &store.Repack{Format: req.Format, Source: st.Sources[req.Format], Status: "pending", Key: key, PriceCents: repackPrice,
			Attempts: attempts, RequestedAt: now}
		x.RepackPending = true
		return nil
	}); err != nil {
		if errors.Is(err, errRepackTaken) {
			unavailable("format_in_progress", "pending", "That format is being made.")
			return
		}
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	get, gerr := s.GCS.SignedGetURL(srcKey, repackURLExpiry)
	put, perr := s.GCS.SignedPutURL(key, ctype, repackURLExpiry)
	var repackID string
	err = errors.Join(gerr, perr)
	if err == nil {
		fps := c.Params.TargetFPS
		if fps <= 0 {
			fps = c.Source.FPS
		}
		repackID, err = cl.SubmitRepack(ctx, modalapi.RepackRequest{JobID: c.Modal.JobID, Source: modalapi.RepackSource{URL: get, Format: st.Sources[req.Format]},
			TargetFormat: req.Format, OutputUploadURL: put, Preset: c.Params.Preset, FPS: fps})
	}
	if err != nil {
		slog.WarnContext(ctx, "repack not started", "conversion_id", c.ID, "format", req.Format, "err", err)
		s.finishRepack(ctx, c.ID, req.Format, nil, "could not start: "+err.Error())
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "repack_unavailable", "Getting another format didn't start. Try again in a while."))
		return
	}
	updated, _ := s.Store.Transition(ctx, c.ID, []string{store.StateSucceeded}, func(x *store.Conversion) error {
		if r := x.Repacks[req.Format]; r != nil && r.Status == "pending" {
			r.RepackID, r.Status = repackID, "processing"
		}
		return nil
	})
	s.noteProjectUse(ctx, st.Project, true) // ADR 0137: counts as use
	s.passkeyEvent(ctx, user.UID, "run_format_requested", map[string]any{"run_id": c.ID, "format": req.Format, "source": st.Sources[req.Format]})
	out := map[string]any{"job_id": repackID, "status": "processing", "format": req.Format, "source": st.Sources[req.Format], "price_cents": repackPrice}
	if updated != nil && updated.Repacks[req.Format] != nil {
		out["status"] = updated.Repacks[req.Format].Status
	}
	writeJSON(w, http.StatusAccepted, out)
}

func formatUnavailableText(reason string) string {
	switch reason {
	case "files_erased":
		return "This run's files are no longer stored. Make a new run for another format."
	case "half_only":
		return "This run only has half side-by-side, which can't become a fuller format. Make a new run instead."
	case "run_failed":
		return "Only a finished run can get another format."
	case "split_run":
		return "A run made in parts can't get another format yet."
	}
	return "This run can't get another format."
}

// finishRepack records a repack's end: out non-nil = done (the file joins
// the outputs), else failed with why.
func (s *Service) finishRepack(ctx context.Context, convID, format string, out *modalapi.RepackOutput, why string) *store.Conversion {
	now := time.Now().UTC()
	var uid, event string
	updated, err := s.Store.Transition(ctx, convID, []string{store.StateSucceeded}, func(x *store.Conversion) error {
		r := x.Repacks[format]
		if r == nil || (r.Status != "pending" && r.Status != "processing") {
			return errNoChange
		}
		r.FinishedAt = &now
		if out != nil {
			r.Status, r.Error = "succeeded", ""
			r.Bytes, r.Width, r.Height, r.Frames, r.Level = out.Bytes, out.Width, out.Height, out.Frames, out.Level
			if x.Outputs == nil {
				x.Outputs = map[string]string{}
			}
			x.Outputs[format] = r.Key
			event = "run_format_added"
		} else {
			r.Status, r.Error = "failed", why
			event = "run_format_failed"
		}
		x.RepackPending = false
		for _, o := range x.Repacks {
			if o.Status == "pending" || o.Status == "processing" {
				x.RepackPending = true
			}
		}
		uid = x.UID
		return nil
	})
	if err != nil {
		return nil
	}
	s.passkeyEvent(ctx, uid, event, map[string]any{"run_id": convID, "format": format, "error": nilIfEmpty(why)})
	slog.InfoContext(ctx, "repack finished", "conversion_id", convID, "format", format, "event", event)
	return updated
}

// pollRepacks asks the Lifelike service about c's running repacks;
// the run as stored after (nil when nothing changed).
func (s *Service) pollRepacks(ctx context.Context, c *store.Conversion) *store.Conversion {
	cl := s.modalFor(c)
	var last *store.Conversion
	for f, r := range c.Repacks {
		if r.Status != "pending" && r.Status != "processing" {
			continue
		}
		if r.RepackID == "" || cl == nil {
			if time.Since(r.RequestedAt) > 10*time.Minute {
				last = firstConv(s.finishRepack(ctx, c.ID, f, nil, "never started"), last)
			}
			continue
		}
		st, err := cl.GetRepack(ctx, r.RepackID)
		switch {
		case err != nil:
			if time.Since(r.RequestedAt) > repackTimeout {
				last = firstConv(s.finishRepack(ctx, c.ID, f, nil, "timed out"), last)
			}
		case st.Done() && st.Output != nil:
			last = firstConv(s.finishRepack(ctx, c.ID, f, st.Output, ""), last)
		case st.Done():
			last = firstConv(s.finishRepack(ctx, c.ID, f, nil, "finished without a file"), last)
		case st.Failed():
			last = firstConv(s.finishRepack(ctx, c.ID, f, nil, firstNonEmpty(st.Error, st.Status)), last)
		case time.Since(r.RequestedAt) > repackTimeout:
			last = firstConv(s.finishRepack(ctx, c.ID, f, nil, "timed out"), last)
		}
	}
	return last
}

func firstConv(a, b *store.Conversion) *store.Conversion {
	if a != nil {
		return a
	}
	return b
}

// pollAllRepacks is the reconciler's pass over runs with a repack going.
func (s *Service) pollAllRepacks(ctx context.Context) int {
	convs, err := s.Store.ListRepackPending(ctx, 100)
	if err != nil {
		slog.WarnContext(ctx, "repack sweep", "err", err)
		return 0
	}
	for _, c := range convs {
		pctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		s.pollRepacks(pctx, c)
		cancel()
	}
	return len(convs)
}

// repacksHistory: a run's added formats for the admin views.
func repacksHistory(c *store.Conversion) []map[string]any {
	out := []map[string]any{}
	for _, f := range repackFormats {
		if r := c.Repacks[f]; r != nil {
			row := repackJSON(r)
			row["format"] = f
			out = append(out, row)
		}
	}
	return out
}
