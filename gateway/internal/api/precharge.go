package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/stripe/stripe-go/v78"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Pre-charged pro steps (owner decision LL-D8, 2026-11-03, both methods):
// a run quoted above rates.precharge_threshold_cents ($25) is CHARGED on
// the saved card before it is submitted and refunded in full if it fails or
// is canceled; smaller runs start at once and join the batch on success, as
// before. This replaces the off-session hold for pro steps (a hold lapses
// after 7 days, and Lifelike runs have no length limit); the mobile
// one-shot flow keeps its hold (finalizeAutoBilled).
//
// Money invariant, as everywhere: a failed or canceled pre-charged run is
// committed with pi_status cancel_pending first, and releaseHold →
// refundPrecharge gives the money back after; the reconciler's cancel sweep
// retries until Stripe answers.

// finalizeStepBilled bills a pro step at creation and writes + submits it.
// Writes the HTTP response on every path; restore gives back the analyze
// credit on failure.
func (s *Service) finalizeStepBilled(ctx context.Context, w http.ResponseWriter,
	user *AuthedUser, cust *store.Customer, conv *store.Conversion, restore func()) {
	if chargeTiming(s.Pricing.Rates(ctx), conv.Quote.AmountCents) != "before" {
		// Enters at "paid": billing verified, charged with the batch on
		// success.
		conv.State = store.StatePaid
		conv.Stripe = store.Stripe{CustomerID: cust.StripeCustomerID, Mode: store.BillingModeAuto}
		s.createAndSubmit(ctx, w, user, conv, restore)
		return
	}
	conv.Stripe = store.Stripe{CustomerID: cust.StripeCustomerID, Mode: store.BillingModeAutoPrecharge}
	pi, err := s.Stripe.PrechargeSaved(cust.StripeCustomerID, cust.DefaultPaymentMethod,
		conv.Quote.AmountCents, conv.Quote.Currency, stripex.Job{
			ConversionID: conv.ID,
			UID:          user.UID,
			Description:  jobDescription(conv),
			Metadata:     s.jobMetadata(ctx, conv),
			ReceiptEmail: user.Email,
		})
	if err != nil {
		fail := stripex.ClassifyChargeError(err)
		if fail.NeedsAction && fail.PaymentIntentID != "" {
			// Bank wants 3DS: park at "created" with the PI; the client
			// confirms with the saved card and the succeeded webhook moves
			// the run to paid and submits it.
			conv.State = store.StateCreated
			conv.Stripe.PaymentIntentID = fail.PaymentIntentID
			if got, gerr := s.Stripe.GetPaymentIntent(fail.PaymentIntentID); gerr == nil {
				conv.Stripe.ClientSecret = got.ClientSecret
			}
			s.createAndSubmit(ctx, w, user, conv, func() {
				_ = s.Stripe.CancelHold(fail.PaymentIntentID)
				restore()
			})
			return
		}
		restore()
		if fail.Transient {
			httpx.Log(ctx).Error("stripe precharge failed", "conversion_id", conv.ID, "err", err)
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error",
				"could not take the payment; try again"))
			return
		}
		httpx.Log(ctx).Info("precharge declined", "conversion_id", conv.ID, "uid", user.UID, "code", fail.Code)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusPaymentRequired, "card_declined",
			"your card declined the payment — update your payment method and retry"))
		return
	}
	conv.Stripe.PaymentIntentID = pi.ID
	switch pi.Status {
	case stripe.PaymentIntentStatusSucceeded, stripe.PaymentIntentStatusProcessing:
		now := time.Now().UTC()
		conv.State = store.StatePaid
		conv.Stripe.PIStatus = store.PISucceeded
		conv.Stripe.CapturedCents = pi.Amount
		conv.Stripe.CapturedAt = &now
	default:
		// requires_action without authentication_required (defensive, as
		// for holds): same 3DS parking.
		conv.State = store.StateCreated
		conv.Stripe.ClientSecret = pi.ClientSecret
	}
	s.createAndSubmit(ctx, w, user, conv, func() {
		// Nothing was submitted: give the money straight back.
		if _, _, rerr := s.Stripe.RefundOrCancel(pi.ID); rerr != nil {
			slog.ErrorContext(ctx, "precharge refund after a failed write", "conversion_id", conv.ID, "err", rerr)
			s.Slack.SettleFailed(ctx, conv.ID, conv.UID, "refund", rerr)
		}
		restore()
	})
}

