package api

import (
	"context"
	"errors"
	"log/slog"

	"github.com/stripe/stripe-go/v78"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// A web group (charge-after runs of web projects, deferred: off for this
// release) is charged under the web's rules (D1), so it is safe to switch
// on later:
//   - B1: under pmc_web, so a saved Link or PayPal can pay;
//   - B6: the method of the first charge is recorded before it is sent and
//     a re-drive replays exactly that request; a re-drive Stripe refuses
//     as another request under the key (an older group, recorded before
//     this) finds the PaymentIntent the key made instead;
//   - B3/B2: the web cascade — backups even when Stripe refused the
//     default's request (each under its own key), a configuration error
//     alerted and never mailed as "didn't go through" nor soft-retried.
// The app's groups keep chargeBatch's own path, unchanged.

func (s *Service) chargeWebBatch(ctx context.Context, b *store.Batch, cust *store.Customer) (*store.Batch, error) {
	job := stripex.Job{Web: true, BatchID: b.ID, UID: b.UID, Description: batchDescription(b), Metadata: batchMetadata(b),
		ReceiptEmail: cust.Email, PMC: s.Cfg.StripePMCWeb}
	pm := b.ChargePM
	if pm == "" {
		pm = cust.DefaultPaymentMethod
		recorded, err := s.Store.TransitionBatch(ctx, b.ID, []string{store.BatchCharging}, func(bb *store.Batch) error {
			if bb.ChargePM == "" {
				bb.ChargePM = pm
			}
			return nil
		}, nil, nil)
		if err != nil {
			return b, err // nothing sent: the sweep re-drives
		}
		pm = recorded.ChargePM
	}
	pi, chErr := s.Stripe.ChargeSaved(cust.StripeCustomerID, pm, b.TotalCents, b.Currency, job)
	if chErr != nil {
		var serr *stripe.Error
		if errors.As(chErr, &serr) && serr.Type == stripe.ErrorTypeIdempotency {
			// B6: the key's first request differed (a group from before the
			// method was recorded, its default changed since): what did it make?
			found, ferr := s.Stripe.FindBatchCharge(cust.StripeCustomerID, b.ID, b.ClosedAtOr(b.CreatedAt))
			if ferr != nil || found == nil {
				slog.WarnContext(ctx, "web group's earlier charge not found", "batch_id", b.ID, "err", ferr)
				return b, chErr // stays charging; alerted below by the sweep's stuck check
			}
			pi, chErr = found, nil
		}
	}
	if chErr == nil && pi.Status == stripe.PaymentIntentStatusSucceeded {
		if pi.PaymentMethod != nil {
			s.noteMethodPaid(ctx, b.UID, pi.PaymentMethod.ID)
		}
		charged := pi.AmountReceived
		if charged == 0 {
			charged = pi.Amount
		}
		return s.finalizeBatchPaid(ctx, b, pi.ID, charged)
	}
	if chErr == nil && pi.Status == stripe.PaymentIntentStatusProcessing {
		return s.markBatchProcessing(ctx, b, pi.ID)
	}
	var fail stripex.ChargeFailure
	if chErr != nil {
		fail = stripex.ClassifyChargeError(chErr)
	} else {
		fail = stripex.ChargeFailure{PaymentIntentID: pi.ID, Code: string(pi.Status), NeedsAction: pi.Status == stripe.PaymentIntentStatusRequiresAction,
			Message: "payment intent is " + string(pi.Status)}
	}
	slog.ErrorContext(ctx, "web group charge failed", "batch_id", b.ID, "uid", b.UID, "code", fail.Code, "config", fail.Config,
		"transient", fail.Transient, "err", fail.Message)
	if fail.Transient {
		return s.recordBatchFailure(ctx, b, fail)
	}
	if fail.Config {
		s.alertConfigError(ctx, "web group", b.ID, b.UID, fail)
	}
	if fail.PaymentIntentID == "" {
		fail.PaymentIntentID = b.PaymentIntentID
	}
	r := s.webBackups(ctx, cust, fail, func(m string) (*stripe.PaymentIntent, error) {
		return s.Stripe.ChargeBatchWith(cust.StripeCustomerID, m, b.TotalCents, b.Currency, b.ID, "_"+m, job)
	})
	if r.Transient {
		return b, errors.New("web group backup: transient") // the lease lapses; the sweep re-drives under the same keys
	}
	if r.Paid {
		s.noteMethodPaid(ctx, b.UID, r.PaidWith)
		if r.PI.Status == stripe.PaymentIntentStatusProcessing {
			return s.markBatchProcessing(ctx, b, r.PI.ID)
		}
		return s.finalizeBatchPaid(ctx, b, r.PI.ID, r.PI.AmountReceived)
	}
	if r.PIID != "" {
		out, cerr := s.Stripe.ClosePaymentIntent(r.PIID)
		if cerr != nil {
			return b, cerr
		}
		if out.Paid {
			return s.finalizeBatchPaid(ctx, b, out.PaymentIntentID, out.AmountReceived)
		}
		if out.Processing {
			return s.markBatchProcessing(ctx, b, out.PaymentIntentID)
		}
	}
	fail = r.Fail
	fail.PaymentIntentID = r.PIID
	failed, err := s.recordBatchFailure(ctx, b, fail)
	if err != nil {
		return failed, err
	}
	if fail.Stop {
		s.setSheetOnly(ctx, b.UID, "stop code "+fail.DeclineCode)
	}
	if s.payDebtsFromBalance(ctx, b.UID) {
		return s.Store.GetBatch(ctx, b.ID)
	}
	// D2 schedule and D7 pay link; no "didn't go through" for Stripe's own
	// refusal (B2).
	retry, link := s.startWebBatchRetry(ctx, failed, fail)
	if r.CardDecision {
		s.mailWebGroupFailed(ctx, "E2", "E2_"+b.ID, b.UID, retry, link)
	}
	return s.Store.GetBatch(ctx, b.ID)
}
