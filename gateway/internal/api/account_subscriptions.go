package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// stopSubscriptionsForDeletion ends every web subscription of uid's
// (Business, Studio, web Pro: all of them sit in customer.plan, plus any
// other live svs-web subscription on its Stripe customer) at the end of
// the period already paid (3DS P1, 2026-11-06): a waiting schedule (a
// step-down) is released first, since Stripe takes no update on a
// subscription a schedule manages, then cancel_at_period_end. No refund,
// no proration, the current period untouched (the refund policy is the
// owner's open decision). An incomplete one (its first payment never went
// through) ends now. Idempotent: what is already released or set is left;
// any Stripe failure is returned so the deletion fails retryably before
// anything else is removed.
func (s *Service) stopSubscriptionsForDeletion(ctx context.Context, uid string, cust *store.Customer) error {
	if cust == nil || s.Stripe == nil {
		return nil
	}
	ids := []string{}
	seen := map[string]bool{}
	add := func(id string) {
		if id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if cust.Plan != nil {
		add(cust.Plan.SubscriptionID)
	}
	if cust.StripeCustomerID != "" {
		subs, err := s.Stripe.CustomerSubscriptions(cust.StripeCustomerID)
		if err != nil {
			return fmt.Errorf("list subscriptions: %w", err)
		}
		for _, sub := range subs {
			if sub.Live() && sub.Metadata["product"] == "svs-web" && sub.Metadata["env"] == s.Cfg.Env {
				add(sub.ID)
			}
		}
	}
	for _, id := range ids {
		if err := s.stopSubscription(ctx, id); err != nil {
			return err
		}
	}
	if cust.Plan != nil && cust.Plan.SubscriptionID != "" {
		_, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
			if c.Plan != nil && c.Plan.SubscriptionID == cust.Plan.SubscriptionID {
				c.Plan.CancelAtPeriodEnd = true
				c.Plan.ScheduleID, c.Plan.ScheduledTo, c.Plan.ScheduledAt = "", "", nil
				c.Plan.UpdatedAt = time.Now().UTC()
			}
			return nil
		})
		return err
	}
	return nil
}

func (s *Service) stopSubscription(ctx context.Context, id string) error {
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
	slog.InfoContext(ctx, "subscription set to end with the deleted account", "subscription", id, "status", sub.Status)
	return nil
}

// errSubscriptionsNotStopped wraps a Stripe failure while deleting.
var errSubscriptionsNotStopped = errors.New("subscriptions not stopped")

// ---------------------------------------------------------- orphans

// orphanSweepEvery: how often an instance looks (Firebase lookups, one per
// live plan).
const orphanSweepEvery = 6 * time.Hour

var lastOrphanSweep atomic.Int64

// orphanSweepDue runs sweepOrphanSubscriptions at most every
// orphanSweepEvery per instance, in the mode configured (off on prod until
// the owner's yes).
func (s *Service) orphanSweepDue(ctx context.Context) (found, ended int) {
	mode := ""
	if s.Cfg != nil {
		mode = s.Cfg.OrphanSweep
	}
	if mode != "report" && mode != "on" {
		return 0, 0
	}
	now := time.Now().Unix()
	last := lastOrphanSweep.Load()
	if now-last < int64(orphanSweepEvery.Seconds()) || !lastOrphanSweep.CompareAndSwap(last, now) {
		return 0, 0
	}
	return s.sweepOrphanSubscriptions(ctx, mode == "on")
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

// sweepOrphanSubscriptions finds customers with a web subscription that can
// still renew whose Firebase user no longer exists (the app deleted it
// without the gateway, before 10.5.8), and with act ends them the way a
// deletion does: subscriptions at period end, the account marked deleted.
// Without act it only reports (counts in the log and Slack, no ids).
func (s *Service) sweepOrphanSubscriptions(ctx context.Context, act bool) (found, ended int) {
	custs, err := s.Store.ListPlanCustomers(ctx, 1000)
	if err != nil {
		slog.WarnContext(ctx, "orphan sweep: plan customers unread", "err", err)
		return 0, 0
	}
	for uid, c := range custs {
		if c.AccountDeleted || c.Plan == nil || c.Plan.SubscriptionID == "" || c.Plan.CancelAtPeriodEnd ||
			(c.Plan.Status != "active" && c.Plan.Status != "trialing" && c.Plan.Status != "past_due") {
			continue
		}
		exists, err := s.userExists(ctx, uid)
		if err != nil || exists {
			continue
		}
		found++
		if !act {
			continue
		}
		if err := s.finishAccountDeletionKeeping(ctx, uid, true); err != nil {
			slog.WarnContext(ctx, "orphan sweep: not ended", "uid", uid, "err", err)
			continue
		}
		slog.InfoContext(ctx, "orphan sweep: subscription set to end, account marked deleted", "uid", uid)
		ended++
	}
	mode := "report"
	if act {
		mode = "on"
	}
	slog.InfoContext(ctx, "orphan sweep", "mode", mode, "found", found, "ended", ended)
	if found > 0 {
		s.Slack.Alert(ctx, "orphan_subscriptions", fmt.Sprintf("orphan sweep (%s): %d web subscription(s) whose sign-in no longer exists; %d set to end", mode, found, ended))
	}
	return found, ended
}
