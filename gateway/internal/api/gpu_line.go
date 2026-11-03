package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/mail"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// GPU-line alert (S3D-34): when a customer run has waited for a GPU longer
// than gpuWaitAlertAfter, the owner gets a mail — who waits, for what,
// how long, and how busy each pipeline's GPUs look — at most every
// gpuLineMailEvery while the line lasts, then one "line cleared" mail with
// the longest wait. Checked by every reconcile sweep (each minute); the
// throttle lives in Firestore (ops_{env}/gpu_line), so instances agree.

const (
	gpuWaitAlertAfter = 60 * time.Second
	gpuLineMailEvery  = 15 * time.Minute
)

type waitingRun struct {
	Conv      *store.Conversion
	Workspace string
	Waited    time.Duration
}

// gpuUse is one Modal workspace's estimated busy GPUs per method and its
// per-app cap (S3D-40: caps and queues are per workspace).
type gpuUse struct {
	Workspace string
	Busy      map[string]int
	Cap       int
}

// gpuLineSnapshot picks the runs waiting past the alert threshold (longest
// first) and estimates each workspace's busy GPUs per method from the runs
// that are processing and not waiting, each counted at its worker cap and
// the total held to the workspace's per-app cap (the gateway can't see
// Modal's slots). The default workspace is always listed.
func (s *Service) gpuLineSnapshot(processing []*store.Conversion, now time.Time, rates *pricing.Rates) ([]waitingRun, []gpuUse) {
	var waiting []waitingRun
	use := map[string]*gpuUse{}
	get := func(ws string) *gpuUse {
		if u, ok := use[ws]; ok {
			return u
		}
		u := &gpuUse{Workspace: ws, Busy: map[string]int{store.MethodClassic: 0, store.MethodLifelike: 0}, Cap: rates.GPUCapFor(ws)}
		use[ws] = u
		return u
	}
	get(s.workspaceID(""))
	for _, c := range processing {
		if c.State != store.StateProcessing {
			continue
		}
		method, ws := store.MethodOr(c.Method), s.workspaceID(c.Workspace)
		u := get(ws)
		if c.Modal.WaitingForGPU {
			if c.Modal.WaitingSince != nil && now.Sub(*c.Modal.WaitingSince) > gpuWaitAlertAfter {
				waiting = append(waiting, waitingRun{Conv: c, Workspace: ws, Waited: now.Sub(*c.Modal.WaitingSince)})
			}
			continue
		}
		workers := rates.GPUWorkersFor(method)
		if c.Step == store.StepLifelikePreview || workers <= 0 {
			workers = 1
		}
		u.Busy[method] = min(u.Busy[method]+workers, u.Cap)
	}
	slices.SortFunc(waiting, func(a, b waitingRun) int { return int(b.Waited - a.Waited) })
	out := make([]gpuUse, 0, len(use))
	for _, u := range use {
		out = append(out, *u)
	}
	slices.SortFunc(out, func(a, b gpuUse) int { return strings.Compare(a.Workspace, b.Workspace) })
	return waiting, out
}

var errNoChange = errors.New("no change")

// checkGPULine runs the alert for one sweep.
func (s *Service) checkGPULine(ctx context.Context) {
	processing, err := s.Store.ListByState(ctx, store.StateProcessing, 200)
	if err != nil {
		slog.WarnContext(ctx, "gpu line: list failed", "err", err)
		return
	}
	rates := s.Pricing.Rates(ctx)
	now := time.Now().UTC()
	waiting, use := s.gpuLineSnapshot(processing, now, rates)
	if len(waiting) > 0 {
		longest := waiting[0].Waited
		var send bool
		_, err := s.Store.UpdateGPULine(ctx, func(l *store.GPULine) error {
			send = false
			if !l.Active {
				l.Active, l.StartedAt, l.LongestWaitS = true, &now, 0
				send = true
			} else if l.LastMailAt == nil || now.Sub(*l.LastMailAt) >= gpuLineMailEvery {
				send = true
			}
			l.LongestWaitS = max(l.LongestWaitS, longest.Seconds())
			if send {
				l.LastMailAt = &now
			}
			return nil
		})
		if err != nil {
			slog.WarnContext(ctx, "gpu line: state update failed", "err", err)
			return
		}
		if send {
			s.mailOwner(ctx, gpuLineMail(waiting, use, s.accountEmails(ctx, waiting)))
		}
		return
	}
	var cleared store.GPULine
	_, err = s.Store.UpdateGPULine(ctx, func(l *store.GPULine) error {
		if !l.Active {
			return errNoChange // nothing to write, minute after minute
		}
		cleared = *l
		*l = store.GPULine{}
		return nil
	})
	if errors.Is(err, errNoChange) {
		return
	}
	if err != nil {
		slog.WarnContext(ctx, "gpu line: clear failed", "err", err)
		return
	}
	s.mailOwner(ctx, gpuLineClearedMail(cleared, now))
}

