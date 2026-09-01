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
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Batched billing — see store.Batch. Charge-on-success conversions no
// longer charge one by one: they append to the account's open batch, which
// becomes ONE off-session charge when its window elapses, its total reaches
// the user's tier cap, or the user pays now. Every path that touches money
// commits its intent in Firestore first (charging / paid / failed) and lets
// the reconciler sweep whatever Stripe call didn't land.

// ensureLifetimeSeeded backfills Customer.LifetimePaidCents from the
// account's historical succeeded charges the first time batching looks at
// it, so users who paid before batching existed start on the right tier.
func (s *Service) ensureLifetimeSeeded(ctx context.Context, uid string, cust *store.Customer) *store.Customer {
	if cust == nil || cust.LifetimePaidSeeded {
		return cust
	}
	paid, err := s.Store.ListUserByPIStatus(ctx, uid, store.PISucceeded, 1000)
	if err != nil {
		slog.WarnContext(ctx, "lifetime seed read failed", "uid", uid, "err", err)
		return cust
	}
	var total int64
	for _, c := range paid {
		total += c.Stripe.CapturedCents
	}
	updated, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.LifetimePaidSeeded {
			return nil
		}
		c.LifetimePaidCents += total
		c.LifetimePaidSeeded = true
		return nil
	})
	if err != nil {
		slog.WarnContext(ctx, "lifetime seed write failed", "uid", uid, "err", err)
		return cust
	}
	return updated
}

// creditLifetime adds collected money to the user's tier counter. Best
// effort: tiering is a convenience, the money already moved.
func (s *Service) creditLifetime(ctx context.Context, uid string, cents int64) {
	if cents <= 0 {
		return
	}
	if _, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		c.LifetimePaidCents += cents
		return nil
	}); err != nil {
		slog.WarnContext(ctx, "lifetime credit failed", "uid", uid, "cents", cents, "err", err)
	}
}

// holdThreshold is the quote at or above which a run gets an up-front hold
// instead of joining the batch: the base threshold, lifted to the user's
// batch cap so a higher tier batches the runs it is trusted for.
func (s *Service) holdThreshold(ctx context.Context, cust *store.Customer) int64 {
	th := int64(holdThresholdCents)
	if cust == nil {
		return th
	}
	if cap := s.Pricing.Rates(ctx).BatchCap(cust.LifetimePaidCents); cap > th {
		th = cap
	}
	return th
}

// settleAutoCharge is the post-success money step for auto-mode
// conversions (pi_status charge_pending): pro steps join the batch; the
// mobile one-shot flow keeps charging per conversion until the mobile
// contract adopts batching (rates.batch_one_shot).
func (s *Service) settleAutoCharge(ctx context.Context, conv *store.Conversion) (*store.Conversion, error) {
	if conv.ProjectID == "" && !s.Pricing.Rates(ctx).BatchOneShot {
		return s.chargeConversion(ctx, conv)
	}
	return s.batchConversion(ctx, conv)
}

// batchConversion appends a succeeded auto-mode conversion to the user's
// open batch and charges the batch right away if the append closed it.
func (s *Service) batchConversion(ctx context.Context, conv *store.Conversion) (*store.Conversion, error) {
	if conv.State != store.StateSucceeded || conv.Stripe.Mode != store.BillingModeAuto ||
		conv.Stripe.PIStatus != store.PIChargePending {
		return conv, nil
	}
	cust, err := s.Store.GetCustomer(ctx, conv.UID)
	if err != nil {
		return conv, err
	}
	cust = s.ensureLifetimeSeeded(ctx, conv.UID, cust)
	rates := s.Pricing.Rates(ctx)
	batch, err := s.Store.BatchConversion(ctx, conv.ID, store.BatchItem{
		ConversionID: conv.ID,
		ProjectID:    conv.ProjectID,
		Step:         conv.Step,
		Kind:         conv.Kind,
		Description:  jobDescription(conv),
		AmountCents:  conv.Quote.AmountCents,
	}, rates.BatchWindow(), rates.BatchCap(cust.LifetimePaidCents))
	if errors.Is(err, store.ErrNotBatchable) || errors.Is(err, store.ErrStateConflict) {
		return s.Store.GetConversion(ctx, conv.ID) // settled concurrently
	}
	if err != nil {
		return conv, err
	}
	slog.InfoContext(ctx, "conversion batched",
		"conversion_id", conv.ID, "uid", conv.UID, "batch_id", batch.ID,
		"batch_total_cents", batch.TotalCents, "batch_cap_cents", batch.CapCents, "batch_state", batch.State)
	if batch.State == store.BatchCharging {
		if _, cerr := s.chargeBatch(ctx, batch); cerr != nil {
			slog.WarnContext(ctx, "batch charge deferred to sweep", "batch_id", batch.ID, "err", cerr)
		}
	}
	return s.Store.GetConversion(ctx, conv.ID)
}

