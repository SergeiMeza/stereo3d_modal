package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The 48-hour wait before an account deletion (owner 2026-11-07, test
// first): a delete request runs today's checks and collects today's dues,
// then waits account_delete_delay_hours before the deletion itself runs,
// so nobody can delete and make the account again at once. While it
// waits the account is frozen (FrozenWhileDeleting); the person can keep
// it (POST /v1/account/delete/cancel), and the sweep runs runDeletion,
// unchanged, at delete_after.

// codeAccountPendingDeletion refuses what a pending deletion freezes.
const codeAccountPendingDeletion = "account_pending_deletion"

// Retry spacing for a sweep that found the deletion blocked.
const (
	deletionRetryActive = 15 * time.Minute // a run still going finishes on its own
	deletionRetryBlock  = 6 * time.Hour    // a plan, dues: the person or support acts first
	deletionSweepLease  = 10 * time.Minute // one sweep at a time per row
)

func (s *Service) accountDeleteDelay(ctx context.Context) time.Duration {
	h := s.Pricing.Rates(ctx).AccountDeleteDelayHours
	if h <= 0 {
		return 0
	}
	return time.Duration(min(h, 24*30)) * time.Hour
}

// scheduleDeletion makes the deletion pending once runDeletion's checks
// passed: 202 with the schedule, and the request mail on the first ask.
func (s *Service) scheduleDeletion(ctx context.Context, uid string, cust *store.Customer, o deletionOpts) (int, map[string]any, error) {
	now := time.Now().UTC()
	email := o.Email
	if cust != nil && cust.Email != "" {
		email = cust.Email // the account's own address
	}
	d, created, err := s.Store.ScheduleAccountDeletion(ctx, &store.AccountDeletion{UID: uid, RequestedAt: now,
		DeleteAfter: now.Add(o.Delay), BalanceConfirmed: o.BalanceConfirmed, Email: email, Source: o.Source, KeepSignIn: o.KeepSignIn})
	if err != nil {
		return 0, nil, err
	}
	if created {
		slog.InfoContext(ctx, "account deletion scheduled", "uid", uid, "delete_after", d.DeleteAfter)
		s.mailCustomer(ctx, fmt.Sprintf("DL1_%s_%d", uid, d.RequestedAt.Unix()), uid, d.Email, deletionScheduledMail(d.DeleteAfter, s.Cfg.SiteURL))
	}
	return http.StatusAccepted, scheduledDeletionBody(d, deletionPlan(cust)), nil
}

// scheduledDeletionBody is the answer while a deletion waits. It keeps
// the old keys (success, deleted: false) and adds the schedule, so
// clients that only know {deleted} see "not deleted yet".
func scheduledDeletionBody(d *store.AccountDeletion, plan map[string]any) map[string]any {
	out := map[string]any{"success": true, "deleted": false, "sign_in_removed": false,
		"state": "pending_deletion", "pending_deletion": true,
		"delete_after": d.DeleteAfter.UTC().Format(time.RFC3339), "requested_at": d.RequestedAt.UTC().Format(time.RFC3339),
		"message": "Your account will be deleted on " + deletionDate(d.DeleteAfter) + ". Sign in before then to keep it."}
	for k, v := range plan {
		out[k] = v
	}
	return out
}

func writeScheduledDeletion(w http.ResponseWriter, d *store.AccountDeletion, plan map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(scheduledDeletionBody(d, plan))
}

// deletionState is what account reads carry: {pending_deletion,
// delete_after (RFC 3339 or null)}.
func (s *Service) deletionState(ctx context.Context, uid string) map[string]any {
	out := map[string]any{"pending_deletion": false, "delete_after": nil}
	if d := s.Store.PendingAccountDeletion(ctx, uid); d != nil {
		out["pending_deletion"], out["delete_after"] = true, d.DeleteAfter.UTC().Format(time.RFC3339)
	}
	return out
}

// addDeletionState merges deletionState into an account read.
func (s *Service) addDeletionState(ctx context.Context, uid string, out map[string]any) {
	for k, v := range s.deletionState(ctx, uid) {
		out[k] = v
	}
}

// POST /v1/account/delete/cancel — keep the account (fresh sign-in): 200
// {state: "active", cancelled: true, pending_deletion: false}; 409
// not_pending_deletion when nothing waits.
func (s *Service) HandleCancelDeletion(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	d, err := s.cancelScheduledDeletion(ctx, user.UID, "customer")
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.WriteOK(w, map[string]any{"state": "active", "cancelled": true, "pending_deletion": false,
		"cancelled_at": d.CancelledAt.UTC().Format(time.RFC3339)})
}

func (s *Service) cancelScheduledDeletion(ctx context.Context, uid, who string) (*store.AccountDeletion, error) {
	d, err := s.Store.CancelAccountDeletion(ctx, uid, who, time.Now().UTC())
	if errors.Is(err, store.ErrNotPendingDeletion) {
		return nil, httpx.Err(http.StatusConflict, "not_pending_deletion", "This account isn't waiting to be deleted.")
	}
	if err != nil {
		return nil, err
	}
	slog.InfoContext(ctx, "account deletion cancelled", "uid", uid, "by", who)
	s.mailCustomer(ctx, fmt.Sprintf("DL2_%s_%d", uid, d.RequestedAt.Unix()), uid, d.Email, deletionCancelledMail(s.Cfg.SiteURL))
	return d, nil
}

// FrozenWhileDeleting wraps what a pending deletion freezes (new runs and
// previews, paying a waiting run, top-ups, plan purchases and moves,
// sign-in methods, emails): 409 account_pending_deletion {delete_after}.
// Runs already going finish; reads and the cancel stay open.
func (s *Service) FrozenWhileDeleting(h func(http.ResponseWriter, *http.Request, *AuthedUser)) func(http.ResponseWriter, *http.Request, *AuthedUser) {
	return func(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
		if d := s.Store.PendingAccountDeletion(r.Context(), user.UID); d != nil {
			httpx.WriteErr(r.Context(), w, errAccountPendingDeletion(d))
			return
		}
		h(w, r, user)
	}
}

func errAccountPendingDeletion(d *store.AccountDeletion) error {
	e := httpx.Err(http.StatusConflict, codeAccountPendingDeletion,
		"Your account will be deleted on "+deletionDate(d.DeleteAfter)+". Keep your account to do this.")
	e.Details = map[string]any{"delete_after": d.DeleteAfter.UTC().Format(time.RFC3339)}
	return e
}

// deletionScheduleSweep (reconciler) runs the deletions that are due.
func (s *Service) deletionScheduleSweep(ctx context.Context) map[string]int {
	stats := map[string]int{}
	rows, err := s.Store.ListAccountDeletions(ctx, store.DeletionStatePending, 100)
	if err != nil {
		return stats
	}
	now := time.Now().UTC()
	for _, d := range rows {
		if now.Before(d.DeleteAfter) || (d.NextAttemptAt != nil && now.Before(*d.NextAttemptAt)) {
			continue
		}
		outcome, err := s.processScheduledDeletion(ctx, d.UID, "sweep", false)
		switch {
		case errors.Is(err, errDeletionLeased):
		case err != nil:
			stats["deletions_blocked"]++
		default:
			stats["deletions_"+outcome]++
		}
	}
	return stats
}

var errDeletionLeased = errors.New("deletion being processed")

// processScheduledDeletion runs today's deletion for a pending row. A
// refusal leaves it pending, flagged (blocked_reason) for the console and
// tried again later; force (admin "Process now") skips delete_after.
func (s *Service) processScheduledDeletion(ctx context.Context, uid, by string, force bool) (string, error) {
	now := time.Now().UTC()
	d, err := s.Store.UpdateAccountDeletion(ctx, uid, func(d *store.AccountDeletion) error {
		if !force && (now.Before(d.DeleteAfter) || (d.NextAttemptAt != nil && now.Before(*d.NextAttemptAt))) {
			return errDeletionLeased
		}
		lease := now.Add(deletionSweepLease)
		d.NextAttemptAt = &lease
		d.Attempts++
		return nil
	})
	if err != nil {
		return "", err
	}
	requested := d.RequestedAt
	status, _, err := s.runDeletion(ctx, uid, deletionOpts{BalanceConfirmed: d.BalanceConfirmed, KeepSignIn: d.KeepSignIn, By: by,
		RequestedAt: &requested})
	if err == nil {
		outcome := store.DeletionOutcomeDeleted
		if status == http.StatusAccepted {
			outcome = store.DeletionOutcomeRefundCase
		}
		if ferr := s.Store.FinishAccountDeletionRow(ctx, uid, by, outcome, time.Now().UTC()); ferr != nil {
			slog.WarnContext(ctx, "deletion row not marked", "err", ferr)
		}
		if d.KeepSignIn && outcome == store.DeletionOutcomeDeleted { // the refund case's completion calls back itself
			via := viaSweep
			if by != "sweep" {
				via = viaAdmin
			}
			s.deletionCompleted(ctx, uid, d.RequestedAt, via)
		}
		slog.InfoContext(ctx, "scheduled deletion processed", "uid", uid, "outcome", outcome, "by", by)
		return outcome, nil
	}
	reason, retry := "delete_failed", deletionSweepLease
	var api *httpx.APIError
	if errors.As(err, &api) {
		reason = api.Code
		switch api.Code {
		case deleteBlockActive:
			retry = deletionRetryActive
		case "delete_failed":
		default:
			retry = deletionRetryBlock
		}
	}
	first := d.BlockedAt == nil
	if _, uerr := s.Store.UpdateAccountDeletion(ctx, uid, func(d *store.AccountDeletion) error {
		next := time.Now().UTC().Add(retry)
		d.BlockedReason, d.NextAttemptAt = reason, &next
		if d.BlockedAt == nil {
			at := time.Now().UTC()
			d.BlockedAt = &at
		}
		return nil
	}); uerr != nil {
		slog.WarnContext(ctx, "blocked deletion not flagged", "err", uerr)
	}
	slog.WarnContext(ctx, "scheduled deletion blocked", "uid", uid, "reason", reason, "by", by)
	if first {
		s.Slack.Alert(ctx, "deletion_blocked", fmt.Sprintf("account `%s`'s scheduled deletion is blocked (%s); it stays pending and is tried again", uid, reason))
	}
	return "", err
}

// deletionDate is the day a deletion runs, in mails and messages (UTC).
func deletionDate(t time.Time) string { return t.UTC().Format("2 January 2006") }

func deletionScheduledMail(after time.Time, site string) customerMail {
	return customerMail{Kind: "DL1", OwnAddress: true,
		Subject: "Spatial Video Studio: your account will be deleted on " + deletionDate(after),
		Lines: []string{
			"You asked us to delete your Spatial Video Studio account. We'll delete it on " + deletionDate(after) +
				" at " + after.UTC().Format("15:04") + " UTC.",
			"Until then your account is paused: runs you started finish, but you can't start new ones or change how you sign in.",
			"Changed your mind? Sign in before then and choose Keep my account.",
			"If you didn't ask for this, sign in and keep your account, then reply to this email.",
		},
		Button: "Sign in to keep your account", Link: strings.TrimRight(site, "/") + "/account?deletion=keep"}
}

func deletionCancelledMail(site string) customerMail {
	return customerMail{Kind: "DL2", OwnAddress: true,
		Subject: "Spatial Video Studio: your account won't be deleted",
		Lines:   []string{"You kept your Spatial Video Studio account, so we won't delete it. Everything works as before."},
		Button:  "Open Spatial Video Studio", Link: strings.TrimRight(site, "/") + "/"}
}

// GET /v1/admin/deletions?state=pending|cancelled|done → {deletions:
// [{uid, state, requested_at, delete_after, balance_confirmed, source,
// blocked_reason?, blocked_at?, next_attempt_at?, attempts, cancelled_at?,
// cancelled_by?, processed_at?, processed_by?, outcome?}]}, soonest first.
func (s *Service) HandleAdminDeletions(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	state := r.URL.Query().Get("state")
	if state == "" {
		state = store.DeletionStatePending
	}
	switch state {
	case store.DeletionStatePending, store.DeletionStateCancelled, store.DeletionStateDone:
	default:
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("state is pending, cancelled or done"))
		return
	}
	rows, err := s.Store.ListAccountDeletions(ctx, state, 200)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	s.audit(ctx, a, "deletions_view", map[string]any{"state": state})
	out := make([]map[string]any, 0, len(rows))
	for _, d := range rows {
		out = append(out, adminDeletionJSON(d))
	}
	httpx.WriteOK(w, map[string]any{"deletions": out})
}

