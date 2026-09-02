package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/stripe/stripe-go/v78"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Photo packs (docs/MOBILE.md §3): past the free daily allowance, stills
// consume purchased credits bought PhotoPackSize at a time. A pack is a
// purchase, not usage — it is charged immediately on the saved card (never
// batched) and its credits land in the same transaction that marks it paid.

// photoPackEntry is the rates.photo_pack shape shared by /v1/limits and
// /v1/billing.
func (s *Service) photoPackEntry(ctx context.Context) map[string]any {
	rates := s.Pricing.Rates(ctx)
	size, cents := rates.PhotoPack()
	return map[string]any{"size": size, "price_cents": cents, "currency": rates.Currency}
}

func (s *Service) photoCreditsFor(ctx context.Context, uid string) int64 {
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil {
		return 0
	}
	return cust.PhotoCredits
}

// errNoPhotoCredits is the 402 the image-create path returns past the free
// allowance with no credits; details carry the pack offer so the app can
// sell it before uploading anything else.
func (s *Service) errNoPhotoCredits(ctx context.Context) *httpx.APIError {
	size, cents := s.Pricing.Rates(ctx).PhotoPack()
	e := httpx.Err(http.StatusPaymentRequired, "no_photo_credits",
		"your free photo conversions for today are used up — buy a photo pack to continue")
	e.Details = map[string]any{"pack_size": size, "pack_price_cents": cents}
	return e
}

// refundPhotoCredit returns the credit of a credited still that never
// delivered. Called from the no-charge terminal path (releaseHold), which
// runs exactly once per conversion.
func (s *Service) refundPhotoCredit(ctx context.Context, conv *store.Conversion) {
	if conv.Kind != "image" || conv.Quote.Breakdown == nil || conv.Quote.Breakdown["photo_credit"] != true {
		return
	}
	if err := s.Store.RefundPhotoCredit(ctx, conv.UID); err != nil {
		slog.WarnContext(ctx, "photo credit refund failed", "conversion_id", conv.ID, "uid", conv.UID, "err", err)
		return
	}
	slog.InfoContext(ctx, "photo credit refunded", "conversion_id", conv.ID, "uid", conv.UID)
}

