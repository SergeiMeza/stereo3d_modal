package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/revenuecat"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// ProStatus is GET /v1/pro and POST /v1/pro/refresh (S3D-68): whether the
// signed-in person holds Spatial Video Studio Pro, by the same rule the
// quotes use. known is false when RevenueCat couldn't tell (not configured,
// down); the page then shows the plans rather than claiming either way.
type ProStatus struct {
	Pro   bool   `json:"pro"`
	Via   string `json:"via,omitempty"`
	Known bool   `json:"known"`
	// Source: where Pro comes from (app_store | mac_app_store | web |
	// grant | unknown); SourceDetail the finer reading it came from
	// (app_store | mac_app_store | rc_billing | promotional | plan |
	// simulated, the values source had before 2026-11-05); Period: weekly |
	// monthly | yearly | lifetime | pass; RenewsAt or EndsAt when known;
	// ManagementURL: where to manage it (RevenueCat's, else Apple's page
	// for Apple stores).
	Source        string     `json:"source,omitempty"`
	SourceDetail  string     `json:"source_detail,omitempty"`
	Period        string     `json:"period,omitempty"`
	RenewsAt      *time.Time `json:"renews_at,omitempty"`
	EndsAt        *time.Time `json:"ends_at,omitempty"`
	ManagementURL string     `json:"management_url,omitempty"`
	// PlanID and ScheduledChange: web Pro on our own Stripe (plan_id
	// pro_weekly | pro_monthly | pro_yearly; a step-down waiting for the
	// period's end, {to, effective_at}).
	PlanID          string `json:"plan_id,omitempty"`
	ScheduledChange any    `json:"scheduled_change,omitempty"`
	// Renewable / RestoredFrom: web Pro only; a restored or support-moved
	// plan never renews (renewable false, restored_from true).
	Renewable    *bool `json:"renewable,omitempty"`
	RestoredFrom bool  `json:"restored_from,omitempty"`
	// FreePreviews: the Pro holder's free Lifelike previews, from the
	// gateway's own table (owner 2026-11-04): {allowance, per_period,
	// period: week|month|year|pass}; absent when not Pro.
	FreePreviews *ProFreePreviews `json:"free_previews,omitempty"`
}

// ProFreePreviews is ProStatus.free_previews.
type ProFreePreviews struct {
	Allowance string `json:"allowance"` // pro_weekly | pro_monthly | … | business | studio
	PerPeriod int    `json:"per_period"`
	Period    string `json:"period"`
}

func proStatusOf(st revenuecat.Status, err error) ProStatus {
	if err != nil {
		return ProStatus{}
	}
	return ProStatus{Pro: st.Pro, Via: st.Via, Known: true}
}

// withFreePreviews adds the allowance for what they hold (key from
// Status.AllowanceKey, or pro_monthly for the test switch).
func (s *Service) withFreePreviews(ctx context.Context, ps ProStatus, key string) ProStatus {
	if !ps.Pro || key == "" {
		return ps
	}
	ps.FreePreviews = &ProFreePreviews{Allowance: key, PerPeriod: s.rates(ctx).FreePreviewAllowance(key), Period: pricing.FreePreviewPeriods[key]}
	if ps.FreePreviews.Period == "" {
		ps.FreePreviews.Period = "month"
	}
	return ps
}

// simulatedProStatus: the test switch reads as the app's Pro here too.
func (s *Service) simulatedProStatus(ctx context.Context, uid string) (ProStatus, bool) {
	if s.Store == nil {
		return ProStatus{}, false
	}
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || !s.simulatedAppPro(cust) {
		return ProStatus{}, false
	}
	ps := ProStatus{Pro: true, Via: "simulated_app_pro", Known: true, Source: sourceOf("simulated"), SourceDetail: "simulated", Period: "monthly"}
	return s.withFreePreviews(ctx, ps, "pro_monthly"), true
}

