package api

import (
	"context"
	"log/slog"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The web plan grant marker (owner 2026-11-07, D14): every time the
// gateway grants or extends a web plan's RevenueCat entitlements (a paid
// plan invoice, a past_due extension, M3's re-grant), it also writes the
// RevenueCat attributes web_plan (the plan id: pro_weekly, pro_monthly,
// pro_yearly, business, studio) and web_plan_renews_at (the end of the
// period the grant covers, RFC 3339: the grant's expiry less its 3-day
// grace). A revoke, and the plan ending, set web_plan "none" and remove
// web_plan_renews_at. They go with the grants, gated like them (prod
// always; TEST only for rc_attr_allow_uids), not behind rc_attr_sync,
// which keeps gating the profile attributes. The KPI ingest counts a
// promotional entitlement as a web plan grant when web_plan isn't "none"
// and the grant's expiry is web_plan_renews_at + 3 days (±1 day).

// markWebPlan writes the marker for uid's plan after a grant until `until`.
func (s *Service) markWebPlan(ctx context.Context, uid string, until time.Time) {
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || cust.Plan == nil {
		return
	}
	s.setWebPlanAttrs(ctx, uid, map[string]string{
		"web_plan":           publicPlanID(cust.Plan.Key()),
		"web_plan_renews_at": until.Add(-planEntitlementGrace).UTC().Format(time.RFC3339),
	})
}

// clearWebPlan: the plan's grant was revoked or the plan ended.
func (s *Service) clearWebPlan(ctx context.Context, uid string) {
	s.setWebPlanAttrs(ctx, uid, map[string]string{"web_plan": "none", "web_plan_renews_at": ""})
}

func (s *Service) setWebPlanAttrs(ctx context.Context, uid string, attrs map[string]string) {
	if uid == "" || !s.RevenueCat.CanGrant() {
		return
	}
	actx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	if err := s.RevenueCat.SetAttributes(actx, uid, attrs, time.Now()); err != nil {
		slog.WarnContext(ctx, "web plan marker not written", "uid", uid, "web_plan", attrs["web_plan"], "err", err)
	}
}

// WebPlanBackfill writes the marker for every account whose web plan is
// active now (for when rc_attr_sync is switched on; owner's go only on
// prod). apply false counts only. On TEST the RevenueCat gate keeps it to
// allowlisted uids.
type WebPlanBackfill struct {
	Plans   int            `json:"active_plans"`
	ByPlan  map[string]int `json:"by_plan"`
	Written int            `json:"written"`
	Skipped int            `json:"skipped_no_grant"`
	DryRun  bool           `json:"dry_run"`
}

func (s *Service) BackfillWebPlanMarkers(ctx context.Context, apply bool) (*WebPlanBackfill, error) {
	custs, err := s.Store.ListPlanCustomers(ctx, 5000)
	if err != nil {
		return nil, err
	}
	out := &WebPlanBackfill{ByPlan: map[string]int{}, DryRun: !apply}
	now := time.Now()
	for uid, c := range custs {
		if c.Plan == nil || !c.Plan.Active(now) || c.AccountDeleted {
			continue
		}
		out.Plans++
		out.ByPlan[publicPlanID(c.Plan.Key())]++
		until := grantedUntil(c.Plan)
		if until == nil {
			out.Skipped++ // never granted (no RevenueCat key then, or a dispute holds it)
			continue
		}
		if apply {
			s.markWebPlan(ctx, uid, *until)
			out.Written++
		}
	}
	return out, nil
}

// grantedUntil is the plan's current grant end (nil when none is on).
func grantedUntil(p *store.Plan) *time.Time {
	if p.RCGrantedUntil == nil || p.RCRevokedAt != nil || !p.RCGrantedUntil.After(time.Now()) {
		return nil
	}
	return p.RCGrantedUntil
}