// POST /v1/billing/photo-pack — buy one pack on the saved card, now.
// Idempotency-Key makes a retried tap return the original purchase.
func (s *Service) HandleBuyPhotoPack(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey != "" {
		if prior, err := s.Store.FindPhotoPackByIdemKey(ctx, user.UID, idemKey); err == nil {
			if prior.State == store.PackCharging {
				prior, _ = s.chargePhotoPack(ctx, prior)
			}
			s.writePackOutcome(ctx, w, user, prior)
			return
		} else if !errors.Is(err, store.ErrNotFound) {
			httpx.WriteErr(ctx, w, err)
			return
		}
	}
	// Card on file and no outstanding failed charge — a pack is bought on
	// the same standing as any other paid work.
	if _, err := s.requireBillable(ctx, user); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	rates := s.Pricing.Rates(ctx)
	size, cents := rates.PhotoPack()
	pack := &store.PhotoPack{
		ID: store.NewID(), UID: user.UID, Env: s.Cfg.Env, State: store.PackCharging,
		Size: size, AmountCents: cents, Currency: rates.Currency, IdemKey: idemKey,
	}
	if err := s.Store.CreatePhotoPack(ctx, pack); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	charged, err := s.chargePhotoPack(ctx, pack)
	if err != nil {
		httpx.Log(ctx).Warn("photo pack charge failed", "pack_id", pack.ID, "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "could not take the payment; try again"))
		return
	}
	s.writePackOutcome(ctx, w, user, charged)
}

func (s *Service) writePackOutcome(ctx context.Context, w http.ResponseWriter, user *AuthedUser, p *store.PhotoPack) {
	resp := map[string]any{"publishable_key": s.Stripe.PublishableKey, "pack_id": p.ID}
	switch p.State {
	case store.PackPaid:
		resp["settled"] = true
		resp["photo_credits"] = s.photoCreditsFor(ctx, user.UID)
	case store.PackFailed:
		resp["settled"] = false
		if p.PaymentIntentID != "" {
			if pi, err := s.Stripe.GetPaymentIntent(p.PaymentIntentID); err == nil &&
				(pi.Status == stripe.PaymentIntentStatusRequiresAction || pi.Status == stripe.PaymentIntentStatusRequiresConfirmation) {
				resp["requires_action"] = true
				resp["client_secret"] = pi.ClientSecret
			}
		}
		if resp["requires_action"] != true {
			resp["message"] = "The card was declined. Update your card in the billing portal, then retry."
		}
	default:
		resp["settled"] = false
		resp["message"] = "The payment could not be taken right now; it will be retried automatically."
	}
	httpx.WriteOK(w, resp)
}

// chargePhotoPack collects a pack (state=charging): one off-session PI per
// pack (idempotent on the pack id; retries Confirm the same PI). Success
// grants the credits; a card decision fails the pack (no credits, nothing
// else on the account changes — a failed pack is not delinquency).
func (s *Service) chargePhotoPack(ctx context.Context, p *store.PhotoPack) (*store.PhotoPack, error) {
	if p.State != store.PackCharging {
		return p, nil
	}
	cust, err := s.Store.GetCustomer(ctx, p.UID)
	if err != nil {
		return p, err
	}
	if cust.DefaultPaymentMethod == "" && cust.StripeCustomerID != "" {
		cust = s.refreshCardCache(ctx, p.UID, cust.StripeCustomerID)
	}
	var pi *stripe.PaymentIntent
	var chErr error
	switch {
	case p.PaymentIntentID != "":
		pi, chErr = s.Stripe.ConfirmSavedCharge(p.PaymentIntentID, cust.DefaultPaymentMethod, cust.Email)
	case cust.DefaultPaymentMethod == "":
		return s.recordPackFailure(ctx, p, stripex.ChargeFailure{Code: "no_payment_method", Message: "no default payment method on file"})
	default:
		pi, chErr = s.Stripe.ChargeSaved(cust.StripeCustomerID, cust.DefaultPaymentMethod, p.AmountCents, p.Currency, stripex.Job{
			PackID:       p.ID,
			UID:          p.UID,
			Description:  fmt.Sprintf("Photo pack — %d conversions", p.Size),
			Metadata:     map[string]string{"pack_size": fmt.Sprint(p.Size)},
			ReceiptEmail: cust.Email,
		})
	}
	if chErr == nil && (pi.Status == stripe.PaymentIntentStatusSucceeded || pi.Status == stripe.PaymentIntentStatusProcessing) {
		return s.finalizePackPaid(ctx, p, pi.ID)
	}
	var fail stripex.ChargeFailure
	if chErr != nil {
		fail = stripex.ClassifyChargeError(chErr)
	} else {
		fail = stripex.ChargeFailure{PaymentIntentID: pi.ID, Code: string(pi.Status),
			NeedsAction: pi.Status == stripe.PaymentIntentStatusRequiresAction, Message: "payment intent is " + string(pi.Status)}
	}
	slog.ErrorContext(ctx, "stripe photo pack charge failed", "pack_id", p.ID, "uid", p.UID,
		"code", fail.Code, "transient", fail.Transient, "err", fail.Message)
	return s.recordPackFailure(ctx, p, fail)
}

func (s *Service) finalizePackPaid(ctx context.Context, p *store.PhotoPack, piID string) (*store.PhotoPack, error) {
	now := time.Now().UTC()
	updated, credits, err := s.Store.TransitionPhotoPack(ctx, p.ID, []string{store.PackCharging, store.PackFailed}, func(pp *store.PhotoPack) error {
		pp.State = store.PackPaid
		if piID != "" {
			pp.PaymentIntentID = piID
		}
		pp.ChargedAt = &now
		pp.SettleError = ""
		return nil
	})
	if errors.Is(err, store.ErrStateConflict) {
		return s.Store.GetPhotoPack(ctx, p.ID)
	}
	if err != nil {
		return nil, err
	}
	slog.InfoContext(ctx, "photo pack purchased", "pack_id", p.ID, "uid", p.UID,
		"payment_intent", piID, "amount_cents", p.AmountCents, "credits_now", credits)
	return updated, nil
}

func (s *Service) recordPackFailure(ctx context.Context, p *store.PhotoPack, fail stripex.ChargeFailure) (*store.PhotoPack, error) {
	updated, _, err := s.Store.TransitionPhotoPack(ctx, p.ID, []string{store.PackCharging}, func(pp *store.PhotoPack) error {
		if fail.PaymentIntentID != "" {
			pp.PaymentIntentID = fail.PaymentIntentID
		}
		pp.SettleError = "charge: " + fail.Message
		if !fail.Transient {
			pp.State = store.PackFailed
		}
		return nil
	})
	if errors.Is(err, store.ErrStateConflict) {
		return s.Store.GetPhotoPack(ctx, p.ID)
	}
	return updated, err
}

// handlePackWebhook: a pack PI settled outside chargePhotoPack (3DS
// fallback) or died after a retry.
func (s *Service) handlePackWebhook(ctx context.Context, w http.ResponseWriter, eventType, packID, piID, piStatus string) {
	p, err := s.Store.GetPhotoPack(ctx, packID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.WriteOK(w, map[string]bool{"received": true})
		return
	}
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	switch eventType {
	case "payment_intent.succeeded":
		if p.State != store.PackPaid {
			if _, err := s.finalizePackPaid(ctx, p, piID); err != nil {
				httpx.WriteErr(ctx, w, httpx.ErrServer())
				return
			}
		}
	case "payment_intent.payment_failed":
		if p.State == store.PackCharging {
			_, _ = s.recordPackFailure(ctx, p, stripex.ChargeFailure{PaymentIntentID: piID, Code: "payment_failed",
				Message: "payment_failed webhook (pi " + piStatus + ")"})
		}
	}
	httpx.WriteOK(w, map[string]bool{"received": true})
}
