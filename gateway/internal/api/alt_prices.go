package api

import (
	"context"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// alt_prices (owner 2026-11-04): a quote also prices the same run at
// Pro, Business and Studio, through the same quote (rounding, whole
// minutes, fps factor, add-ons, analyze credit), so the web shows our
// numbers instead of working them out. Free previews are left out: these
// are the prices. Lifelike only (Classic quotes ask the pipeline about
// reuse for each price; it's retired for new projects).

type quoteTierKey struct{}

// withQuoteTier makes quoteStep price at tier instead of the account's.
func withQuoteTier(ctx context.Context, tier string) context.Context {
	return context.WithValue(ctx, quoteTierKey{}, tier)
}

func quoteTierOverride(ctx context.Context) (accountTier, bool) {
	t, ok := ctx.Value(quoteTierKey{}).(string)
	return accountTier{Tier: t}, ok
}

// altPrices is {pro, business, studio} in cents, nil when the project
// isn't Lifelike or a price couldn't be made.
func (s *Service) altPrices(ctx context.Context, p *store.Project, params store.Params, step string, credit int64) map[string]int64 {
	if projectMethod(p) != store.MethodLifelike {
		return nil
	}
	out := map[string]int64{}
	for _, tier := range []string{pricing.TierPro, pricing.TierBusiness, pricing.TierStudio} {
		q, _, err := s.quoteStep(withQuoteTier(ctx, tier), p, params, step, credit)
		if err != nil {
			return nil
		}
		out[tier] = q.AmountCents
	}
	return out
}
