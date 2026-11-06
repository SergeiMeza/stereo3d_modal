package api

import (
	"context"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// endAtPeriodEnd sets one subscription to end at its period end (the
// person's own cancel, /v1/account/plan/cancel): a waiting schedule (a
// step-down) is released first, since Stripe takes no cancel on a
// subscription a schedule manages; an incomplete one ends now.
// Idempotent: what is already released or set is left.
func (s *Service) endAtPeriodEnd(ctx context.Context, id string) error {
	sub, err := s.Stripe.GetSubscription(id)
	if err != nil {
		if stripex.NotFound(err) {
			return nil // gone already
		}
		return fmt.Errorf("read subscription: %w", err)
	}
	if !sub.Live() {
		return nil
	}
	if sub.Schedule != "" {
		if err := s.Stripe.ReleaseSchedule(sub.Schedule); err != nil {
			// a retry may find it released meanwhile: read again
			again, gerr := s.Stripe.GetSubscription(id)
			if gerr != nil || again.Schedule != "" {
				return fmt.Errorf("release schedule: %w", err)
			}
		}
	}
	switch {
	case sub.Status == "incomplete":
		if err := s.Stripe.CancelSubscriptionNow(id); err != nil && !stripex.NotFound(err) {
			return fmt.Errorf("cancel incomplete subscription: %w", err)
		}
	case !sub.CancelAtPeriodEnd || sub.Schedule != "":
		if _, err := s.Stripe.SetCancelAtPeriodEnd(id, true); err != nil {
			return fmt.Errorf("cancel at period end: %w", err)
		}
	}
	slog.InfoContext(ctx, "subscription set to end at its period end", "subscription", id, "status", sub.Status)
	return nil
}

// ---------------------------------------------------------- orphans

// orphanSweepEvery: how often an instance looks (Firebase lookups, one per
// live plan).
const orphanSweepEvery = 6 * time.Hour

var lastOrphanSweep atomic.Int64

// orphanSweepDue runs sweepOrphanSubscriptions at most every
// orphanSweepEvery per instance when ORPHAN_SWEEP is report (test's
// default; prod's is off). It only reports: under the owner's policy
// (2026-11-06) a cancelled plan runs on after its account is deleted.
func (s *Service) orphanSweepDue(ctx context.Context) int {
	if s.Cfg == nil || s.Cfg.OrphanSweep != "report" {
		return 0
	}
	now := time.Now().Unix()
	last := lastOrphanSweep.Load()
	if now-last < int64(orphanSweepEvery.Seconds()) || !lastOrphanSweep.CompareAndSwap(last, now) {
		return 0
	}
	return s.sweepOrphanSubscriptions(ctx)
}

// userExists: the Firebase user is still there (nil lookup: assume so).
func (s *Service) userExists(ctx context.Context, uid string) (bool, error) {
	if s.UserExists != nil {
		return s.UserExists(ctx, uid)
	}
	if s.Auth == nil {
		return true, nil
	}
	return s.Auth.UserExists(ctx, uid)
}

// sweepOrphanSubscriptions counts customers with a web subscription that
// will renew whose Firebase user no longer exists (the app deleted it
// without the gateway, before 10.5.8), and those whose account is marked
// deleted while the plan still renews. Report only (log and Slack, counts,
// no ids); it never cancels.
func (s *Service) sweepOrphanSubscriptions(ctx context.Context) int {
	custs, err := s.Store.ListPlanCustomers(ctx, 1000)
	if err != nil {
		slog.WarnContext(ctx, "orphan sweep: plan customers unread", "err", err)
		return 0
	}
	gone, deletedRenewing := 0, 0
	for uid, c := range custs {
		if !planRenewing(c) {
			continue
		}
		if c.AccountDeleted {
			deletedRenewing++
			continue
		}
		if exists, err := s.userExists(ctx, uid); err == nil && !exists {
			gone++
		}
	}
	slog.InfoContext(ctx, "orphan sweep (report)", "user_gone_renewing", gone, "deleted_renewing", deletedRenewing)
	if gone+deletedRenewing > 0 {
		s.Slack.Alert(ctx, "orphan_subscriptions", fmt.Sprintf("orphan sweep (report only): %d renewing web plan(s) whose sign-in no longer exists, %d on deleted accounts", gone, deletedRenewing))
	}
	return gone + deletedRenewing
}
