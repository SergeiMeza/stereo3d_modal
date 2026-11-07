package api

import (
	"context"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// stepUpPayLive and payStepUpCheckout: a step-up's pay link (D4) — filled
// in with the step-up's on-session payment.
func (s *Service) stepUpPayLive(ctx context.Context, p *store.PayRequest, cust *store.Customer) (string, int64) {
	return store.PayVoid, p.AmountCents
}

func (s *Service) payStepUpCheckout(ctx context.Context, p *store.PayRequest, pc payContext) (map[string]any, error) {
	return nil, errPayLinkUnknown()
}
