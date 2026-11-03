package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/stripe/stripe-go/v78"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// POST /webhooks/stripe — payment lifecycle drives the state machine.
//
// Legacy hold mode (mobile PaymentSheet):
//
//	amount_capturable_updated (hold confirmed) → created→paid → submit.
//	canceled → created|paid→expired. payment_failed → log only (retryable).
//
// Pre-charged pro steps (auto_precharge, charged before the run):
//
//	succeeded on a created run (3DS confirmed) → paid → submit.
//
// Auto mode (pay-as-you-go pro steps; the PI exists only after success):
//
//	succeeded → finalize the charge (3DS fallback lands here).
//	payment_failed → charge_failed (delinquent; blocks new paid steps).
//
// Always 200s on events we don't care about; 4xx only on bad signatures so
// Stripe retries real delivery failures but not irrelevant events.
func (s *Service) HandleStripeWebhook(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	payload, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("unreadable payload"))
		return
	}
	event, err := s.Stripe.VerifyWebhook(payload, r.Header.Get("Stripe-Signature"))
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "invalid_signature", "webhook signature verification failed"))
		return
	}

	// P1: route by the event's object type. The account is shared with
	// other products, so anything we don't own answers 200 untouched.
	var head struct {
		Object string `json:"object"`
	}
	if err := json.Unmarshal(event.Data.Raw, &head); err != nil {
		httpx.WriteOK(w, map[string]bool{"received": true})
		return
	}
	switch head.Object {
	case "payment_intent":
		s.handlePaymentIntentEvent(ctx, w, event)
	default:
		// checkout.session, charge, refund, dispute, early fraud warning,
		// payment_method, customer and invoice events get their handlers
		// with the payment layer (spec D5); until then: received.
		httpx.WriteOK(w, map[string]bool{"received": true})
	}
}