// HandleProStatus answers from the 10-minute cache.
func (s *Service) HandleProStatus(w http.ResponseWriter, r *http.Request, u *AuthedUser) {
	if ps, ok := s.simulatedProStatus(r.Context(), u.UID); ok {
		httpx.WriteOK(w, ps)
		return
	}
	if !s.RevenueCat.Configured() {
		httpx.WriteOK(w, s.withWebPlan(r.Context(), u.UID, ProStatus{}))
		return
	}
	st, err := s.RevenueCat.Pro(r.Context(), u.UID)
	if err != nil {
		slog.WarnContext(r.Context(), "pro status unknown", "err", err)
	} else {
		s.noteProSeen(r.Context(), u.UID, st.Pro && st.Tier == "") // a start of Pro (plans count at checkout)
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, s.withWebPlan(r.Context(), u.UID, s.withSource(r.Context(), u.UID, s.withFreePreviews(r.Context(), proStatusOf(st, err), st.AllowanceKey()), st, err)))
}

// HandleProRefresh asks RevenueCat again, skipping the cache: the web calls
// it right after a purchase so the next quote carries the Pro discount.
func (s *Service) HandleProRefresh(w http.ResponseWriter, r *http.Request, u *AuthedUser) {
	if ps, ok := s.simulatedProStatus(r.Context(), u.UID); ok {
		httpx.WriteOK(w, ps)
		return
	}
	if !s.RevenueCat.Configured() {
		httpx.WriteOK(w, s.withWebPlan(r.Context(), u.UID, ProStatus{}))
		return
	}
	st, err := s.RevenueCat.Fresh(r.Context(), u.UID)
	if err != nil {
		slog.WarnContext(r.Context(), "pro refresh failed", "err", err)
	} else {
		slog.InfoContext(r.Context(), "pro refreshed", "pro", st.Pro, "via", st.Via)
		s.noteProSeen(r.Context(), u.UID, st.Pro && st.Tier == "")
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, s.withWebPlan(r.Context(), u.UID, s.withSource(r.Context(), u.UID, s.withFreePreviews(r.Context(), proStatusOf(st, err), st.AllowanceKey()), st, err)))
}

// withSource adds where Pro comes from and where to manage it.
func (s *Service) withSource(ctx context.Context, uid string, ps ProStatus, st revenuecat.Status, err error) ProStatus {
	if err != nil || !ps.Pro {
		return ps
	}
	var cust *store.Customer
	if s.Store != nil {
		cust, _ = s.Store.GetCustomer(ctx, uid)
	}
	ps.SourceDetail = proSource(st, cust, time.Now().UTC())
	ps.Source = sourceOf(ps.SourceDetail)
	ps.ManagementURL = managementURL(st, ps.SourceDetail)
	return s.withTerms(ctx, uid, ps, st, cust)
}

// withWebPlan: a Pro plan on our own Stripe answers for itself (even when
// RevenueCat is slow to show the grant): Pro, source plan, its plan id,
// allowance and any waiting step-down.
func (s *Service) withWebPlan(ctx context.Context, uid string, ps ProStatus) ProStatus {
	if s.Store == nil {
		return ps
	}
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || cust.Plan == nil || cust.Plan.Tier != pricing.TierPro || cust.Plan.PlanID == "" || !cust.Plan.Active(time.Now()) {
		return ps
	}
	ps.Pro, ps.Known, ps.SourceDetail, ps.Source, ps.PlanID = true, true, "plan", "web", cust.Plan.PlanID
	ps.RenewsAt, ps.EndsAt = nil, nil
	ps = s.withTerms(ctx, uid, ps, revenuecat.Status{}, cust)
	ps.ScheduledChange = scheduledChangeJSON(cust.Plan)
	renewable := !planNotRenewable(cust.Plan)
	ps.Renewable, ps.RestoredFrom = &renewable, !renewable
	if ps.FreePreviews == nil {
		ps = s.withFreePreviews(ctx, ps, cust.Plan.PlanID)
	}
	return ps
}

