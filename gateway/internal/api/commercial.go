package api

import (
	"context"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Commercial use (owner 2026-11-09) is a +50% add-on on every plan;
// Business and Studio stopped including it. A Business/Studio plan active
// when the change went live keeps it included until its next renewal: its
// plan record gets commercial_until = the period's end, once, from svs-admin
// commercial-grandfather. Quotes and runs read only that field.

// CommercialGrandfather is what svs-admin commercial-grandfather found and
// wrote.
type CommercialGrandfather struct {
	DryRun  bool           `json:"dry_run"`
	Plans   int            `json:"active_business_studio_plans"`
	ByPlan  map[string]int `json:"by_plan"`
	Already int            `json:"already_marked"`
	Skipped int            `json:"skipped_no_period_end"`
	Written int            `json:"written"`
	UIDs    []string       `json:"uids"`
}

// grandfatherable: an active Business or Studio plan of ours.
func grandfatherable(p *store.Plan, now time.Time) bool {
	return p != nil && p.Active(now) && (p.Tier == pricing.TierBusiness || p.Tier == pricing.TierStudio)
}

// GrandfatherCommercial marks every active Business/Studio plan with
// commercial_until = its current period's end (apply=false counts only).
// A plan already marked keeps its date.
func (s *Service) GrandfatherCommercial(ctx context.Context, apply bool) (*CommercialGrandfather, error) {
	custs, err := s.Store.ListPlanCustomers(ctx, 5000)
	if err != nil {
		return nil, err
	}
	out := &CommercialGrandfather{DryRun: !apply, ByPlan: map[string]int{}, UIDs: []string{}}
	now := time.Now()
	for uid, c := range custs {
		if c.AccountDeleted || !grandfatherable(c.Plan, now) {
			continue
		}
		out.Plans++
		out.ByPlan[publicPlanID(c.Plan.Key())]++
		switch {
		case c.Plan.CommercialUntil != nil:
			out.Already++
			continue
		case c.Plan.CurrentPeriodEnd == nil:
			out.Skipped++
			continue
		}
		out.UIDs = append(out.UIDs, uid)
		if !apply {
			continue
		}
		if _, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
			if grandfatherable(c.Plan, now) && c.Plan.CommercialUntil == nil && c.Plan.CurrentPeriodEnd != nil {
				until := *c.Plan.CurrentPeriodEnd
				c.Plan.CommercialUntil = &until
			}
			return nil
		}); err != nil {
			return out, err
		}
		out.Written++
	}
	return out, nil
}