// handlePaymentIntentEvent drives the run, group and hold state machines
// from payment_intent.* events. Every change checks that the event's
// PaymentIntent is the record's CURRENT one (P1).
func (s *Service) handlePaymentIntentEvent(ctx context.Context, w http.ResponseWriter, event stripe.Event) {
	var pi struct {
		ID             string            `json:"id"`
		Status         string            `json:"status"`
		Amount         int64             `json:"amount"`
		AmountReceived int64             `json:"amount_received"`
		Metadata       map[string]string `json:"metadata"`
	}
	if err := json.Unmarshal(event.Data.Raw, &pi); err != nil {
		httpx.WriteOK(w, map[string]bool{"received": true})
		return
	}
	if pi.Metadata["env"] != s.Cfg.Env {
		httpx.WriteOK(w, map[string]bool{"received": true}) // not ours
		return
	}
	if batchID := pi.Metadata["batch_id"]; batchID != "" {
		s.handleBatchWebhook(ctx, w, string(event.Type), batchID, pi.ID, pi.Status, pi.AmountReceived)
		return
	}
	conversionID := pi.Metadata["conversion_id"]
	if conversionID == "" {
		httpx.WriteOK(w, map[string]bool{"received": true}) // not ours
		return
	}
	log := httpx.Log(ctx).With("conversion_id", conversionID, "event", string(event.Type))

	switch event.Type {
	case "payment_intent.amount_capturable_updated":
		// Funds held → mark paid, then submit. Two steps so a Modal outage
		// can't lose the payment: paid-with-no-job is re-driven by the
		// reconciler.
		_, err := s.Store.Transition(ctx, conversionID, []string{store.StateCreated}, func(c *store.Conversion) error {
			if c.Stripe.PaymentIntentID != pi.ID {
				return store.ErrStateConflict // not the run's current PaymentIntent (P1)
			}
			c.State = store.StatePaid
			c.Stripe.PIStatus = pi.Status
			return nil
		})
		if err != nil && !errors.Is(err, store.ErrStateConflict) {
			log.Error("webhook transition failed", "err", err)
			httpx.WriteErr(ctx, w, httpx.ErrServer()) // 5xx → Stripe retries
			return
		}
		if err == nil {
			log.Info("payment confirmed; submitting")
			if err := s.submitToModal(ctx, conversionID); err != nil {
				log.Warn("submit failed; reconciler will retry", "err", err)
			}
		}

	case "payment_intent.succeeded":
		// Pre-charged run whose up-front charge needed 3DS: the client
		// confirmed it, so the run is paid — mark it, then submit.
		now := time.Now().UTC()
		_, perr := s.Store.Transition(ctx, conversionID, []string{store.StateCreated}, func(c *store.Conversion) error {
			if c.Stripe.Mode != store.BillingModeAutoPrecharge || !currentPI(c, pi.ID) {
				return store.ErrStateConflict
			}
			c.State = store.StatePaid
			c.Stripe.PaymentIntentID = pi.ID
			c.Stripe.PIStatus = store.PISucceeded
			c.Stripe.CapturedCents = pi.AmountReceived
			c.Stripe.CapturedAt = &now
			c.Stripe.ClientSecret = ""
			return nil
		})
		if perr == nil {
			log.Info("precharge confirmed; submitting", "amount_cents", pi.AmountReceived)
			if err := s.submitToModal(ctx, conversionID); err != nil {
				log.Warn("submit failed; reconciler will retry", "err", err)
			}
			break
		} else if !errors.Is(perr, store.ErrStateConflict) && !errors.Is(perr, store.ErrNotFound) {
			log.Error("webhook precharge transition failed", "err", perr)
			httpx.WriteErr(ctx, w, httpx.ErrServer()) // 5xx → Stripe retries
			return
		}
		// Auto mode: the charge landed — possibly via the web 3DS fallback
		// (confirmCardPayment), which settles outside chargeConversion. Fold
		// the money in and clear the settle error; hold-mode captures already
		// record this in captureHold (their transition conflicts here on
		// pi_status and no-ops).
		var fromProcessing bool
		_, err := s.Store.Transition(ctx, conversionID, []string{store.StateSucceeded}, func(c *store.Conversion) error {
			if c.Stripe.Mode != store.BillingModeAuto || c.Stripe.PIStatus == store.PISucceeded || !currentPI(c, pi.ID) {
				return store.ErrStateConflict // legacy capture, already folded, or not current
			}
			fromProcessing = c.Stripe.PIStatus == store.PIProcessing
			c.Stripe.PaymentIntentID = pi.ID
			c.Stripe.PIStatus = store.PISucceeded
			c.Stripe.CapturedCents = pi.AmountReceived
			c.Stripe.CapturedAt = &now
			c.Stripe.SettleError = ""
			return nil
		})
		if err == nil {
			log.Info("charge settled via webhook", "amount_cents", pi.AmountReceived)
			if fromProcessing {
				if c, gerr := s.Store.GetConversion(ctx, conversionID); gerr == nil {
					s.creditLifetime(ctx, c.UID, pi.AmountReceived) // P2: credited only now
				}
			}
		} else if !errors.Is(err, store.ErrStateConflict) && !errors.Is(err, store.ErrNotFound) {
			log.Error("webhook charge settle failed", "err", err)
			httpx.WriteErr(ctx, w, httpx.ErrServer()) // 5xx → Stripe retries
			return
		}

	case "payment_intent.payment_failed":
		// Hold mode: a failed confirmation (card decline) is RETRYABLE — the
		// PI returns to requires_payment_method and the user can try another
		// card in the same sheet; terminal-izing here would strand a
		// later-authorized hold. Log only; expiry is createTTL's job.
		// Auto mode: the off-session (or 3DS-fallback) charge attempt died —
		// commit charge_failed so the account reads delinquent.
		_, err := s.Store.Transition(ctx, conversionID, []string{store.StateSucceeded}, func(c *store.Conversion) error {
			if c.Stripe.Mode != store.BillingModeAuto || !currentPI(c, pi.ID) ||
				(c.Stripe.PIStatus != store.PIChargePending && c.Stripe.PIStatus != store.PIChargeFailed &&
					c.Stripe.PIStatus != store.PIProcessing) {
				return store.ErrStateConflict
			}
			c.Stripe.PaymentIntentID = pi.ID
			c.Stripe.PIStatus = store.PIChargeFailed
			if c.Stripe.SettleError == "" {
				c.Stripe.SettleError = "charge: payment_failed webhook (pi " + pi.Status + ")"
			}
			return nil
		})
		if err == nil {
			log.Info("charge attempt failed (webhook); account delinquent", "pi_status", pi.Status)
			break
		}
		// A pre-charge whose async payment failed (P2): never paid, the run
		// ends not charged. A failed bank check stays retryable.
		now := time.Now().UTC()
		expired, perr := s.Store.Transition(ctx, conversionID, []string{store.StateCreated}, func(c *store.Conversion) error {
			if c.Stripe.Mode != store.BillingModeAutoPrecharge || c.Stripe.PIStatus != store.PIProcessing || c.Stripe.PaymentIntentID != pi.ID {
				return store.ErrStateConflict
			}
			c.State = store.StateExpired
			c.Stripe.PIStatus = store.PICanceled
			c.Stripe.CanceledAt = &now
			c.Stripe.SettleError = "async payment failed"
			return nil
		})
		if perr == nil {
			log.Info("async pre-charge failed; run not charged")
			s.restoreCredit(ctx, expired)
			break
		}
		log.Info("payment attempt failed (retryable)", "pi_status", pi.Status)

	case "payment_intent.processing":
		// P2: accepted, not settled. Waiting for payment — no submit,
		// credit or tier change until payment_intent.succeeded.
		_, err := s.Store.Transition(ctx, conversionID, []string{store.StateCreated, store.StateSucceeded}, func(c *store.Conversion) error {
			if !currentPI(c, pi.ID) {
				return store.ErrStateConflict
			}
			switch {
			case c.State == store.StateCreated && c.Stripe.Mode == store.BillingModeAutoPrecharge &&
				(c.Stripe.PIStatus == store.PICharging || c.Stripe.PIStatus == store.PIRequiresAction):
			case c.State == store.StateSucceeded && c.Stripe.Mode == store.BillingModeAuto && c.Stripe.PIStatus == store.PIChargePending:
			default:
				return store.ErrStateConflict
			}
			c.Stripe.PaymentIntentID = pi.ID
			c.Stripe.PIStatus = store.PIProcessing
			return nil
		})
		if err == nil {
			log.Info("payment processing; waiting for it to settle")
		}

	case "payment_intent.canceled":
		// Stripe-side cancellation is final (our own cancel, or the ~7-day
		// auth lapse). created → never paid; paid → hold gone before the job
		// started. Both end expired; the PI needs no further action.
		now := time.Now().UTC()
		expired, err := s.Store.Transition(ctx, conversionID, []string{store.StateCreated, store.StatePaid}, func(c *store.Conversion) error {
			// P1: only the run's CURRENT PaymentIntent, and not one the
			// gateway canceled itself (its own flow already moved the run).
			if c.Stripe.PaymentIntentID != pi.ID || c.Stripe.PIStatus == store.PICancelPending ||
				c.Stripe.PIStatus == store.PICanceled {
				return store.ErrStateConflict
			}
			c.State = store.StateExpired
			c.Stripe.PIStatus = store.PICanceled
			c.Stripe.CanceledAt = &now
			return nil
		})
		if err == nil {
			log.Info("payment intent canceled; conversion expired")
			s.restoreCredit(ctx, expired)
		}
	}
	httpx.WriteOK(w, map[string]bool{"received": true})
}