// refundPrecharge returns a pre-charged run's money once the run is
// committed to a terminal state with pi_status cancel_pending: a refund of
// the settled charge, or a cancel of a PaymentIntent the user never
// confirmed. Transient failures stay cancel_pending for the sweep; a refund
// Stripe refuses becomes refund_failed, flagged once for a manual refund.
func (s *Service) refundPrecharge(ctx context.Context, conv *store.Conversion) (*store.Conversion, error) {
	refunded, refused, rerr := s.Stripe.RefundOrCancel(conv.Stripe.PaymentIntentID)
	now := time.Now().UTC()
	updated, err := s.Store.Transition(ctx, conv.ID, []string{conv.State}, func(c *store.Conversion) error {
		if err := stillPI(c, store.PICancelPending); err != nil {
			return err
		}
		if rerr == nil {
			if refunded > 0 {
				c.Stripe.PIStatus = store.PIRefunded
				c.Stripe.RefundedCents = refunded
				c.Stripe.RefundedAt = &now
			} else {
				c.Stripe.PIStatus = store.PICanceled
				c.Stripe.CanceledAt = &now
			}
			c.Stripe.SettleError = ""
			return nil
		}
		firstFailure := c.Stripe.SettleError == ""
		c.Stripe.SettleError = fmt.Sprintf("refund: %v", rerr)
		if refused {
			c.Stripe.PIStatus = store.PIRefundFailed // needs a manual refund
		}
		if firstFailure || refused {
			s.Slack.SettleFailed(ctx, c.ID, c.UID, "refund", rerr)
		}
		return nil
	})
	if rerr != nil {
		slog.ErrorContext(ctx, "precharge refund failed",
			"conversion_id", conv.ID, "payment_intent", conv.Stripe.PaymentIntentID, "err", rerr)
	} else {
		slog.InfoContext(ctx, "precharge returned",
			"conversion_id", conv.ID, "payment_intent", conv.Stripe.PaymentIntentID, "refunded_cents", refunded)
	}
	s.restoreCredit(ctx, conv)
	if errors.Is(err, store.ErrStateConflict) {
		return s.Store.GetConversion(ctx, conv.ID)
	}
	return updated, err
}

// notChargedPhrase finishes "The conversion failed and …" for the user: a
// pre-charged run's money comes back as a refund; every other run was
// never charged.
func notChargedPhrase(c *store.Conversion) string {
	if c.Stripe.Mode == store.BillingModeAutoPrecharge && c.Stripe.PIStatus != store.PICanceled &&
		c.Stripe.CapturedCents > 0 {
		return "your payment is being refunded in full"
	}
	return "you were not charged"
}

// stepBillingError renames the delinquency 402 for pro steps (S3D-22):
// with a failed charge outstanding, new paid runs answer 402
// payment_method_needed until the card is fixed and the retry (settle /
// pay-now) succeeds; downloads and quotes stay open. The mobile one-shot
// keeps billing_overdue, which its clients route on.
func stepBillingError(err error) error {
	var apiErr *httpx.APIError
	if errors.As(err, &apiErr) && apiErr.Code == "billing_overdue" {
		renamed := *apiErr
		renamed.Code = "payment_method_needed"
		renamed.Message = "a payment failed — update your card so it can be retried before starting new work"
		return &renamed
	}
	return err
}

// paymentStatus is a run's single customer-facing money state (S3D-21:
// balances and batches stay internal): pending (billed later, or its
// grouped charge is still to run), paid, refunded, not_charged, or
// payment_needed (its grouped charge failed, or a pre-charge waits for the
// bank's check).
func paymentStatus(c *store.Conversion) string {
	switch c.Stripe.PIStatus {
	case store.PISucceeded:
		return "paid"
	case store.PIRefunded, store.PIRefundFailed: // refund_failed: support refunds it by hand
		return "refunded"
	case store.PIChargeFailed:
		return "payment_needed"
	case store.PICanceled, store.PICaptureFailed: // capture_failed: our lapsed hold, never taken
		return "not_charged"
	case store.PICancelPending:
		if c.Stripe.Mode == store.BillingModeAutoPrecharge && c.Stripe.CapturedCents > 0 {
			return "refunded" // on its way back
		}
		return "not_charged"
	}
	switch c.State {
	case store.StateCreated:
		if c.Stripe.ClientSecret != "" {
			return "payment_needed"
		}
	case store.StateFailed, store.StateCanceled, store.StateExpired:
		return "not_charged"
	}
	if c.Quote.AmountCents == 0 {
		return "not_charged" // free (daily still, photo credit)
	}
	return "pending" // running, batched, charge or capture to come
}

