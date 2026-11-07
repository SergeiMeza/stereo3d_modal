package api

import (
	"context"
	"fmt"
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

// markWebPlan writes the marker for uid's plan's grant until `until`,
// before the grant itself (the KPI ingest never sees a grant without it).
// A failed write is queued for the reconciler and never holds the grant
// back. The revoke's "none" goes after the revoke went through.
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
	at := time.Now().UTC().Truncate(time.Millisecond) // RevenueCat's updated_at_ms; a retry sends it again
	actx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	if err := s.RevenueCat.SetAttributes(actx, uid, attrs, at); err != nil {
		slog.WarnContext(ctx, "web plan marker not written: queued for a retry", "uid", uid, "web_plan", attrs["web_plan"], "err", err)
		if _, qerr := s.Store.QueueRCAttrRetry(actx, uid, attrs, at, err.Error(), at.Add(rcAttrBackoff(0))); qerr != nil {
			s.Slack.Alert(ctx, "rc_attr_retry_failed", fmt.Sprintf("web plan marker for `%s` (web_plan %s) neither written nor queued: %v / %v", uid, attrs["web_plan"], err, qerr))
		}
		return
	}
	if err := s.Store.DoneRCAttrRetry(actx, uid, at); err != nil { // an earlier failed write is superseded
		slog.WarnContext(ctx, "rc attribute retry not cleared", "uid", uid, "err", err)
	}
}

// rcAttrBackoff: 1, 2, 4 … minutes after the n-th failure, at most 6 h.
func rcAttrBackoff(n int) time.Duration {
	if n > 9 {
		return 6 * time.Hour
	}
	return min(time.Minute<<n, 6*time.Hour)
}

const (
	rcAttrAlertAfter = 6                  // failed retries before Slack hears of it (once)
	rcAttrGiveUp     = 7 * 24 * time.Hour // a retry this old is dropped, with an alert
)

// rcAttrRetrySweep tries the failed attribute writes that are due again
// (reconciler, every run). The RevenueCat gate applies as on the first
// try: on TEST only allowlisted uids are written.
func (s *Service) rcAttrRetrySweep(ctx context.Context, now time.Time) (done int) {
	if s.Store == nil || !s.RevenueCat.CanGrant() {
		return 0
	}
	due, err := s.Store.ListDueRCAttrRetries(ctx, now, 50)
	if err != nil {
		slog.WarnContext(ctx, "rc attribute retries not listed", "err", err)
		return 0
	}
	for _, r := range due {
		actx, cancel := context.WithTimeout(ctx, 15*time.Second)
		err := s.RevenueCat.SetAttributes(actx, r.UID, r.Attrs, r.At)
		cancel()
		if err == nil {
			if s.Store.DoneRCAttrRetry(ctx, r.UID, r.At) == nil {
				done++
				slog.InfoContext(ctx, "web plan marker written on retry", "uid", r.UID, "web_plan", r.Attrs["web_plan"], "attempts", r.Attempts+1)
			}
			continue
		}
		if now.Sub(r.CreatedAt) > rcAttrGiveUp {
			s.Slack.Alert(ctx, "rc_attr_retry_gave_up", fmt.Sprintf("web plan marker for `%s` (web_plan %s) dropped after %d tries over 7 days: %v", r.UID, r.Attrs["web_plan"], r.Attempts+1, err))
			s.Store.DoneRCAttrRetry(ctx, r.UID, r.At)
			continue
		}
		alert := !r.Alerted && r.Attempts+1 >= rcAttrAlertAfter
		if alert {
			s.Slack.Alert(ctx, "rc_attr_retry_failing", fmt.Sprintf("web plan marker for `%s` (web_plan %s) still not written after %d tries: %v", r.UID, r.Attrs["web_plan"], r.Attempts+1, err))
		}
		s.Store.FailRCAttrRetry(ctx, r.UID, r.At, err.Error(), now.Add(rcAttrBackoff(r.Attempts+1)), alert)
	}
	return done
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