// closeAndCharge closes an open batch for reason and charges it. A
// concurrent close is not an error — the other closer charges.
func (s *Service) closeAndCharge(ctx context.Context, batchID, reason string) (*store.Batch, error) {
	closed, err := s.Store.CloseBatch(ctx, batchID, reason)
	if errors.Is(err, store.ErrStateConflict) {
		return s.Store.GetBatch(ctx, batchID)
	}
	if err != nil {
		return nil, err
	}
	slog.InfoContext(ctx, "batch closed", "batch_id", batchID, "uid", closed.UID,
		"reason", reason, "items", len(closed.Items), "total_cents", closed.TotalCents)
	return s.chargeBatch(ctx, closed)
}

func batchDescription(b *store.Batch) string {
	counts := map[string]int{}
	var order []string
	for _, it := range b.Items {
		if _, seen := counts[it.Description]; !seen {
			order = append(order, it.Description)
		}
		counts[it.Description]++
	}
	parts := make([]string, 0, len(order))
	for _, d := range order {
		if counts[d] > 1 {
			parts = append(parts, fmt.Sprintf("%s ×%d", d, counts[d]))
		} else {
			parts = append(parts, d)
		}
	}
	desc := strings.Join(parts, ", ")
	if len(desc) > 200 {
		desc = desc[:197] + "…"
	}
	return desc
}

func batchMetadata(b *store.Batch) map[string]string {
	ids := make([]string, 0, len(b.Items))
	for _, it := range b.Items {
		ids = append(ids, it.ConversionID)
	}
	joined := strings.Join(ids, ",")
	if len(joined) > 490 { // Stripe metadata values cap at 500 chars
		joined = joined[:490] + "…"
	}
	return map[string]string{
		"conversion_ids": joined,
		"items":          fmt.Sprint(len(b.Items)),
		"close_reason":   b.CloseReason,
	}
}

// chargeBatch collects a closed batch (state=charging): one off-session
// PaymentIntent per batch (idempotent on the batch id; retries Confirm the
// same PI). Success settles every conversion in the batch to succeeded and
// credits the user's lifetime spend; a card decision fails the batch AND
// flips its conversions to charge_failed so the existing delinquency and
// download gates apply unchanged. Transient errors leave it charging for
// the reconciler.
func (s *Service) chargeBatch(ctx context.Context, b *store.Batch) (*store.Batch, error) {
	if b.State != store.BatchCharging {
		return b, nil
	}
	if b.TotalCents <= 0 || len(b.Items) == 0 {
		// Nothing to collect (free items only): settle as paid, no Stripe.
		return s.finalizeBatchPaid(ctx, b, "", 0)
	}
	cust, err := s.Store.GetCustomer(ctx, b.UID)
	if err != nil {
		return b, err
	}
	if cust.DefaultPaymentMethod == "" && cust.StripeCustomerID != "" {
		cust = s.refreshCardCache(ctx, b.UID, cust.StripeCustomerID)
	}

	var pi *stripe.PaymentIntent
	var chErr error
	switch {
	case b.PaymentIntentID != "":
		pi, chErr = s.Stripe.ConfirmSavedCharge(b.PaymentIntentID, cust.DefaultPaymentMethod, cust.Email)
	case cust.DefaultPaymentMethod == "":
		return s.recordBatchFailure(ctx, b, stripex.ChargeFailure{
			Code: "no_payment_method", Message: "no default payment method on file",
		})
	default:
		pi, chErr = s.Stripe.ChargeSaved(cust.StripeCustomerID, cust.DefaultPaymentMethod,
			b.TotalCents, b.Currency, stripex.Job{
				BatchID:      b.ID,
				UID:          b.UID,
				Description:  batchDescription(b),
				Metadata:     batchMetadata(b),
				ReceiptEmail: cust.Email,
			})
	}

	if chErr == nil && (pi.Status == stripe.PaymentIntentStatusSucceeded ||
		pi.Status == stripe.PaymentIntentStatusProcessing) {
		charged := pi.AmountReceived
		if charged == 0 {
			charged = pi.Amount
		}
		return s.finalizeBatchPaid(ctx, b, pi.ID, charged)
	}

	var fail stripex.ChargeFailure
	if chErr != nil {
		fail = stripex.ClassifyChargeError(chErr)
	} else {
		fail = stripex.ChargeFailure{
			PaymentIntentID: pi.ID,
			Code:            string(pi.Status),
			NeedsAction:     pi.Status == stripe.PaymentIntentStatusRequiresAction,
			Message:         "payment intent is " + string(pi.Status),
		}
	}
	slog.ErrorContext(ctx, "stripe batch charge failed",
		"batch_id", b.ID, "uid", b.UID, "code", fail.Code,
		"transient", fail.Transient, "needs_action", fail.NeedsAction, "err", fail.Message)
	return s.recordBatchFailure(ctx, b, fail)
}