// serversBusyError is the lifelike3d record's error when a job waited in
// line past its cap (6 h) and never started.
const serversBusyError = "All our servers are busy right now"

// failureCopy is a failed run's error code and user message. Either way
// the money comes back (refund) or was never taken; the copy says which.
func failureCopy(c *store.Conversion, internalErr string) (code, msg string) {
	if strings.Contains(internalErr, serversBusyError) {
		return "servers_busy", "All our servers are busy right now, so this run didn't start and " +
			notChargedPhrase(c) + ". Please try again later. Quote this ID to support: " + c.ID
	}
	return "pipeline_failed", "The conversion failed and " + notChargedPhrase(c) + ". Quote this ID to support: " + c.ID
}

// prechargeBilling is the conversion's billing block for a pre-charged run.
func prechargeBilling(c *store.Conversion) map[string]any {
	switch {
	case c.State == store.StateCreated && c.Stripe.ClientSecret != "":
		return nil // the requires_action block (conversionResponse)
	case !store.IsTerminal(c.State) || c.State == store.StateSucceeded:
		return map[string]any{"status": "charged", "charged_cents": c.Stripe.CapturedCents}
	case c.Stripe.PIStatus == store.PIRefunded:
		return map[string]any{"status": "refunded", "refunded_cents": c.Stripe.RefundedCents}
	case c.Stripe.PIStatus == store.PICanceled || c.Stripe.CapturedCents == 0:
		return map[string]any{"status": "not_charged"}
	}
	// cancel_pending (refund on its way) or refund_failed (support refunds
	// it by hand): either way the user is owed the money back.
	return map[string]any{"status": "refund_pending", "charged_cents": c.Stripe.CapturedCents}
}

// submitRejected: the pipeline refused the run's request outright (400).
// The conversion is already failed with its money on the way back; the
// create request answers 400 with Code/Message instead of the record.
type submitRejected struct {
	Code, Message string
	Conv          *store.Conversion
}

func (e *submitRejected) Error() string { return e.Code + ": " + e.Message }

// rejectSubmit fails a paid run the Lifelike service refused at submit and
// gives its money back (refund or release, like any failure). A preset
// above 4K is the expected case until the service renders 5k/6k/8k
// (S3D-48): the user is told to pick 4K or lower.
func (s *Service) rejectSubmit(ctx context.Context, conv *store.Conversion, up *modalapi.UpstreamError) error {
	code, msg := "submit_rejected", "This run couldn't be started with these settings"
	if h := presetOutputHeight[conv.Params.Preset]; h > presetOutputHeight["4k"] {
		code = "preset_unavailable"
		msg = fmt.Sprintf("%s isn't available yet; choose 4K or lower", strings.ToUpper(conv.Params.Preset))
	}
	now := time.Now().UTC()
	failed, err := s.Store.Transition(ctx, conv.ID, []string{store.StatePaid}, func(c *store.Conversion) error {
		c.State = store.StateFailed
		c.Modal.LastPolledAt = &now
		c.Stripe.PIStatus = store.PICancelPending
		c.Error = &store.Error{
			Code:            code,
			UserMessage:     msg + " — " + notChargedPhrase(c) + ".",
			InternalMessage: fmt.Sprintf("submit rejected (%d): %s", up.StatusCode, up.Body),
		}
		return nil
	})
	if err != nil {
		return err // raced (already submitted or settled): nothing to answer
	}
	s.Slack.ConversionFailed(ctx, conv.ID, conv.UID, "submit", "lifelike refused the submit: "+up.Body)
	if released, rerr := s.releaseHold(ctx, failed); rerr == nil && released != nil {
		failed = released
	}
	return &submitRejected{Code: code, Message: msg, Conv: failed}
}