// handleBatchWebhook: a batch PaymentIntent settled outside chargeBatch (the
// web 3DS fallback confirms it on-session) or died after a retry.
func (s *Service) handleBatchWebhook(ctx context.Context, w http.ResponseWriter, eventType, batchID, piID, piStatus string, amountReceived int64) {
	log := httpx.Log(ctx).With("batch_id", batchID, "event", eventType)
	b, err := s.Store.GetBatch(ctx, batchID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.WriteOK(w, map[string]bool{"received": true})
		return
	}
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer()) // 5xx → Stripe retries
		return
	}
	switch eventType {
	case "payment_intent.succeeded":
		if b.State == store.BatchPaid {
			break
		}
		if b.PaymentIntentID != "" && b.PaymentIntentID != piID {
			log.Error("succeeded on a PaymentIntent that isn't the group's current one", "payment_intent", piID)
			s.Slack.SettleFailed(ctx, b.ID, b.UID, "late_payment", errors.New("extra PaymentIntent "+piID+" succeeded"))
			break
		}
		if _, err := s.finalizeBatchPaid(ctx, b, piID, amountReceived); err != nil {
			log.Error("webhook batch settle failed", "err", err)
			httpx.WriteErr(ctx, w, httpx.ErrServer())
			return
		}
		log.Info("batch charge settled via webhook", "amount_cents", amountReceived)
	case "payment_intent.processing":
		if b.State == store.BatchCharging && (b.PaymentIntentID == "" || b.PaymentIntentID == piID) {
			if _, err := s.markBatchProcessing(ctx, b, piID); err != nil {
				httpx.WriteErr(ctx, w, httpx.ErrServer())
				return
			}
		}
	case "payment_intent.payment_failed":
		// The gateway writes a group's failure itself from its own charge
		// call (E0-4); the webhook only ends an ASYNC payment that failed
		// after processing (P2), on the group's current PaymentIntent.
		if b.State != store.BatchCharging || b.PIStatus != store.PIProcessing || b.PaymentIntentID != piID {
			log.Info("batch payment_failed noted (gateway records failures)")
			break
		}
		if _, err := s.recordBatchFailure(ctx, b, stripex.ChargeFailure{
			PaymentIntentID: piID, Code: "payment_failed",
			Message: "payment_failed webhook (pi " + piStatus + ")",
		}); err != nil && !errors.Is(err, store.ErrStateConflict) {
			log.Error("webhook batch failure record failed", "err", err)
			httpx.WriteErr(ctx, w, httpx.ErrServer())
			return
		}
		log.Info("batch charge failed (webhook); account delinquent")
	}
	httpx.WriteOK(w, map[string]bool{"received": true})
}

// currentPI: the event's PaymentIntent is the record's current one — or
// the record has none yet because its own request died between Stripe and
// the write (a pre-charge still "charging", P8a), which the deterministic
// key makes the same one.
func currentPI(c *store.Conversion, piID string) bool {
	return c.Stripe.PaymentIntentID == piID ||
		(c.Stripe.PaymentIntentID == "" && (c.Stripe.PIStatus == store.PICharging || c.Stripe.PIStatus == store.PIChargePending))
}
