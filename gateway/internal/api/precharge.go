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
	user *AuthedUser, cust *store.Customer, conv *store.Conversion, restore func(), pc payContext) {
	// N6: the month's spend limit, whatever pays.
	if err := s.spendLimitError(ctx, user.UID, conv.Quote.AmountCents); err != nil {
		restore()
		httpx.WriteErr(ctx, w, err)
		return
	}
	// N5: paid from the balance when it covers the quote (or a reload
	// will); a lost race falls through to the v6.2 flows.
	if plan := s.planBalance(ctx, user.UID, cust, conv.Quote.AmountCents); plan.Use {
		if s.startBalanceRun(ctx, w, user, cust, conv, plan, restore) {
			return
		}
	}
	flow, reason := decideFlow(cust, conv.Quote.AmountCents, s.Pricing.Rates(ctx).PrechargeThreshold(), pc.China)
	conv.PaymentFlow, conv.PayReason = flow, reason
	if flow == store.FlowPayNow || flow == store.FlowChina {
		s.startPayNowRun(ctx, w, user, cust, conv, restore, pc)
		return
	}
	if flow == store.FlowAfter {
		// Credit, at or under the threshold (C1): enters at "paid",
		// charged with the group on success.
		conv.State = store.StatePaid
		conv.Stripe = store.Stripe{CustomerID: cust.StripeCustomerID, Mode: store.BillingModeAuto}
		s.createAndSubmit(ctx, w, user, conv, restore)
		return
	}
	// P8a, record before money: the run is written at "created" with
	// pi_status charging, THEN Stripe is called with the run's
	// deterministic key. A request that dies in between leaves a record
	// the reconciler re-drives (redrivePrecharges) by replaying that key.
	conv.State = store.StateCreated
	conv.Stripe = store.Stripe{CustomerID: cust.StripeCustomerID, Mode: store.BillingModeAutoPrecharge,
		PIStatus: store.PICharging, ChargePM: cust.DefaultPaymentMethod, ChargeEmail: user.Email}
	if cust.LastGoodMethod != "" && cust.LastGoodMethod != cust.DefaultPaymentMethod {
		conv.Stripe.ChargePM2 = cust.LastGoodMethod // C1's second try
	}
	conv.PaymentFlow = store.FlowPrecharge
	if err := s.Store.CreateConversion(ctx, conv); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			s.replayConversion(ctx, w, user, conv.ID) // the same Idempotency-Key raced (P3)
			return
		}
		restore()
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.Log(ctx).Info("conversion created (pre-charge)",
		"conversion_id", conv.ID, "uid", user.UID, "step", conv.Step, "method", conv.Method,
		"project_id", conv.ProjectID, "amount_cents", conv.Quote.AmountCents)
	updated, cerr := s.runPrecharge(ctx, conv)
	if cerr != nil {
		var apiErr *httpx.APIError
		if errors.As(cerr, &apiErr) {
			httpx.WriteErr(ctx, w, apiErr)
			return
		}
		// Transient: the record stays charging and the reconciler replays
		// the key; the client sees the run waiting for its payment.
		httpx.Log(ctx).Warn("precharge left charging for the reconciler", "conversion_id", conv.ID, "err", cerr)
		if fresh, gerr := s.Store.GetConversion(ctx, conv.ID); gerr == nil {
			updated = fresh
		} else {
			updated = conv
		}
	}
	if updated.State == store.StateCreated && updated.PaymentFlow == store.FlowPayNow && updated.CurrentPayment == nil {
		// P3: the pre-charge needs the sheet for this run — open it now.
		if opened, oerr := s.openRunSession(ctx, updated, "elements", pc.Device, pc.IP, user.Email); oerr == nil || errors.Is(oerr, errAlreadyPaid) {
			updated = opened
		} else {
			httpx.Log(ctx).Warn("P3 session not opened; pay-now opens it", "conversion_id", updated.ID, "err", oerr)
		}
	}
	if updated.State == store.StatePaid {
		s.paidAtStart(ctx, updated) // E1 before it is queued
		if serr := s.submitInline(ctx, updated.ID); serr != nil {
			var rej *submitRejected
			if errors.As(serr, &rej) {
				e := httpx.Err(http.StatusBadRequest, rej.Code, rej.Message)
				e.Details = map[string]any{"conversion_id": updated.ID}
				httpx.WriteErr(ctx, w, e)
				return
			}
			httpx.Log(ctx).Warn("inline submit failed; reconciler will retry", "conversion_id", updated.ID, "err", serr)
		} else if fresh, gerr := s.Store.GetConversion(ctx, updated.ID); gerr == nil {
			updated = fresh
		}
	}
	httpx.WriteOK(w, s.conversionResponse(updated, nil))
}