func (s *Service) accountEmails(ctx context.Context, waiting []waitingRun) map[string]string {
	out := map[string]string{}
	for _, w := range waiting {
		uid := w.Conv.UID
		if _, ok := out[uid]; ok {
			continue
		}
		out[uid] = ""
		if c, err := s.Store.GetCustomer(ctx, uid); err == nil {
			out[uid] = c.Email
		}
	}
	return out
}

// mailOwner sends an operational mail to the owner's alert address; without
// one (or a mail key) it is logged instead.
func (s *Service) mailOwner(ctx context.Context, m mail.Message) {
	to := ""
	if s.Cfg != nil {
		to = s.Cfg.OwnerAlertEmail
	}
	if to == "" || !s.Mail.Configured() {
		slog.InfoContext(ctx, "owner mail (not sent: no address or key)", "subject", m.Subject)
		return
	}
	m.To = to
	if err := s.Mail.Send(ctx, m); err != nil {
		slog.ErrorContext(ctx, "owner mail failed", "subject", m.Subject, "err", err)
		return
	}
	slog.InfoContext(ctx, "owner mail sent", "subject", m.Subject)
}

func gpuLineMail(waiting []waitingRun, use []gpuUse, emails map[string]string) mail.Message {
	var b strings.Builder
	n := len(waiting)
	runs := "run"
	if n != 1 {
		runs = "runs"
	}
	fmt.Fprintf(&b, "%d customer %s waiting for a GPU for more than %s.\n\n", n, runs, formatWait(gpuWaitAlertAfter))
	for _, w := range waiting {
		c := w.Conv
		email := emails[c.UID]
		if email == "" {
			email = "uid " + c.UID
		}
		fmt.Fprintf(&b, "- %s — %s %s, %s, %s of video, waiting %s (conversion %s, workspace %s)\n",
			email, store.MethodOr(c.Method), c.Step, resolutionLabel(c, nil),
			formatWait(time.Duration(outputSecondsOf(c)*float64(time.Second))), formatWait(w.Waited), c.ID, w.Workspace)
	}
	b.WriteString("\nGPUs busy (estimated from runs in progress, per app):\n")
	for _, u := range use {
		fmt.Fprintf(&b, "- %s: Classic %d of %d, Lifelike %d of %d\n", u.Workspace,
			u.Busy[store.MethodClassic], u.Cap, u.Busy[store.MethodLifelike], u.Cap)
	}
	fmt.Fprintf(&b, "\nOldest wait: %s.\n", formatWait(waiting[0].Waited))
	return mail.Message{
		Subject: fmt.Sprintf("Stereo3D Studio: %d %s waiting for a GPU (longest %s)", n, runs, formatWait(waiting[0].Waited)),
		Text:    b.String(),
	}
}

func gpuLineClearedMail(l store.GPULine, now time.Time) mail.Message {
	lasted := ""
	if l.StartedAt != nil {
		lasted = fmt.Sprintf(" after %s", formatWait(now.Sub(*l.StartedAt)))
	}
	longest := formatWait(time.Duration(l.LongestWaitS * float64(time.Second)))
	return mail.Message{
		Subject: "Stereo3D Studio: GPU line cleared (longest wait " + longest + ")",
		Text:    fmt.Sprintf("No customer run is waiting for a GPU any more%s. The longest wait was %s.\n", lasted, longest),
	}
}

// outputSecondsOf is a run's priced length (its trim), else the source's.
func outputSecondsOf(c *store.Conversion) float64 {
	if c.Source.FPS > 0 && c.Source.Frames > 0 {
		if s, err := billableSeconds(c.Source.Frames, c.Source.FPS, c.Params.FromFrame, c.Params.ToFrame); err == nil {
			return s
		}
	}
	return c.Source.DurationS
}

// formatWait renders "45s", "6m 32s", "1h 4m".
func formatWait(d time.Duration) string {
	d = d.Round(time.Second)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm %ds", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%dh %dm", int(d.Hours()), int(d.Minutes())%60)
}
