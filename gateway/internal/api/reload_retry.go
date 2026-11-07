package api

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// A failed auto-reload (D2, D3): auto-reload is paused and nothing is
// credited; a soft decline is charged again at +24 h and +72 h (keys
// topup_{env}_{id}_r{n}); the failure mail links to the pay page for that
// amount (D7). Turning auto-reload back on, turning it off or any top-up
// that pays cancels what is still pending.

// startReloadRetry records the first failure's schedule and mails E15
// (none for a configuration error: B2, the owner was alerted).
func (s *Service) startReloadRetry(ctx context.Context, t *store.Topup, f stripex.ChargeFailure) {
	now := time.Now().UTC()
	r := startRetry(f, t.Cents, now)
	link := s.Cfg.SiteURL + "/billing"
	if r.Reason != retryConfig {
		var pr *store.PayRequest
		if link, pr = s.payLink(ctx, t.UID, store.PayKindTopup, t.ID, t.Cents, topupLabel(t.Cents)); pr != nil {
			r.PayRequestID = pr.ID
		}
	}
	if _, err := s.Store.UpdateTopup(ctx, t.ID, func(x *store.Topup) error {
		x.Retry = r
		return nil
	}); err != nil {
		slog.WarnContext(ctx, "reload retry not recorded", "topup_id", t.ID, "err", err)
		return
	}
	if r.Reason != retryConfig {
		s.mailReloadFailed(ctx, "E15_"+t.ID, t, r, link)
	}
}

// mailReloadFailed is E15: the reload didn't go through, what happens next,
// and the pay link.
func (s *Service) mailReloadFailed(ctx context.Context, key string, t *store.Topup, r *store.OffSessionRetry, link string) {
	lines := []string{"We couldn't add " + money(t.Cents) + usdNote + " to your balance. " + r.LastErrorMessage}
	switch {
	case r.State == store.RetryPending:
		lines = append(lines, "We'll try again on "+retryDay(r)+". Auto-reload is paused until then; nothing was charged.")
	case r.Reason == retryAuth:
		lines = append(lines, "Confirm the payment to add the funds. Auto-reload is paused until you turn it back on.")
	default:
		lines = append(lines, "Auto-reload is paused until you turn it back on. Nothing was charged.")
	}
	button := "Pay " + money(t.Cents)
	if r.Reason == retryAuth {
		button = "Confirm and pay " + money(t.Cents)
	}
	s.mailCustomer(ctx, key, t.UID, s.accountEmail(ctx, t.UID), customerMail{
		Kind: "E15", Subject: "Spatial Video Studio: auto-reload didn't go through", Lines: lines, Button: button, Link: link,
	})
}

// reloadRetrySweep charges the reloads whose retry is due (reconciler).
func (s *Service) reloadRetrySweep(ctx context.Context, now time.Time) int {
	due, err := s.Store.ListTopupsByRetryState(ctx, store.RetryPending, 100)
	if err != nil {
		slog.WarnContext(ctx, "reload retries not listed", "err", err)
		return 0
	}
	n := 0
	for _, t := range due {
		if t.Retry.Due(now) && !t.Lease.Held(now) {
			s.retryReload(ctx, t.ID)
			n++
		}
	}
	return n
}