// runPrecharge makes (or replays) a recorded run's pre-charge (C1) and
// commits the outcome on the record, which must be "created" with
// pi_status charging. One PaymentIntent, at most two tries: the default,
// then — if it declined, it wasn't a stop code, a different last good
// method exists and try 1 took under 25 s — that method, re-confirming the
// same PaymentIntent with no network retry (V6). Outcomes:
//   - succeeded → paid (the caller submits); the method that paid becomes
//     the last good one;
//   - processing → stays created, pi_status processing (P2);
//   - the bank's check, or both declined → the PaymentIntent is cancelled
//     and the run waits in the sheet for THIS run only (P3: flow paynow,
//     pay_reason authentication|declined); the account is unchanged;
//   - a stop code → the same, and the account becomes sheet_only;
//   - try 1 too slow for a try 2, or transient → an error, the record
//     still charging: the reconciler replays both keys.
func (s *Service) runPrecharge(ctx context.Context, conv *store.Conversion) (*store.Conversion, error) {
	start := time.Now()
	pi, err := s.Stripe.PrechargeSaved(conv.Stripe.CustomerID, conv.Stripe.ChargePM,
		conv.Quote.AmountCents, conv.Quote.Currency, stripex.Job{
			Web:          true,
			ConversionID: conv.ID,
			UID:          conv.UID,
			Description:  jobDescription(conv),
			// from the record alone: a replay must send the same request
			Metadata:     jobMetadataFromConversion(conv),
			ReceiptEmail: conv.Stripe.ChargeEmail,
		})
	paidWith := conv.Stripe.ChargePM
	if err != nil {
		fail := stripex.ClassifyChargeError(err)
		if fail.Transient {
			return nil, err
		}
		second := conv.Stripe.ChargePM2
		if !fail.NeedsAction && !fail.Stop && fail.PaymentIntentID != "" && second != "" && second != conv.Stripe.ChargePM {
			if time.Since(start) >= secondTryTimeout {
				return nil, errors.New("pre-charge try 2 deferred to the reconciler (try 1 was slow)")
			}
			pi, err = s.Stripe.ConfirmWithMethod(fail.PaymentIntentID, second, 1, true)
			paidWith = second
			if err != nil {
				fail2 := stripex.ClassifyChargeError(err)
				if fail2.Transient {
					return nil, err
				}
				if fail2.PaymentIntentID == "" {
					fail2.PaymentIntentID = fail.PaymentIntentID
				}
				fail = fail2
			}
		}
		if err != nil {
			return s.prechargeToSheet(ctx, conv, fail)
		}
	}
	commit := s.prechargeCommit(ctx, conv)
	switch pi.Status {
	case stripe.PaymentIntentStatusSucceeded:
		now := time.Now().UTC()
		updated, cerr := commit(func(c *store.Conversion) {
			c.State = store.StatePaid
			c.Stripe.PaymentIntentID = pi.ID
			c.Stripe.PIStatus = store.PISucceeded
			c.Stripe.CapturedCents = pi.AmountReceived
			c.Stripe.CapturedAt = &now
			c.CurrentPayment = &store.Payment{Kind: store.PaymentIntentKind, ID: pi.ID, CreatedAt: now}
		})
		if cerr == nil && updated != nil && updated.State == store.StatePaid {
			s.noteMethodPaid(ctx, conv.UID, paidWith)
		}
		return updated, cerr
	case stripe.PaymentIntentStatusProcessing:
		return commit(func(c *store.Conversion) {
			c.Stripe.PaymentIntentID = pi.ID
			c.Stripe.PIStatus = store.PIProcessing
			c.CurrentPayment = &store.Payment{Kind: store.PaymentIntentKind, ID: pi.ID, CreatedAt: time.Now().UTC()}
		})
	}
	// requires_action (or confirmation) without an error: the bank's check.
	return s.prechargeToSheet(ctx, conv, stripex.ChargeFailure{
		PaymentIntentID: pi.ID, Code: string(pi.Status), NeedsAction: true,
		Message: "payment intent is " + string(pi.Status),
	})
}

