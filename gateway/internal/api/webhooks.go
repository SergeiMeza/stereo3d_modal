package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// POST /webhooks/stripe — payment lifecycle drives the state machine.
//
// amount_capturable_updated (hold confirmed) → created→paid → submit to Modal.
// canceled / payment_failed → created→expired.
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

	var pi struct {
		ID       string            `json:"id"`
		Status   string            `json:"status"`
		Metadata map[string]string `json:"metadata"`
	}
	if err := json.Unmarshal(event.Data.Raw, &pi); err != nil {
		httpx.WriteOK(w, map[string]bool{"received": true})
		return
	}
	conversionID := pi.Metadata["conversion_id"]
	if conversionID == "" || pi.Metadata["env"] != s.Cfg.Env {
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

	case "payment_intent.payment_failed":
		// A failed confirmation (card decline) is RETRYABLE — the PI returns
		// to requires_payment_method and the user can try another card in the
		// same sheet. Terminal-izing here would strand a later-authorized
		// hold with no owner. Log only; expiry is createTTL's job.
		log.Info("payment attempt failed (retryable)", "pi_status", pi.Status)

	case "payment_intent.canceled":
		// Stripe-side cancellation is final (our own cancel, or the ~7-day
		// auth lapse). created → never paid; paid → hold gone before the job
		// started. Both end expired; the PI needs no further action.
		now := time.Now().UTC()
		expired, err := s.Store.Transition(ctx, conversionID, []string{store.StateCreated, store.StatePaid}, func(c *store.Conversion) error {
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