// finalizeBatchPaid commits a collected batch: paid, its conversions
// succeeded (each carrying the shared PI and its own share), lifetime
// spend credited. Also the webhook's landing for a 3DS-completed batch PI.
func (s *Service) finalizeBatchPaid(ctx context.Context, b *store.Batch, piID string, charged int64) (*store.Batch, error) {
	now := time.Now().UTC()
	updated, err := s.Store.TransitionBatch(ctx, b.ID, []string{store.BatchCharging, store.BatchFailed},
		func(bb *store.Batch) error {
			bb.State = store.BatchPaid
			if piID != "" {
				bb.PaymentIntentID = piID
			}
			bb.ChargedCents = charged
			bb.ChargedAt = &now
			bb.SettleError = ""
			return nil
		},
		func(c *store.Conversion) error {
			if c.Stripe.BatchID != b.ID {
				return nil
			}
			if piID != "" {
				c.Stripe.PaymentIntentID = piID
			}
			c.Stripe.PIStatus = store.PISucceeded
			c.Stripe.CapturedCents = c.Quote.AmountCents
			c.Stripe.CapturedAt = &now
			c.Stripe.SettleError = ""
			return nil
		},
		func(c *store.Customer) error {
			c.LifetimePaidCents += charged
			return nil
		})
	if errors.Is(err, store.ErrStateConflict) {
		return s.Store.GetBatch(ctx, b.ID)
	}
	if err != nil {
		return nil, err
	}
	slog.InfoContext(ctx, "batch charged", "batch_id", b.ID, "uid", b.UID,
		"payment_intent", piID, "amount_cents", charged, "items", len(b.Items))
	return updated, nil
}

// recordBatchFailure: transient → stay charging (swept); card decision →
// failed + conversions charge_failed (delinquent), Slack-flagged once.
func (s *Service) recordBatchFailure(ctx context.Context, b *store.Batch, fail stripex.ChargeFailure) (*store.Batch, error) {
	firstFailure := b.SettleError == ""
	var convMutate func(c *store.Conversion) error
	if !fail.Transient {
		convMutate = func(c *store.Conversion) error {
			if c.Stripe.BatchID == b.ID && c.Stripe.PIStatus == store.PIBatched {
				c.Stripe.PIStatus = store.PIChargeFailed
				c.Stripe.SettleError = "batch charge: " + fail.Message
			}
			return nil
		}
	}
	updated, err := s.Store.TransitionBatch(ctx, b.ID, []string{store.BatchCharging},
		func(bb *store.Batch) error {
			if fail.PaymentIntentID != "" {
				bb.PaymentIntentID = fail.PaymentIntentID
			}
			bb.SettleError = "charge: " + fail.Message
			if !fail.Transient {
				bb.State = store.BatchFailed
			}
			return nil
		}, convMutate, nil)
	if !fail.Transient && firstFailure {
		s.Slack.BatchChargeFailed(ctx, b.ID, b.UID, len(b.Items), b.TotalCents,
			fmt.Errorf("%s (%s)", fail.Message, fail.Code))
	}
	if errors.Is(err, store.ErrStateConflict) {
		return s.Store.GetBatch(ctx, b.ID)
	}
	return updated, err
}

// rearmBatch moves a failed batch back to charging (settle retry) and its
// conversions back to batched, then charges it.
func (s *Service) rearmBatch(ctx context.Context, b *store.Batch) (*store.Batch, error) {
	armed, err := s.Store.TransitionBatch(ctx, b.ID, []string{store.BatchFailed},
		func(bb *store.Batch) error {
			bb.State = store.BatchCharging
			return nil
		},
		func(c *store.Conversion) error {
			if c.Stripe.BatchID == b.ID && c.Stripe.PIStatus == store.PIChargeFailed {
				c.Stripe.PIStatus = store.PIBatched
			}
			return nil
		}, nil)
	if errors.Is(err, store.ErrStateConflict) {
		return s.Store.GetBatch(ctx, b.ID)
	}
	if err != nil {
		return nil, err
	}
	return s.chargeBatch(ctx, armed)
}