// prechargeCommit returns a committer for a charging pre-charge record.
func (s *Service) prechargeCommit(ctx context.Context, conv *store.Conversion) func(mutate func(c *store.Conversion)) (*store.Conversion, error) {
	return func(mutate func(c *store.Conversion)) (*store.Conversion, error) {
		updated, terr := s.Store.Transition(ctx, conv.ID, []string{store.StateCreated}, func(c *store.Conversion) error {
			if err := stillPI(c, store.PICharging); err != nil {
				return err
			}
			mutate(c)
			return nil
		})
		if errors.Is(terr, store.ErrStateConflict) {
			return s.Store.GetConversion(ctx, conv.ID) // a webhook or another sweep got there first
		}
		return updated, terr
	}
}

// prechargeToSheet ends a pre-charge that didn't go through: its
// PaymentIntent is cancelled FIRST (a cancel that finds it succeeded means
// it paid after all), then the run waits in the sheet for this run only
// (P3) with the run clock of a run without an object. A stop code also
// sets the account sheet_only.
func (s *Service) prechargeToSheet(ctx context.Context, conv *store.Conversion, fail stripex.ChargeFailure) (*store.Conversion, error) {
	if fail.PaymentIntentID != "" {
		out, cerr := s.Stripe.ClosePaymentIntent(fail.PaymentIntentID)
		if cerr != nil {
			return nil, cerr // can't be sure it's dead: stay charging, the reconciler retries
		}
		if out.Paid || out.Processing {
			now := time.Now().UTC()
			return s.prechargeCommit(ctx, conv)(func(c *store.Conversion) {
				c.Stripe.PaymentIntentID = out.PaymentIntentID
				c.CurrentPayment = &store.Payment{Kind: store.PaymentIntentKind, ID: out.PaymentIntentID, CreatedAt: now}
				if out.Processing {
					c.Stripe.PIStatus = store.PIProcessing
					return
				}
				c.State = store.StatePaid
				c.Stripe.PIStatus = store.PISucceeded
				c.Stripe.CapturedCents = out.AmountReceived
				c.Stripe.CapturedAt = &now
			})
		}
	}
	reason := "declined"
	if fail.NeedsAction {
		reason = "authentication"
	}
	declined := ""
	if reason == "declined" {
		if cust, cerr := s.Store.GetCustomer(ctx, conv.UID); cerr == nil && cust.DefaultPaymentMethod == conv.Stripe.ChargePM {
			declined = methodLabel(&stripex.CardInfo{Type: cust.DefaultMethodType, Wallet: cust.DefaultMethodWallet,
				Brand: cust.CardBrand, Last4: cust.CardLast4, Email: cust.DefaultMethodEmail})
		}
	}
	if fail.Stop {
		s.setSheetOnly(ctx, conv.UID, "stop code "+fail.DeclineCode)
	}
	now := time.Now().UTC()
	expiry := now.Add(noObjectHold)
	updated, err := s.prechargeCommit(ctx, conv)(func(c *store.Conversion) {
		c.PaymentFlow, c.PayReason, c.DeclinedMethodLabel = store.FlowPayNow, reason, declined
		c.Stripe.PIStatus = ""
		c.Stripe.ClientSecret = ""
		c.Stripe.SettleError = fmt.Sprintf("precharge %s: %s %s", reason, fail.Code, fail.DeclineCode)
		if fail.PaymentIntentID != "" {
			c.Payments = append(c.Payments, store.Payment{Kind: store.PaymentIntentKind, ID: fail.PaymentIntentID, CreatedAt: now})
		}
		c.CurrentPayment = nil
		c.ExpiresAt = &expiry
	})
	slog.InfoContext(ctx, "precharge needs the sheet", "conversion_id", conv.ID, "uid", conv.UID,
		"reason", reason, "code", fail.Code, "decline_code", fail.DeclineCode, "stop", fail.Stop)
	return updated, err
}

