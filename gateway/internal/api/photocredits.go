package api

import (
	"context"
	"log/slog"
	"net/http"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Photo packs were sold for one day (2026-09-02) and withdrawn: Apple
// treats prepaid credits consumed in-app as a consumable IAP (Guideline
// 3.1.1), so stills past the free allowance are metered and batched like
// video instead (handlers.go image create, docs/MOBILE.md §3). What
// remains here honors the balances that were bought.

// usageEntry is /v1/limits.usage; photo_credits appears only while a
// leftover pack balance exists.
func (s *Service) usageEntry(ctx context.Context, uid string, active int, freeImages int) map[string]any {
	usage := map[string]any{
		"active_conversions":    active,
		"free_images_remaining": freeImages,
	}
	if cust, err := s.Store.GetCustomer(ctx, uid); err == nil && cust.PhotoCredits > 0 {
		usage["photo_credits"] = cust.PhotoCredits
	}
	return usage
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

// POST /v1/billing/photo-pack — withdrawn. Older app builds that still
// offer the pack get a stable code to hide the purchase behind.
func (s *Service) HandlePhotoPackWithdrawn(w http.ResponseWriter, r *http.Request, _ *AuthedUser) {
	httpx.WriteErr(r.Context(), w, httpx.Err(http.StatusGone, "photo_packs_withdrawn",
		"photo packs are no longer sold; photos past the free daily allowance are billed per photo with your other conversions"))
}
