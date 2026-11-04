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
	// Source: where Pro comes from (app_store | mac_app_store |
	// rc_billing | promotional | plan | simulated); ManagementURL: where to
	// manage it (RevenueCat's, else Apple's page for Apple stores).
	Source        string `json:"source,omitempty"`
	ManagementURL string `json:"management_url,omitempty"`
	// PlanID and ScheduledChange: web Pro on our own Stripe (plan_id
	// pro_weekly | pro_monthly | pro_yearly; a step-down waiting for the
	// period's end, {to, effective_at}).
	PlanID          string `json:"plan_id,omitempty"`
	ScheduledChange any    `json:"scheduled_change,omitempty"`
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
	return s.withFreePreviews(ctx, ProStatus{Pro: true, Via: "simulated_app_pro", Known: true, Source: "simulated"}, "pro_monthly"), true
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
		slog.WarnContext(r.Context(), "pro status unknown", "uid", u.UID, "err", err)
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
		slog.WarnContext(r.Context(), "pro refresh failed", "uid", u.UID, "err", err)
	} else {
		slog.InfoContext(r.Context(), "pro refreshed", "uid", u.UID, "pro", st.Pro, "via", st.Via)
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
	ps.Source = proSource(st, cust, time.Now().UTC())
	ps.ManagementURL = managementURL(st, ps.Source)
	return ps
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
	ps.Pro, ps.Known, ps.Source, ps.PlanID = true, true, "plan", cust.Plan.PlanID
	ps.ScheduledChange = scheduledChangeJSON(cust.Plan)
	if ps.FreePreviews == nil {
		ps = s.withFreePreviews(ctx, ps, cust.Plan.PlanID)
	}
	return ps
}
