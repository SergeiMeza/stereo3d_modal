package api

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// POST /v1/projects/{id}/delete — "Delete project" (S3D-24). Soft delete:
// the project is flagged and disappears from the account at once (lists,
// GETs, its runs and downloads all answer 404); the record stays, and its
// stored files are purged deleted_project_purge_days (30) later (kept for
// disputes, not restorable by the customer; file_keeping.go).
// Refused while a run is active. DELETE /v1/projects/{id} stays archive.
// Money already owed is untouched: batched and failed charges stay on the
// account's balance and settle through /v1/billing as before.
func (s *Service) HandleDeleteProject(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	p, err := s.ownedProject(ctx, user, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if err := s.requireNoActiveConversions(ctx, id, "deleting the project"); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	now := time.Now().UTC()
	purgeAt := now.Add(s.rates(ctx).DeletedProjectPurge())
	if _, err := s.Store.UpdateProject(ctx, id, func(pp *store.Project) error {
		if !pp.Deleted {
			pp.Deleted = true
			pp.DeletedAt = &now
			// The files stay for disputes, then the file-keeping sweep
			// purges them (S3D-24); no notices for a deleted project.
			if pp.FilesDeletedAt == nil {
				pp.FilesDeleteAt = &purgeAt
				pp.FilesNoticeDays, pp.FilesNoticeAt = 0, nil
			}
		}
		// Stop the sweeps from polling (and Slack-alerting on) the free
		// jobs canceled below.
		if pp.Analyze.State == store.AnalyzeRunning {
			pp.Analyze.State = store.AnalyzeFailed
			pp.Analyze.Error = "project deleted"
		}
		if pp.Profile != nil && pp.Profile.State == "running" {
			pp.Profile.State = "failed"
		}
		return nil
	}); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	// A free analysis or profiling job still running has nobody to report
	// to now (best effort; both are free).
	ws, werr := s.projectWorkspace(p)
	for _, job := range []string{runningAnalyze(p), runningProfile(p)} {
		if job != "" && werr == nil {
			if cerr := ws.Modal.CancelJob(ctx, job); cerr != nil {
				slog.WarnContext(ctx, "deleted project: job cancel failed", "project_id", id, "job_id", job, "err", cerr)
			}
		}
	}
	httpx.Log(ctx).Info("project deleted", "project_id", id, "uid", user.UID)
	httpx.WriteOK(w, map[string]any{"project_id": id, "deleted": true})
}

func runningAnalyze(p *store.Project) string {
	if p.Analyze.State == store.AnalyzeRunning {
		return p.Analyze.JobID
	}
	return ""
}

func runningProfile(p *store.Project) string {
	if p.Profile != nil && p.Profile.State == "running" {
		return p.Profile.JobID
	}
	return ""
}

// projectSummary is a project card's outcome line (S3D-35): its newest
// run's state and step, and what the project has cost so far.
type projectSummary struct {
	LatestState string `json:"latest_state,omitempty"`
	LatestStep  string `json:"latest_step,omitempty"`
	SpentCents  int64  `json:"spent_cents"`
}

// summarize folds a project's runs (newest first). spent_cents counts the
// money taken or owed for delivered work — charged, pre-charged (while it
// stands), batched, or awaiting/failing its charge — and leaves out runs
// refunded, released, or never charged.
func summarize(convs []*store.Conversion) projectSummary {
	var sum projectSummary
	if len(convs) > 0 {
		sum.LatestState, sum.LatestStep = convs[0].State, convs[0].Step
	}
	for _, c := range convs {
		sum.SpentCents += spentCents(c)
	}
	return sum
}

func spentCents(c *store.Conversion) int64 {
	switch c.Stripe.PIStatus {
	case store.PISucceeded:
		if c.Stripe.CapturedCents > 0 {
			return c.Stripe.CapturedCents
		}
		return c.Quote.AmountCents
	case store.PIBatched, store.PIChargePending, store.PIChargeFailed, store.PICapturePending:
		return c.Quote.AmountCents
	}
	// "", cancel_pending (a refund or release on its way), canceled,
	// refunded, refund_failed (owed back), capture_failed (our loss).
	return 0
}

// projectSummaries reads each listed project's runs (bounded fan-out) for
// its summary. A failed read leaves that card without a latest state
// rather than failing the list.
func (s *Service) projectSummaries(ctx context.Context, projects []*store.Project) []projectSummary {
	out := make([]projectSummary, len(projects))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i, p := range projects {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			convs, err := s.Store.ListProjectConversions(ctx, id, 100)
			if err != nil {
				slog.WarnContext(ctx, "project summary read failed", "project_id", id, "err", err)
				return
			}
			out[i] = summarize(convs)
		}(i, p.ID)
	}
	wg.Wait()
	return out
}

// projectGone reports whether a conversion belongs to a deleted project
// (it then answers 404 like the project). Best effort: a failed project
// read keeps the conversion visible.
func (s *Service) projectGone(ctx context.Context, c *store.Conversion, cache map[string]bool) bool {
	if c.ProjectID == "" {
		return false
	}
	if gone, ok := cache[c.ProjectID]; ok {
		return gone
	}
	p, err := s.Store.GetProject(ctx, c.ProjectID)
	gone := err == nil && p.Deleted
	if cache != nil {
		cache[c.ProjectID] = gone
	}
	return gone
}
