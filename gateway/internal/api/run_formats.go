package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"path"
	"slices"
	"sort"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// "Get another format" (ADR 0137): a finished Lifelike run's stored
// output is re-packed into a format the run doesn't have, by the Lifelike
// service (POST /repack with a signed GET of the source and a signed PUT
// for the new file beside it), once per output file: a split run's parts
// each get their own repack, and the format is done when every part is.
// Only while the files are stored; never from half side-by-side alone
// (no quality is invented); no full side-by-side at 6K/8K; one per format
// per run (failed parts can be retried); free for now (price_cents 0);
// starting one counts as use of the project. The new files join the run's
// outputs and download like the others.

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
	repackOverhead  = 30 // seconds a repack takes to start, measured on test 2026-11-04
	repackPrice     = 0  // ADR 0137 open question: free until the owner decides
)

// repackEstimate: about how long making format takes, from measured
// repacks, plus repackOverhead per file (a split run's parts each start
// their own container):
//   - side-by-side ≈ 1.6× the run's length at 1080p (rp7a500d6f0fa242: a
//     3:50 1080p run in ~6.3 min, 2026-11-05), growing slowly with the
//     picture (its sixth root: ≈ 2× at 4K, as 3DS measured on a 24 s 4K
//     run and our 15 s 4K test took);
//   - spatial ≈ 10× at 4K, scaled by the pixels (x265 multiview; the 15 s
//     4K test took 175-182 s).
//
// The whole run's length, so a split run's parts (which run side by
// side) usually finish sooner.
func repackEstimate(c *store.Conversion, format string) int {
	secs := outputSecondsOf(c)
	if secs <= 0 {
		return 0
	}
	overhead := repackOverhead * len(runPartNumbers(c))
	px := repackEyePixels(c)
	var perSecond float64
	if format == "mvhevc" {
		perSecond = 10 * px / (3840 * 2160)
	} else {
		perSecond = 1.6 * math.Pow(px/(1920*1080), 1.0/6)
	}
	return int(math.Ceil(secs*perSecond)) + overhead
}

// repackEyePixels: the run's output picture per eye (its recorded size,
// else its preset's 16:9 frame; 4K when unknown).
func repackEyePixels(c *store.Conversion) float64 {
	if c.Params.OutputWidth > 0 && c.Params.OutputHeight > 0 {
		return float64(c.Params.OutputWidth) * float64(c.Params.OutputHeight)
	}
	if h := presetOutputHeight[c.Params.Preset]; h > 0 {
		return float64(presetLongEdge(h)) * float64(h)
	}
	return 3840 * 2160
}

// repackTimeoutOf: 3 h without an end fails a repack; spatial gets
// twice its estimate when that's longer.
func repackTimeoutOf(c *store.Conversion, format string) time.Duration {
	if format == "mvhevc" {
		return max(repackTimeout, 2*time.Duration(repackEstimate(c, format))*time.Second)
	}
	return repackTimeout
}

func repackExt(format string) (ext, contentType string) {
	if format == "mvhevc" {
		return ".mov", "video/quicktime"
	}
	return ".mp4", "video/mp4"
}

// outputPartName: format for the run's single file (part 0), else
// format_partN, the way split runs name their outputs.
func outputPartName(format string, part int) string {
	if part == 0 {
		return format
	}
	return fmt.Sprintf("%s_part%d", format, part)
}

// runPartNumbers: the part numbers a split run's outputs carry (sorted),
// or [0] for a run with single files.
func runPartNumbers(c *store.Conversion) []int {
	seen := map[int]bool{}
	for name := range c.Outputs {
		if _, n := splitOutputName(name); n > 0 {
			seen[n] = true
		}
	}
	if len(seen) == 0 {
		return []int{0}
	}
	out := make([]int, 0, len(seen))
	for n := range seen {
		out = append(out, n)
	}
	sort.Ints(out)
	return out
}

// hasFormat: every part of the run has format.
func hasFormat(c *store.Conversion, format string, parts []int) bool {
	for _, n := range parts {
		if c.Outputs[outputPartName(format, n)] == "" {
			return false
		}
	}
	return true
}

// runFormats is what a run has, what it can get, and why not.
type runFormats struct {
	Have, Available, Pending []string
	Reason                   string            // files_erased | half_only | run_failed | classic_retired
	Sources                  map[string]string // target → the output its repack reads
	Parts                    []int
	Project                  *store.Project
}

