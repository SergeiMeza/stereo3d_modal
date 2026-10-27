package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Overdue runs. On 2026-10-27 runs sat at "Profiling scenes" for hours: the
// web app showed a progress bar that never moved, and we heard about it
// from one customer's email. A run well past its estimate now raises a
// Slack alert from the status poll, and the web app offers "Report it",
// which lands in Slack with the user's note and email.

const (
	overdueSlackMin   = 15 * time.Minute
	overdueSlackMax   = time.Hour
	overdueNoEstimate = 45 * time.Minute
	maxReportsPerRun  = 5
	maxReportNote     = 2000
)

// overdueAfter is how long a run may go before it counts as overdue: its
// estimate plus the estimate again as slack, the slack kept between 15
// minutes and an hour. Without an estimate, 45 minutes.
func overdueAfter(expectedSeconds int64) time.Duration {
	if expectedSeconds <= 0 {
		return overdueNoEstimate
	}
	expected := time.Duration(expectedSeconds) * time.Second
	return expected + min(max(expected, overdueSlackMin), overdueSlackMax)
}

// runStart is when the run started from the user's point of view: GPU
// submission, or creation while it still waits for submission.
func runStart(c *store.Conversion) time.Time {
	if c.Modal.SubmittedAt != nil {
		return *c.Modal.SubmittedAt
	}
	return c.CreatedAt
}

// isOverdue: a paid or processing run past overdueAfter. A run waiting for
// the user's bank (created) is not ours to be late on.
func isOverdue(c *store.Conversion, now time.Time) bool {
	if c.State != store.StatePaid && c.State != store.StateProcessing {
		return false
	}
	return now.Sub(runStart(c)) > overdueAfter(c.Support.ExpectedSeconds)
}

// alertIfOverdue posts the Slack alert once per run. Called from the
// status poll, so it fires whether or not the user is watching.
func (s *Service) alertIfOverdue(ctx context.Context, conv *store.Conversion) {
	now := time.Now().UTC()
	if conv.Support.OverdueAlertedAt != nil || !isOverdue(conv, now) {
		return
	}
	claimed := false
	_, err := s.Store.Transition(ctx, conv.ID, []string{store.StatePaid, store.StateProcessing}, func(c *store.Conversion) error {
		if c.Support.OverdueAlertedAt != nil {
			return store.ErrStateConflict
		}
		c.Support.OverdueAlertedAt = &now
		claimed = true
		return nil
	})
	if err != nil || !claimed {
		return
	}
	httpx.Log(ctx).Warn("conversion overdue", "conversion_id", conv.ID, "uid", conv.UID,
		"stage", conv.Modal.Stage, "expected_s", conv.Support.ExpectedSeconds)
	s.Slack.ConversionOverdue(ctx, conv.ID, conv.UID, conv.Modal.Stage,
		now.Sub(runStart(conv)), time.Duration(conv.Support.ExpectedSeconds)*time.Second)
}

var errTooManyReports = errors.New("too many reports")

// POST /v1/conversions/{id}/report — the user tells us a run is stuck.
// Body: {"note": "..."} (optional). Answers with the conversion, whose
// reported_at then tells the client to show the thank-you.
func (s *Service) HandleReportConversion(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	conv, err := s.ownedConversion(ctx, user, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	var req struct {
		Note string `json:"note"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req) // the note is optional
	}
	note := strings.TrimSpace(req.Note)
	if runes := []rune(note); len(runes) > maxReportNote {
		note = string(runes[:maxReportNote])
	}
	if store.IsTerminal(conv.State) {
		httpx.WriteOK(w, s.conversionResponse(conv, nil)) // finished meanwhile
		return
	}
	now := time.Now().UTC()
	updated, err := s.Store.Transition(ctx, id, store.ActiveStates, func(c *store.Conversion) error {
		if len(c.Support.Reports) >= maxReportsPerRun {
			return errTooManyReports
		}
		c.Support.Reports = append(c.Support.Reports, store.Report{At: now, Note: note, Email: user.Email})
		return nil
	})
	switch {
	case errors.Is(err, errTooManyReports):
		httpx.WriteOK(w, s.conversionResponse(conv, nil)) // already heard
		return
	case errors.Is(err, store.ErrStateConflict):
		if fresh, gerr := s.Store.GetConversion(ctx, id); gerr == nil {
			httpx.WriteOK(w, s.conversionResponse(fresh, nil))
			return
		}
		httpx.WriteErr(ctx, w, err)
		return
	case err != nil:
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.Log(ctx).Warn("conversion reported", "conversion_id", id, "uid", user.UID,
		"stage", conv.Modal.Stage, "note", note)
	s.Slack.ConversionReported(ctx, id, user.UID, user.Email, conv.Modal.Stage, now.Sub(runStart(conv)), note)
	httpx.WriteOK(w, s.conversionResponse(updated, nil))
}