// Pro sources as the web shows them (QA batch 3, 2026-11-05): app_store |
// mac_app_store | web (our Stripe plans and RevenueCat Web Billing) |
// grant (a support or promotional grant) | unknown.
func sourceOf(detail string) string {
	switch detail {
	case "app_store", "mac_app_store":
		return detail
	case "plan", "rc_billing":
		return "web"
	case "promotional":
		return "grant"
	case "simulated":
		return "app_store" // the test switch stands in for the app's Pro
	}
	return "unknown"
}

// periodOf names a Pro's billing period from its allowance key: weekly |
// monthly | yearly | lifetime | pass ("" when not known).
func periodOf(key, interval string) string {
	switch key {
	case "pro_weekly":
		return "weekly"
	case "pro_monthly":
		return "monthly"
	case "pro_yearly":
		return "yearly"
	case "pro_lifetime":
		return "lifetime"
	case "pro_pass_3m", "pro_pass_6m":
		return "pass"
	}
	switch interval {
	case "year":
		return "yearly"
	case "month", "":
		if key == pricing.TierBusiness || key == pricing.TierStudio {
			return "monthly"
		}
	}
	return ""
}

// endOrRenewal sets renews_at (a subscription that renews) or ends_at.
func (ps *ProStatus) endOrRenewal(at *time.Time, renews bool) {
	if at == nil || at.IsZero() {
		return
	}
	t := at.UTC().Truncate(time.Second)
	if renews {
		ps.RenewsAt, ps.EndsAt = &t, nil
	} else {
		ps.EndsAt, ps.RenewsAt = &t, nil
	}
}

// withTerms adds the period and the renewal or end of what makes the
// person Pro: the App Store subscription, a web plan (our Stripe), or a
// grant (our grant record's end, else RevenueCat's expiry).
func (s *Service) withTerms(ctx context.Context, uid string, ps ProStatus, st revenuecat.Status, cust *store.Customer) ProStatus {
	switch ps.SourceDetail {
	case "app_store", "mac_app_store":
		if st.Store == "" && st.AppStore != nil { // found among the subscriptions
			ps.Period = periodOf(revenuecat.Status{Pro: true, Via: st.AppStore.Product, ExpiresAt: st.AppStore.ExpiresAt}.AllowanceKey(), "")
			ps.endOrRenewal(st.AppStore.ExpiresAt, st.AppStore.WillRenew)
			return ps
		}
		ps.Period = periodOf(st.AllowanceKey(), "")
		if ps.Period != "lifetime" {
			ps.endOrRenewal(st.ExpiresAt, st.WillRenew && ps.Period != "pass")
		}
	case "rc_billing":
		ps.Period = periodOf(st.AllowanceKey(), "")
		if ps.Period != "lifetime" {
			ps.endOrRenewal(st.ExpiresAt, st.WillRenew && ps.Period != "pass")
		}
	case "plan":
		if cust != nil && cust.Plan != nil {
			key := cust.Plan.PlanID
			if key == "" {
				key = cust.Plan.Tier
			}
			ps.Period = periodOf(key, cust.Plan.Interval)
			ps.endOrRenewal(cust.Plan.CurrentPeriodEnd, !cust.Plan.CancelAtPeriodEnd)
		}
	case "promotional":
		end := st.ExpiresAt
		if s.Store != nil {
			if gs, err := s.Store.ListUserAdminGrants(ctx, uid, 50); err == nil {
				now := time.Now()
				for _, g := range gs {
					if g.Entitlement == "pro" && g.Status(now) == "active" && (end == nil || g.EndsAt.After(*end)) {
						e := g.EndsAt
						end = &e
					}
				}
			}
		}
		ps.endOrRenewal(end, false)
	case "simulated":
		ps.Period = "monthly"
	}
	return ps
}