func repackRunning(r *store.Repack) bool {
	return r != nil && (r.Status == "pending" || r.Status == "processing")
}

func (s *Service) runFormatsOf(ctx context.Context, c *store.Conversion) runFormats {
	st := runFormats{Have: []string{}, Available: []string{}, Pending: []string{}, Sources: map[string]string{}, Parts: runPartNumbers(c)}
	for _, f := range repackFormats {
		if hasFormat(c, f, st.Parts) {
			st.Have = append(st.Have, f)
		} else if r := c.Repacks[f]; repackRunning(r) || (r != nil && r.Status == "succeeded") {
			// a job counts as made only once its files are listed: never
			// gone from pending before it's in have
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
		if slices.Contains(st.Have, f) || slices.Contains(st.Pending, f) || (f == "sbs" && fullSBSRefused(c.Params)) {
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

// repackParts: a record's parts (a record from before parts is one).
func repackParts(r *store.Repack) []store.RepackPart {
	if len(r.Parts) > 0 || r.Key == "" {
		return r.Parts
	}
	return []store.RepackPart{{Index: 0, Name: r.Format, Source: r.Source, RepackID: r.RepackID, Status: r.Status, Key: r.Key,
		Error: r.Error, Bytes: r.Bytes, Width: r.Width, Height: r.Height, Frames: r.Frames, Level: r.Level, FinishedAt: r.FinishedAt}}
}

func repackJSON(r *store.Repack) map[string]any {
	parts := repackParts(r)
	ids := []string{}
	pj := make([]map[string]any, 0, len(parts))
	for _, p := range parts {
		if p.RepackID != "" {
			ids = append(ids, p.RepackID)
		}
		row := map[string]any{"index": p.Index, "name": p.Name, "job_id": nilIfEmpty(p.RepackID), "status": p.Status, "progress": nil}
		if p.Progress != nil {
			row["progress"] = math.Round(*p.Progress*100) / 100
		}
		if p.Error != "" {
			row["error"] = p.Error
		}
		pj = append(pj, row)
	}
	var first any
	if len(ids) > 0 {
		first = ids[0]
	}
	progress, remaining := repackProgress(r, parts, time.Now())
	out := map[string]any{"job_id": first, "job_ids": ids, "status": r.Status, "source": r.Source, "price_cents": r.PriceCents,
		"requested_at": r.RequestedAt, "finished_at": r.FinishedAt, "parts": pj,
		"progress": progress, "remaining_seconds": remaining}
	if r.Error != "" {
		out["error"] = r.Error
	}
	return out
}

// repackProgress is a format's progress (0-1, the parts' mean; nil when
// no part has reported one) and, while it runs, the seconds left from
// it: each running part's time so far × (1 − p) / p, the longest; nil
// until every running part has reported progress above 0.
func repackProgress(r *store.Repack, parts []store.RepackPart, now time.Time) (progress, remaining any) {
	if len(parts) == 0 {
		return nil, nil
	}
	sum, known, longest, allKnown := 0.0, false, 0.0, true
	for _, p := range parts {
		switch {
		case p.Status == "succeeded":
			sum, known = sum+1, true
		case p.Progress != nil:
			sum, known = sum+*p.Progress, true
			if repackRunning(&store.Repack{Status: p.Status}) {
				if *p.Progress <= 0 {
					allKnown = false
					continue
				}
				ran := now.Sub(r.RequestedAt).Seconds()
				longest = max(longest, ran*(1-*p.Progress) / *p.Progress)
			}
		case repackRunning(&store.Repack{Status: p.Status}):
			allKnown = false
		}
	}
	if !known {
		return nil, nil
	}
	progress = math.Round(sum/float64(len(parts))*100) / 100
	if !repackRunning(r) || !allKnown || longest <= 0 {
		return progress, nil
	}
	return progress, int64(math.Ceil(longest))
}

func (st runFormats) json(c *store.Conversion) map[string]any {
	jobs := map[string]any{}
	for f, r := range c.Repacks {
		j := repackJSON(r)
		if r.Status == "succeeded" && !slices.Contains(st.Have, f) {
			j["status"] = "processing" // done only once the files are listed
		}
		j["estimated_seconds"] = repackEstimate(c, f)
		jobs[f] = j
	}
	out := map[string]any{"available": st.Available, "have": st.Have, "pending": st.Pending, "price_cents": repackPrice, "jobs": jobs}
	if st.Reason != "" {
		out["unavailable_reason"] = st.Reason
	}
	return out
}

// GET /v1/runs/{id}/formats → {available, have, pending,
// unavailable_reason?, price_cents, jobs {format: {job_id, job_ids,
// status, parts, …}}}.
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

// POST /v1/runs/{id}/formats {format} → 202 {job_id, job_ids, status,
// format, source, price_cents}.
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
	src := st.Sources[req.Format]
	ext, ctype := repackExt(req.Format)
	now := time.Now().UTC()
	var todo []store.RepackPart
	if _, err := s.Store.Transition(ctx, c.ID, []string{store.StateSucceeded}, func(x *store.Conversion) error {
		if hasFormat(x, req.Format, st.Parts) {
			return errRepackTaken
		}
		prev := x.Repacks[req.Format]
		if prev != nil && prev.Status != "failed" {
			return errRepackTaken
		}
		rec := &store.Repack{Format: req.Format, Source: src, Status: "pending", PriceCents: repackPrice, Attempts: 1, RequestedAt: now}
		done := map[int]store.RepackPart{}
		if prev != nil { // a retry: the parts already made stay
			rec.Attempts = prev.Attempts + 1
			for _, p := range repackParts(prev) {
				if p.Status == "succeeded" {
					done[p.Index] = p
				}
			}
		}
		todo = nil
		for _, n := range st.Parts {
			if p, ok := done[n]; ok {
				rec.Parts = append(rec.Parts, p)
				continue
			}
			name, srcName := outputPartName(req.Format, n), outputPartName(src, n)
			p := store.RepackPart{Index: n, Name: name, Source: srcName, Status: "pending",
				Key: path.Dir(x.Outputs[srcName]) + "/repack_" + name + ext}
			rec.Parts = append(rec.Parts, p)
			todo = append(todo, p)
		}
		if x.Repacks == nil {
			x.Repacks = map[string]*store.Repack{}
		}
		x.Repacks[req.Format] = rec
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
	fps := c.Params.TargetFPS
	if fps <= 0 {
		fps = c.Source.FPS
	}
	results := map[int]partResult{}
	started := 0
	for _, p := range todo {
		get, gerr := s.GCS.SignedGetURL(c.Outputs[p.Source], repackURLExpiry)
		put, perr := s.GCS.SignedPutURL(p.Key, ctype, repackURLExpiry)
		err := errors.Join(gerr, perr)
		var id string
		if err == nil {
			id, err = cl.SubmitRepack(ctx, modalapi.RepackRequest{JobID: c.Modal.JobID, Source: modalapi.RepackSource{URL: get, Format: src},
				TargetFormat: req.Format, OutputUploadURL: put, Preset: c.Params.Preset, FPS: fps,
				OutputBitrateBps: c.Params.OutputBitrateBps}) // the run's own bitrate when it chose one
		}
		if err != nil {
			slog.WarnContext(ctx, "repack not started", "conversion_id", c.ID, "format", req.Format, "part", p.Index, "err", err)
			results[p.Index] = partResult{failed: "could not start: " + err.Error()}
			continue
		}
		results[p.Index] = partResult{started: id}
		started++
	}
	updated := s.applyRepackResults(ctx, c.ID, req.Format, results)
	if started == 0 {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "repack_unavailable", "Getting another format didn't start. Try again in a while."))
		return
	}
	s.noteProjectUse(ctx, st.Project, true) // ADR 0137: counts as use
	s.passkeyEvent(ctx, user.UID, "run_format_requested", map[string]any{"run_id": c.ID, "format": req.Format, "source": src, "parts": len(todo)})
	out := map[string]any{"status": "processing", "format": req.Format, "source": src, "price_cents": repackPrice,
		"estimated_seconds": repackEstimate(c, req.Format)}
	if updated != nil && updated.Repacks[req.Format] != nil {
		j := repackJSON(updated.Repacks[req.Format])
		out["status"], out["job_id"], out["job_ids"] = j["status"], j["job_id"], j["job_ids"]
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
	}
	return "This run can't get another format."
}

// partResult is what happened to one part: started (a repack id), done
// (the new file), progress (still running) or failed (why).
type partResult struct {
	started  string
	done     *modalapi.RepackOutput
	progress *float64 // still running: its new progress
	failed   string
}

// applyRepackResults writes the parts' news and the format's state: done
// when every part is (the files join the outputs), failed when none is
// still running and one failed (those parts can be retried).
func (s *Service) applyRepackResults(ctx context.Context, convID, format string, results map[int]partResult) *store.Conversion {
	if len(results) == 0 {
		return nil
	}
	now := time.Now().UTC()
	var uid, event, why string
	updated, err := s.Store.Transition(ctx, convID, []string{store.StateSucceeded}, func(x *store.Conversion) error {
		r := x.Repacks[format]
		if !repackRunning(r) {
			return errNoChange
		}
		parts := repackParts(r)
		changed := false
		for i := range parts {
			p := &parts[i]
			res, ok := results[p.Index]
			if !ok || (p.Status != "pending" && p.Status != "processing") {
				continue
			}
			changed = true
			switch {
			case res.started != "":
				p.RepackID, p.Status = res.started, "processing"
			case res.done != nil:
				one := 1.0
				p.Status, p.Error, p.FinishedAt, p.Progress = "succeeded", "", &now, &one
				p.Bytes, p.Width, p.Height, p.Frames, p.Level = res.done.Bytes, res.done.Width, res.done.Height, res.done.Frames, res.done.Level
			case res.progress != nil:
				p.Status, p.Progress = "processing", res.progress
			default:
				p.Status, p.Error, p.FinishedAt = "failed", res.failed, &now
			}
		}
		if !changed {
			return errNoChange
		}
		r.Parts, r.RepackID, r.Key = parts, "", ""
		running, failed := 0, 0
		for _, p := range parts {
			switch p.Status {
			case "pending", "processing":
				running++
			case "failed":
				failed++
				why = p.Error
			}
		}
		switch {
		case running > 0:
			r.Status = "processing"
		case failed > 0:
			r.Status, r.Error, r.FinishedAt = "failed", why, &now
			event = "run_format_failed"
		default:
			r.Status, r.Error, r.FinishedAt = "succeeded", "", &now
			if x.Outputs == nil {
				x.Outputs = map[string]string{}
			}
			for _, p := range parts {
				x.Outputs[p.Name] = p.Key
				r.Bytes += p.Bytes
			}
			r.Width, r.Height, r.Level = parts[0].Width, parts[0].Height, parts[0].Level
			event = "run_format_added"
		}
		x.RepackPending = false
		for _, o := range x.Repacks {
			if repackRunning(o) {
				x.RepackPending = true
			}
		}
		uid = x.UID
		return nil
	})
	if err != nil {
		return nil
	}
	if event != "" {
		s.passkeyEvent(ctx, uid, event, map[string]any{"run_id": convID, "format": format, "error": nilIfEmpty(why)})
		slog.InfoContext(ctx, "repack finished", "conversion_id", convID, "format", format, "event", event)
	}
	return updated
}

// pollRepacks asks the Lifelike service about c's running repacks; the
// run as stored after (nil when nothing changed).
func (s *Service) pollRepacks(ctx context.Context, c *store.Conversion) *store.Conversion {
	cl := s.modalFor(c)
	var last *store.Conversion
	for f, r := range c.Repacks {
		if !repackRunning(r) {
			continue
		}
		timeout := repackTimeoutOf(c, f)
		results := map[int]partResult{}
		for _, p := range repackParts(r) {
			if p.Status != "pending" && p.Status != "processing" {
				continue
			}
			if p.RepackID == "" || cl == nil {
				if time.Since(r.RequestedAt) > 10*time.Minute {
					results[p.Index] = partResult{failed: "never started"}
				}
				continue
			}
			st, err := cl.GetRepack(ctx, p.RepackID)
			switch {
			case err != nil:
				if time.Since(r.RequestedAt) > timeout {
					results[p.Index] = partResult{failed: "timed out"}
				}
			case st.Done() && st.Output != nil:
				results[p.Index] = partResult{done: st.Output}
			case st.Done():
				results[p.Index] = partResult{failed: "finished without a file"}
			case st.Failed():
				results[p.Index] = partResult{failed: firstNonEmpty(st.Error, st.Status)}
			case time.Since(r.RequestedAt) > timeout:
				results[p.Index] = partResult{failed: "timed out"}
			case st.Progress != nil && (p.Progress == nil || *st.Progress-*p.Progress >= 0.01):
				v := min(max(*st.Progress, 0), 1)
				results[p.Index] = partResult{progress: &v} // written in steps of 1%
			}
		}
		if u := s.applyRepackResults(ctx, c.ID, f, results); u != nil {
			last = u
		}
	}
	return last
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