// retryReload is one due retry of a failed reload, under the top-up's
// lease.
func (s *Service) retryReload(ctx context.Context, topupID string) {
	now := time.Now().UTC()
	t, err := s.Store.UpdateTopup(ctx, topupID, func(x *store.Topup) error {
		if x.State != store.TopupFailed || !x.Retry.Due(now) || x.Lease.Held(now) {
			return store.ErrStateConflict
		}
		x.Lease = &store.Lease{Owner: leaseOwner, Until: now.Add(leaseTTL)}
		return nil
	})
	if err != nil {
		return
	}
	release := func(mut func(r *store.OffSessionRetry)) {
		s.Store.UpdateTopup(ctx, topupID, func(x *store.Topup) error {
			x.Lease = nil
			if mut != nil && x.Retry != nil {
				mut(x.Retry)
			}
			return nil
		})
	}
	cancel := func(why string) {
		release(func(r *store.OffSessionRetry) {
			r.State, r.CloseReason, r.ClosedAt, r.NextAttemptAt = store.RetryCanceled, why, &now, nil
		})
		slog.InfoContext(ctx, "reload retry cancelled", "topup_id", topupID, "why", why)
	}
	cust, err := s.Store.GetCustomer(ctx, t.UID)
	b, berr := s.Store.GetBalance(ctx, t.UID)
	switch {
	case err != nil || berr != nil:
		release(nil)
		return
	case cust.AccountDeleted || cust.DeletionPending || cust.UnderReview || cust.SheetOnly:
		cancel("account can't be charged")
		return
	case !b.AutoReload.Enabled:
		cancel("auto-reload off")
		return
	case b.AutoReload.PausedReason == "":
		cancel("auto-reload back on")
		return
	case s.owedCents(ctx, t.UID) > 0:
		cancel("a debt exists") // R1
		return
	}
	if cust.DefaultPaymentMethod == "" {
		cust = s.refreshCardCache(ctx, t.UID, cust.StripeCustomerID)
	}
	if cust.DefaultPaymentMethod == "" {
		cancel("no saved method")
		return
	}
	attempt := t.Retry.Attempts + 1
	o := s.chargeReload(ctx, t, cust, attempt)
	switch {
	case o.transient:
		release(nil) // the next sweep tries again under the same keys
		return
	case o.closedPaid != nil:
		release(func(r *store.OffSessionRetry) { r.State, r.ClosedAt, r.NextAttemptAt = store.RetryPaid, &now, nil })
		_ = s.applyTopupPayment(ctx, topupID, *o.closedPaid)
		return
	case o.paid:
		release(func(r *store.OffSessionRetry) {
			r.Attempts, r.State, r.ClosedAt, r.NextAttemptAt = attempt, store.RetryPaid, &now, nil
		})
		slog.InfoContext(ctx, "reload paid on retry", "topup_id", topupID, "attempt", attempt)
		s.reloadPaid(ctx, topupID, o)
		return
	}
	if o.fail.Stop {
		s.setSheetOnly(ctx, t.UID, "stop code "+o.fail.DeclineCode)
	}
	var r store.OffSessionRetry
	updated, _ := s.Store.UpdateTopup(ctx, topupID, func(x *store.Topup) error {
		x.Lease = nil
		if x.Retry != nil {
			recordFailure(x.Retry, o.fail, now)
			r = *x.Retry
		}
		return nil
	})
	if updated != nil && r.State == store.RetryFinal && r.Reason != retryConfig {
		link := s.Cfg.SiteURL + "/billing"
		if r.PayRequestID != "" {
			link = s.payURL(r.PayRequestID)
		}
		s.mailReloadFailed(ctx, fmt.Sprintf("E15_%s_final", topupID), updated, &r, link)
	}
}

// cancelReloadRetries ends the account's pending reload retries (auto-reload
// turned back on or off, a top-up paid): a later retry would charge on top.
func (s *Service) cancelReloadRetries(ctx context.Context, uid, why string) {
	list, err := s.Store.ListUserReloadRetries(ctx, uid)
	if err != nil {
		return
	}
	now := time.Now().UTC()
	for _, t := range list {
		if t.Retry == nil || t.Retry.State != store.RetryPending && t.Retry.State != store.RetryFinal {
			continue
		}
		s.Store.UpdateTopup(ctx, t.ID, func(x *store.Topup) error {
			if x.Retry != nil && (x.Retry.State == store.RetryPending || x.Retry.State == store.RetryFinal) && !x.Lease.Held(now) {
				x.Retry.State, x.Retry.CloseReason, x.Retry.ClosedAt, x.Retry.NextAttemptAt = store.RetryCanceled, why, &now, nil
			}
			return nil
		})
	}
}

// reloadRetryJSON is the account's latest failed reload still pending or
// final (prepaid.auto_reload.retry), nil when none.
func (s *Service) reloadRetryJSON(ctx context.Context, uid string) map[string]any {
	list, err := s.Store.ListUserReloadRetries(ctx, uid)
	if err != nil || len(list) == 0 {
		return nil
	}
	sort.Slice(list, func(i, j int) bool { return list[i].CreatedAt.After(list[j].CreatedAt) })
	for _, t := range list {
		if j := s.retryJSON(t.Retry); j != nil {
			return j
		}
	}
	return nil
}
