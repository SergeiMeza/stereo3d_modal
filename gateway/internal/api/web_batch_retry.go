package api

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// A failed web group (deferred-ready, D2 + D7 on groups): its first
// failure starts the web's retry schedule — a soft decline is collected
// again at +24 h and +72 h (do_not_honor once), each try a new settle
// under its own key (settle_{env}_{id}), with the web's rules (pmc_web,
// backups); a bank check, a hard decline, a stop code or a configuration
// error is never retried. The failure mail links to a pay page for what
// the account owes (kind settle), and Billing shows the schedule on the
// group (unpaid[].retry) and at the top (retry). A group paid any other
// way ends its schedule. App groups keep their single 24 h retry
// (SoftRetried), unchanged.

// owedLabel is a settle pay link's label.
const owedLabel = "Your last runs"

// startWebBatchRetry records a web group's schedule after its final
// failure, with the pay link (none for a configuration error: B2, the
// owner was alerted). It returns the schedule and the link.
func (s *Service) startWebBatchRetry(ctx context.Context, b *store.Batch, f stripex.ChargeFailure) (*store.OffSessionRetry, string) {
	now := time.Now().UTC()
	r := startRetry(f, b.TotalCents, now)
	link := s.Cfg.SiteURL + "/billing?pay=1"
	if r.Reason != retryConfig {
		var pr *store.PayRequest
		if link, pr = s.payLink(ctx, b.UID, store.PayKindSettle, "owed", s.owedCents(ctx, b.UID), owedLabel); pr != nil {
			r.PayRequestID = pr.ID
		}
	}
	if _, err := s.Store.TransitionBatch(ctx, b.ID, []string{store.BatchFailed}, func(bb *store.Batch) error {
		if bb.Retry == nil {
			bb.Retry = r
		}
		bb.SoftRetried = true // the schedule replaces the single 24 h retry
		return nil
	}, nil, nil); err != nil {
		slog.WarnContext(ctx, "web group retry not recorded", "batch_id", b.ID, "err", err)
	}
	return r, link
}

// failWebBatchNoMethod fails a web group with nothing saved to charge:
// no retry (final), the pay link and the mail.
func (s *Service) failWebBatchNoMethod(ctx context.Context, b *store.Batch) (*store.Batch, error) {
	f := stripex.ChargeFailure{Code: "no_payment_method", Message: "no default payment method on file"}
	failed, err := s.recordBatchFailure(ctx, b, f)
	if err != nil || failed.State != store.BatchFailed {
		return failed, err
	}
	if s.payDebtsFromBalance(ctx, b.UID) {
		return s.Store.GetBatch(ctx, b.ID)
	}
	retry, link := s.startWebBatchRetry(ctx, failed, f)
	s.mailWebGroupFailed(ctx, "E2", "E2_"+b.ID, b.UID, retry, link)
	return s.Store.GetBatch(ctx, b.ID)
}

// retryWebBatch is one due retry of a failed web group (settleSweep): the
// account's debt collected under the web's rules; the outcome recorded on
// the group's schedule, the next try or the final mail.
func (s *Service) retryWebBatch(ctx context.Context, b *store.Batch, now time.Time) {
	cust, err := s.Store.GetCustomer(ctx, b.UID)
	if err != nil {
		return
	}
	if cust.AccountDeleted || cust.DeletionPending || cust.UnderReview || cust.Blocked || cust.SheetOnly {
		// Can't be charged off-session now (deletion collects its own dues):
		// the schedule ends; the pay link and Billing still collect it.
		s.updateWebRetry(ctx, b.ID, func(r *store.OffSessionRetry) {
			r.State, r.CloseReason, r.ClosedAt, r.NextAttemptAt = store.RetryCanceled, "account can't be charged", &now, nil
		})
		return
	}
	res, err := s.collectOutstanding(ctx, b.UID, settleWebRetry, payContext{})
	if err != nil || res.Live {
		return // transient, or a payment of it is live: the next sweep looks again
	}
	if res.Paid || res.Nothing {
		s.updateWebRetry(ctx, b.ID, func(r *store.OffSessionRetry) {
			r.Attempts++
			r.ClosePaid(now)
		})
		slog.InfoContext(ctx, "web group paid on retry", "batch_id", b.ID, "uid", b.UID)
		return
	}
	f := stripex.ChargeFailure{Code: "card_declined"}
	if res.Failure != nil {
		f = *res.Failure
	}
	r := s.updateWebRetry(ctx, b.ID, func(r *store.OffSessionRetry) { recordFailure(r, f, now) })
	if r == nil || r.Reason == retryConfig {
		return
	}
	link := s.Cfg.SiteURL + "/billing?pay=1"
	if r.PayRequestID != "" {
		link = s.payURL(r.PayRequestID)
	}
	key := fmt.Sprintf("E3_%s_%d", b.ID, r.Attempts)
	if r.State == store.RetryFinal {
		key = "E3_" + b.ID + "_final"
	}
	s.mailWebGroupFailed(ctx, "E3", key, b.UID, r, link)
}

// updateWebRetry changes a group's schedule; returns it as stored (nil
// when the group has none or couldn't be written).
func (s *Service) updateWebRetry(ctx context.Context, batchID string, mut func(r *store.OffSessionRetry)) *store.OffSessionRetry {
	var out *store.OffSessionRetry
	_, err := s.Store.TransitionBatch(ctx, batchID, []string{store.BatchFailed, store.BatchSettling, store.BatchPaid}, func(bb *store.Batch) error {
		if bb.Retry == nil {
			return nil
		}
		mut(bb.Retry)
		cp := *bb.Retry
		out = &cp
		return nil
	}, nil, nil)
	if err != nil {
		slog.WarnContext(ctx, "web group retry not updated", "batch_id", batchID, "err", err)
		return nil
	}
	return out
}

// mailWebGroupFailed is E2 (first failure) or E3 (a retry failed) for a
// web group: what was declined and why (the mapped sentence), what
// happens next, and the pay link. USD: an off-session charge is never
// presented locally.
func (s *Service) mailWebGroupFailed(ctx context.Context, kind, key, uid string, r *store.OffSessionRetry, link string) {
	owed := s.owedCents(ctx, uid)
	if owed <= 0 {
		return // paid meanwhile
	}
	s.mailCustomer(ctx, key, uid, s.accountEmail(ctx, uid), webGroupFailedMail(kind, money(owed), r.LastErrorMessage, nextOf(r), link))
}

// webRetryJSON is the latest failed web group's schedule for Billing's
// banner (nil when none).
func (s *Service) webRetryJSON(failed []*store.Batch) map[string]any {
	var latest *store.Batch
	for _, b := range failed {
		if b.Retry != nil && (latest == nil || b.CreatedAt.After(latest.CreatedAt)) {
			latest = b
		}
	}
	if latest == nil {
		return nil
	}
	return s.retryJSON(latest.Retry)
}