// ------------------------------------------------------------ API shapes

func batchItemsJSON(b *store.Batch) []map[string]any {
	items := make([]map[string]any, 0, len(b.Items))
	for _, it := range b.Items {
		items = append(items, map[string]any{
			"conversion_id": it.ConversionID,
			"project_id":    it.ProjectID,
			"step":          it.Step,
			"kind":          it.Kind,
			"description":   it.Description,
			"amount_cents":  it.AmountCents,
			"added_at":      it.AddedAt,
		})
	}
	return items
}

// pendingEntry serializes the user's open batch for the billing UI.
func pendingEntry(b *store.Batch) map[string]any {
	return map[string]any{
		"batch_id":     b.ID,
		"amount_cents": b.TotalCents,
		"currency":     b.Currency,
		"cap_cents":    b.CapCents,
		"opened_at":    b.OpenedAt,
		"due_at":       b.DueAt,
		"items":        batchItemsJSON(b),
	}
}

// failedBatchEntry serializes a delinquent batch like unpaidEntry does a
// conversion (same needs_action / client_secret contract).
func (s *Service) failedBatchEntry(ctx context.Context, b *store.Batch) map[string]any {
	entry := map[string]any{
		"batch_id":     b.ID,
		"amount_cents": b.TotalCents,
		"currency":     b.Currency,
		"needs_action": false,
		"items":        batchItemsJSON(b),
	}
	if b.PaymentIntentID != "" {
		if pi, err := s.Stripe.GetPaymentIntent(b.PaymentIntentID); err == nil {
			switch pi.Status {
			case stripe.PaymentIntentStatusRequiresAction, stripe.PaymentIntentStatusRequiresConfirmation:
				entry["needs_action"] = true
				entry["client_secret"] = pi.ClientSecret
			}
		} else {
			httpx.Log(ctx).Warn("unpaid batch PI lookup failed", "batch_id", b.ID, "err", err)
		}
	}
	return entry
}

// tierEntry describes the user's batch tier for the billing UI.
func (s *Service) tierEntry(ctx context.Context, cust *store.Customer) map[string]any {
	rates := s.Pricing.Rates(ctx)
	var paid int64
	if cust != nil {
		paid = cust.LifetimePaidCents
	}
	entry := map[string]any{
		"cap_cents":            rates.BatchCap(paid),
		"window_hours":         rates.BatchWindow().Hours(),
		"lifetime_paid_cents":  paid,
		"hold_threshold_cents": s.holdThreshold(ctx, cust),
	}
	if next := rates.NextBatchTier(paid); next != nil {
		entry["next_tier"] = map[string]any{
			"min_paid_cents": next.MinPaidCents,
			"cap_cents":      next.CapCents,
		}
	}
	return entry
}

// POST /v1/billing/pay-now — close the open batch and charge it now.
// Returns the settle contract: settled, or requires_action + client_secret
// for the 3DS fallback, or a decline message.
func (s *Service) HandlePayNow(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	s.refreshCardCache(ctx, user.UID, customerID)
	open, err := s.Store.OpenBatchFor(ctx, user.UID)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	resp := map[string]any{"settled": true, "publishable_key": s.Stripe.PublishableKey}
	if open == nil {
		httpx.WriteOK(w, resp)
		return
	}
	b, err := s.closeAndCharge(ctx, open.ID, store.BatchClosePayNow)
	if err != nil {
		httpx.Log(ctx).Warn("pay-now charge failed", "batch_id", open.ID, "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "could not take the payment; try again"))
		return
	}
	s.writeBatchOutcome(ctx, w, b, resp)
}

func (s *Service) writeBatchOutcome(ctx context.Context, w http.ResponseWriter, b *store.Batch, resp map[string]any) {
	switch b.State {
	case store.BatchPaid:
		resp["settled"] = true
	case store.BatchFailed:
		resp["settled"] = false
		entry := s.failedBatchEntry(ctx, b)
		if entry["needs_action"] == true {
			resp["requires_action"] = true
			resp["client_secret"] = entry["client_secret"]
		} else {
			resp["message"] = "The charge was declined. Update your card in the billing portal, then retry."
		}
	default: // charging: transient trouble, the sweep retries
		resp["settled"] = false
		resp["message"] = "The payment could not be taken right now; it will be retried automatically."
	}
	httpx.WriteOK(w, resp)
}