// adminDeletionJSON is a deletion row for the console (no email: the
// account page has it).
func adminDeletionJSON(d *store.AccountDeletion) map[string]any {
	if d == nil {
		return nil
	}
	ts := func(t *time.Time) any {
		if t == nil {
			return nil
		}
		return t.UTC().Format(time.RFC3339)
	}
	return map[string]any{"uid": d.UID, "state": d.State,
		"requested_at": d.RequestedAt.UTC().Format(time.RFC3339), "delete_after": d.DeleteAfter.UTC().Format(time.RFC3339),
		"balance_confirmed": d.BalanceConfirmed, "source": d.Source, "blocked": d.BlockedReason != "",
		"blocked_reason": d.BlockedReason, "blocked_at": ts(d.BlockedAt), "next_attempt_at": ts(d.NextAttemptAt),
		"attempts": d.Attempts, "cancelled_at": ts(d.CancelledAt), "cancelled_by": d.CancelledBy,
		"processed_at": ts(d.ProcessedAt), "processed_by": d.ProcessedBy, "outcome": d.Outcome}
}

// adminDeletionAction is the console's "Cancel deletion" and "Process
// now" (fresh sign-in), each noted on the case when one is named.
func (s *Service) adminDeletionAction(ctx context.Context, a *AdminUser, uid, action, caseID, note string) error {
	var err error
	text := ""
	switch action {
	case "cancel_deletion":
		_, err = s.cancelScheduledDeletion(ctx, uid, "admin:"+a.who())
		text = "scheduled deletion cancelled"
	case "process_deletion_now":
		if s.Store.PendingAccountDeletion(ctx, uid) == nil {
			return httpx.Err(http.StatusConflict, "not_pending_deletion", "This account isn't waiting to be deleted.")
		}
		var outcome string
		outcome, err = s.processScheduledDeletion(ctx, uid, "admin:"+a.who(), true)
		text = "scheduled deletion processed now: " + outcome
		var api *httpx.APIError
		if errors.As(err, &api) {
			text = "scheduled deletion process now refused: " + api.Code
		}
	}
	if caseID != "" && text != "" {
		if note != "" {
			text += ": " + note
		}
		s.Store.AddCaseEvent(ctx, caseID, store.CaseEvent{Who: a.who(), Kind: "note", Text: text})
	}
	return err
}
