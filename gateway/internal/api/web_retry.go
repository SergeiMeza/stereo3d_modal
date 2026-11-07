package api

import (
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Retries of the web's failed off-session charges (D2, owner 2026-11-07):
// soft declines are tried again at +24 h and +72 h after the first
// failure, do_not_honor once, then they stop. Never retried: a bank check
// (authentication_required: the customer confirms on the pay page), hard
// declines, stop codes (fraud, lost or stolen) and configuration errors
// (B2: ours to fix). Each try has its own idempotency key. Every failure
// mail links to the debt's pay page (D7). App charges keep their own
// rules (D1).

// softDeclines are Stripe's decline codes a later try can pass.
var softDeclines = map[string]bool{
	"insufficient_funds": true, "try_again_later": true, "processing_error": true, "issuer_not_available": true,
	"generic_decline": true, "reenter_transaction": true, "approve_with_id": true, "card_velocity_exceeded": true,
	"withdrawal_count_limit_exceeded": true,
}

// Retry reasons.
const (
	retrySoft   = "soft_decline"
	retryAuth   = "authentication_required"
	retryHard   = "hard_decline"
	retryStop   = "stop_code"
	retryConfig = "config"
)

// retryOffsets are the times of the 2nd and 3rd tries after the first
// failure.
var retryOffsets = []time.Duration{24 * time.Hour, 72 * time.Hour}

// declineOf is the decline code a failure stands for ("" when none).
func declineOf(f stripex.ChargeFailure) string {
	switch {
	case f.DeclineCode != "":
		return f.DeclineCode
	case f.Code == "processing_error":
		return "processing_error"
	case f.Code == "card_declined":
		return "generic_decline"
	}
	return ""
}

// retryPolicy is how many tries a failure allows in all, and why.
func retryPolicy(f stripex.ChargeFailure) (maxAttempts int, reason string) {
	dc := declineOf(f)
	switch {
	case f.Config:
		return 1, retryConfig
	case f.NeedsAction || dc == "authentication_required":
		return 1, retryAuth
	case f.Stop:
		return 1, retryStop
	case dc == "do_not_honor":
		return 2, retrySoft
	case softDeclines[dc]:
		return 1 + len(retryOffsets), retrySoft
	}
	return 1, retryHard
}

// customerMessage is the customer-safe sentence for a failure (never
// Stripe's own text).
func customerMessage(f stripex.ChargeFailure) string {
	_, reason := retryPolicy(f)
	switch reason {
	case retryConfig:
		return "We couldn't take this payment because of a problem on our side. We're on it."
	case retryAuth:
		return "Your bank needs you to confirm this payment."
	case retryStop:
		return "Your bank declined the payment."
	}
	switch declineOf(f) {
	case "insufficient_funds":
		return "Your bank declined the payment: not enough funds."
	case "expired_card":
		return "Your payment method has expired."
	case "processing_error", "try_again_later", "issuer_not_available", "reenter_transaction":
		return "Your bank couldn't process the payment just now."
	case "card_velocity_exceeded", "withdrawal_count_limit_exceeded":
		return "Your payment method's limit was reached."
	}
	if f.Code == "no_payment_method" {
		return "There's no payment method saved."
	}
	return "Your bank declined the payment."
}

// startRetry is the schedule after a charge's first failure.
func startRetry(f stripex.ChargeFailure, cents int64, now time.Time) *store.OffSessionRetry {
	r := &store.OffSessionRetry{AmountCents: cents}
	recordFailure(r, f, now)
	return r
}

// recordFailure adds one failed try to r: pending with the next try's
// time, or final. A harder failure only shortens the schedule.
func recordFailure(r *store.OffSessionRetry, f stripex.ChargeFailure, now time.Time) {
	maxA, reason := retryPolicy(f)
	r.Attempts++
	if r.Attempts == 1 {
		r.FirstFailedAt, r.MaxAttempts = now, maxA
	} else {
		r.MaxAttempts = min(r.MaxAttempts, max(r.Attempts, maxA))
	}
	r.Reason, r.LastCode, r.LastDeclineCode, r.LastErrorMessage, r.LastFailedAt = reason, f.Code, declineOf(f), customerMessage(f), now
	if r.Attempts < r.MaxAttempts && r.Attempts-1 < len(retryOffsets) {
		next := r.FirstFailedAt.Add(retryOffsets[r.Attempts-1])
		if next.Before(now) {
			next = now
		}
		r.State, r.NextAttemptAt, r.FinalAt = store.RetryPending, &next, nil
		return
	}
	r.State, r.NextAttemptAt, r.FinalAt = store.RetryFinal, nil, &now
}

// retryJSON is a retry for Billing, the deletion state and admin (the
// contract of 2026-11-07): {state, reason, attempts, max_attempts,
// next_attempt_at, final_at, last_decline_code, last_error_message,
// amount_cents, currency, pay_url}; nil when there is none to show.
func (s *Service) retryJSON(r *store.OffSessionRetry) map[string]any {
	if r == nil || (r.State != store.RetryPending && r.State != store.RetryFinal) {
		return nil
	}
	out := map[string]any{"state": r.State, "reason": r.Reason, "attempts": r.Attempts, "max_attempts": r.MaxAttempts,
		"next_attempt_at": nil, "final_at": nil, "last_decline_code": r.LastDeclineCode, "last_error_message": r.LastErrorMessage,
		"amount_cents": r.AmountCents, "currency": "usd", "pay_url": nil}
	if r.NextAttemptAt != nil {
		out["next_attempt_at"] = r.NextAttemptAt.UTC().Format(time.RFC3339)
	}
	if r.FinalAt != nil {
		out["final_at"] = r.FinalAt.UTC().Format(time.RFC3339)
	}
	if r.PayRequestID != "" {
		out["pay_url"] = s.payURL(r.PayRequestID)
	}
	return out
}

// usdNote is how a mail says what an off-session charge was in: our
// charges are USD whatever the customer saw at Checkout (no FX source we
// trust for an estimate: USD only, owner 2026-11-07).
const usdNote = " (charged in US dollars)"

// retryDay is a retry's date in a mail.
func retryDay(r *store.OffSessionRetry) string {
	if r == nil || r.NextAttemptAt == nil {
		return ""
	}
	return r.NextAttemptAt.UTC().Format("2 January")
}