// redrivePrecharges replays pre-charges whose request died between the
// record and Stripe's answer (pi_status charging for over a minute): the
// deterministic key returns the first attempt's outcome, never a second
// charge. Called by the reconciler.
func (s *Service) redrivePrecharges(ctx context.Context) int {
	stuck, err := s.Store.ListByPIStatus(ctx, store.PICharging, 50)
	if err != nil {
		return 0
	}
	n := 0
	for _, c := range stuck {
		if c.State != store.StateCreated || time.Since(c.UpdatedAt) < time.Minute {
			continue
		}
		updated, rerr := s.runPrecharge(ctx, c)
		var apiErr *httpx.APIError
		if rerr != nil && !errors.As(rerr, &apiErr) {
			slog.WarnContext(ctx, "precharge re-drive failed", "conversion_id", c.ID, "err", rerr)
			continue
		}
		n++
		if updated != nil && updated.State == store.StatePaid {
			s.paidAtStart(ctx, updated)
			if serr := s.submitToModal(ctx, updated.ID); serr != nil {
				slog.WarnContext(ctx, "submit after precharge re-drive failed", "conversion_id", c.ID, "err", serr)
			}
		}
	}
	return n
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
		renamed.Message = "a payment failed — update your payment method so it can be retried before starting new work"
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
	case store.PICharging, store.PIProcessing:
		return "processing" // being taken, or an async payment settling (P2)
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
	case c.State == store.StateCreated && (c.Stripe.PIStatus == store.PICharging || c.Stripe.PIStatus == store.PIProcessing):
		return map[string]any{"status": "waiting_for_payment"}
	case c.State == store.StateExpired:
		return map[string]any{"status": "not_charged"}
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

// sweepProcessing reads the PaymentIntents of runs waiting for an async
// payment (pi_status processing, P2) and applies Stripe's answer: settled
// → paid (a pre-charge then submits) or charged (after-done); failed →
// a pre-charge ends not charged, an after-done charge fails as any
// decline. Still processing → untouched. The webhook usually gets there
// first; this covers a lost event.
func (s *Service) sweepProcessing(ctx context.Context) int {
	runs, err := s.Store.ListByPIStatus(ctx, store.PIProcessing, 50)
	if err != nil {
		return 0
	}
	n := 0
	for _, c := range runs {
		if c.Stripe.PaymentIntentID == "" || time.Since(c.UpdatedAt) < 2*time.Minute {
			continue
		}
		pi, gerr := s.Stripe.GetPaymentIntent(c.Stripe.PaymentIntentID)
		if gerr != nil || pi.Status == stripe.PaymentIntentStatusProcessing {
			continue
		}
		now := time.Now().UTC()
		settled := pi.Status == stripe.PaymentIntentStatusSucceeded
		updated, terr := s.Store.Transition(ctx, c.ID, []string{c.State}, func(cc *store.Conversion) error {
			if err := stillPI(cc, store.PIProcessing); err != nil {
				return err
			}
			switch {
			case settled && cc.State == store.StateCreated:
				cc.State = store.StatePaid
				cc.Stripe.PIStatus = store.PISucceeded
				cc.Stripe.CapturedCents = pi.AmountReceived
				cc.Stripe.CapturedAt = &now
				cc.Stripe.ClientSecret = ""
			case settled:
				cc.Stripe.PIStatus = store.PISucceeded
				cc.Stripe.CapturedCents = pi.AmountReceived
				cc.Stripe.CapturedAt = &now
				cc.Stripe.SettleError = ""
			case cc.State == store.StateCreated:
				cc.State = store.StateExpired
				cc.Stripe.PIStatus = store.PICanceled
				cc.Stripe.CanceledAt = &now
				cc.Stripe.SettleError = "async payment ended " + string(pi.Status)
			default:
				cc.Stripe.PIStatus = store.PIChargeFailed
				cc.Stripe.SettleError = "charge: async payment ended " + string(pi.Status)
			}
			return nil
		})
		if terr != nil {
			continue
		}
		n++
		switch {
		case settled && updated.State == store.StatePaid:
			s.paidAtStart(ctx, updated)
			if serr := s.submitToModal(ctx, updated.ID); serr != nil {
				slog.WarnContext(ctx, "submit after async payment failed", "conversion_id", updated.ID, "err", serr)
			}
		case settled:
			s.creditLifetime(ctx, updated.UID, pi.AmountReceived)
			s.recordRunCharge(ctx, updated)
		case updated.State == store.StateExpired:
			s.restoreCredit(ctx, updated)
		default:
			s.Slack.SettleFailed(ctx, updated.ID, updated.UID, "charge", errors.New(updated.Stripe.SettleError))
		}
	}
	return n
}

// payContext is what the request says about where the customer pays:
// China mode, the device (B16) and the IP (tax evidence).
type payContext struct {
	China  bool
	Device string
	IP     string
}

func payContextOf(r *http.Request) payContext {
	return payContext{China: chinaMode(r), Device: clientDevice(r), IP: clientIP(r)}
}

// startPayNowRun records a run that pays before it starts (C1 paynow /
// china, C4) and opens its sheet: a Checkout Session in elements mode.
// China runs wait for pay-now {method} (server-side Alipay / WeChat Pay).
// The run's clock follows its payment (E0-3).
func (s *Service) startPayNowRun(ctx context.Context, w http.ResponseWriter, user *AuthedUser,
	cust *store.Customer, conv *store.Conversion, restore func(), pc payContext) {
	now := time.Now().UTC()
	expiry := now.Add(noObjectHold)
	conv.State = store.StateCreated
	conv.Stripe = store.Stripe{CustomerID: cust.StripeCustomerID, Mode: store.BillingModeAutoPrecharge}
	conv.ExpiresAt = &expiry
	if err := s.Store.CreateConversion(ctx, conv); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			s.replayConversion(ctx, w, user, conv.ID)
			return
		}
		restore()
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.Log(ctx).Info("conversion created (pay first)", "conversion_id", conv.ID, "uid", user.UID,
		"flow", conv.PaymentFlow, "reason", conv.PayReason, "amount_cents", conv.Quote.AmountCents)
	if conv.PaymentFlow == store.FlowChina {
		httpx.WriteOK(w, s.payNowResponse(conv))
		return
	}
	updated, err := s.openRunSession(ctx, conv, "elements", pc.Device, pc.IP, user.Email)
	if err != nil && !errors.Is(err, errAlreadyPaid) {
		// The run waits; pay-now opens the sheet on the next tap.
		httpx.Log(ctx).Warn("sheet not opened at create", "conversion_id", conv.ID, "err", err)
		updated = conv
	}
	httpx.WriteOK(w, s.payNowResponse(updated))
}
