package api

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/revenuecat"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Subscriber tiers and free previews (pricing 2026-11, test only until
// the owner's go): Studio > Business (web plans, Stripe Billing) > Pro
// (RevenueCat "pro" or a running pass) > none. Each tier has its own
// prices; free previews reset with the holder's period (no rollover).

type accountTier struct {
	Tier         string     // studio | business | pro | ""
	AllowanceKey string     // business | studio | pro_monthly | … | "" (intro)
	PeriodKey    string     // the period the free previews count in
	PeriodEnd    *time.Time // when they reset ("" = unknown)
	Plan         *store.Plan
}

// accountTier reads the account's best tier. Any doubt about Pro (no
// RevenueCat key, an error) is "not Pro": list prices, never blocked.
func (s *Service) accountTier(ctx context.Context, uid string) accountTier {
	now := time.Now().UTC()
	// The Stripe mirror (cust.Plan) is the source of truth for the plan
	// and its credit; RevenueCat adds Pro and, as a cross-source, the
	// business/studio entitlements. The highest tier wins: studio >
	// business > pro.
	var best accountTier
	if s.Store != nil {
		cust, err := s.Store.GetCustomer(ctx, uid)
		if err == nil && s.simulatedAppPro(cust) {
			// TEST: reads as the app's Pro (Pro Monthly's allowance).
			best = accountTier{Tier: pricing.TierPro, AllowanceKey: "pro_monthly", PeriodKey: "simulated:" + now.Format("2006-01")}
		}
		if err == nil && cust.Plan.Active(now) && cust.Plan.Tier == pricing.TierPro && cust.Plan.PlanID != "" {
			// Web Pro on our Stripe: Pro's prices, its plan's free previews
			// per period.
			start := ""
			if cust.Plan.CurrentPeriodStart != nil {
				start = cust.Plan.CurrentPeriodStart.Format(time.RFC3339)
			}
			best = accountTier{Tier: pricing.TierPro, AllowanceKey: cust.Plan.PlanID, Plan: cust.Plan,
				PeriodKey: "plan:" + cust.Plan.SubscriptionID + ":" + start, PeriodEnd: cust.Plan.CurrentPeriodEnd}
		}
		if err == nil && cust.Plan.Active(now) {
			if _, ok := s.rates(ctx).Plan(cust.Plan.Tier); ok {
				best = accountTier{Tier: cust.Plan.Tier, AllowanceKey: cust.Plan.Tier, Plan: cust.Plan, PeriodEnd: cust.Plan.CurrentPeriodEnd}
				start := ""
				if cust.Plan.CurrentPeriodStart != nil {
					start = cust.Plan.CurrentPeriodStart.Format(time.RFC3339)
				}
				best.PeriodKey = "plan:" + cust.Plan.SubscriptionID + ":" + start
				if k, _, to, ok := cust.Plan.Month(now); ok && cust.Plan.Yearly() {
					// A yearly plan's free previews reset every month of the year.
					best.PeriodKey, best.PeriodEnd = fmt.Sprintf("plan:%s:m%02d", cust.Plan.SubscriptionID, k), &to
				}
			}
		}
	}
	if best.Tier == pricing.TierStudio || !s.RevenueCat.Configured() {
		return best
	}
	st, err := s.RevenueCat.Pro(ctx, uid)
	if err != nil {
		slog.WarnContext(ctx, "pro check failed (list price)", "uid", uid, "err", err)
		return best
	}
	if !st.Pro {
		return best
	}
	rc := accountTier{Tier: pricing.TierPro, AllowanceKey: st.AllowanceKey()}
	if _, ok := s.rates(ctx).Plan(rc.AllowanceKey); ok {
		// A plan reached through RevenueCat (the mirror lags or is
		// missing): the plan's rate and preview allowance, never Pro's.
		rc.Tier = rc.AllowanceKey
		start := ""
		if st.PeriodStart != nil {
			start = st.PeriodStart.UTC().Format(time.RFC3339)
		}
		rc.PeriodKey, rc.PeriodEnd = "rc:"+rc.Tier+":"+start, st.ExpiresAt
	} else {
		rc.PeriodKey, rc.PeriodEnd = proPeriod(st, rc.AllowanceKey, now)
	}
	if tierRank(rc.Tier) > tierRank(best.Tier) {
		return rc
	}
	return best
}

// tierRank orders tiers: studio > business > pro > none.
func tierRank(t string) int {
	switch t {
	case pricing.TierStudio:
		return 3
	case pricing.TierBusiness:
		return 2
	case pricing.TierPro:
		return 1
	}
	return 0
}

// proPeriod is a Pro holder's current allowance period: a pass's whole
// run, a subscription's current renewal, Lifetime's calendar month.
func proPeriod(st revenuecat.Status, key string, now time.Time) (string, *time.Time) {
	if key == "pro_lifetime" {
		end := time.Date(now.Year(), now.Month()+1, 1, 0, 0, 0, 0, time.UTC)
		return "lifetime:" + now.Format("2006-01"), &end
	}
	start := st.PeriodStart
	if start == nil && st.ExpiresAt != nil {
		var s time.Time
		switch key {
		case "pro_weekly":
			s = st.ExpiresAt.AddDate(0, 0, -7)
		case "pro_yearly":
			s = st.ExpiresAt.AddDate(-1, 0, 0)
		default:
			s = st.ExpiresAt.AddDate(0, -1, 0)
		}
		start = &s
	}
	if start == nil { // counted per calendar month: it resets on the 1st
		end := time.Date(now.Year(), now.Month()+1, 1, 0, 0, 0, 0, time.UTC)
		return key + ":" + now.Format("2006-01"), &end
	}
	return st.Via + ":" + start.UTC().Format(time.RFC3339), st.ExpiresAt
}

// previewPeriod names what a free-preview allowance counts over, for the
// copy: week | month | year | pass | first_project.
func previewPeriod(allowanceKey string) string {
	switch allowanceKey {
	case "":
		return "first_project"
	case "pro_weekly":
		return "week"
	case "pro_yearly":
		return "year"
	case "pro_pass_3m", "pro_pass_6m":
		return "pass"
	}
	return "month" // pro_monthly, pro_lifetime (calendar month), business, studio
}

type freePreviewState struct {
	Allowance int
	Used      int
	Remaining int
	DayLeft   int
	Units     int
	Intro     bool // the non-subscriber's one free preview
	Period    string
	Free      bool // this preview (Units) would be free
	PeriodEnd *time.Time
}

func (f freePreviewState) JSON() map[string]any {
	out := map[string]any{"allowance": f.Allowance, "used": f.Used, "remaining": f.Remaining,
		"daily_left": f.DayLeft, "units": f.Units, "free": f.Free, "intro": f.Intro, "period": f.Period}
	if f.PeriodEnd != nil {
		out["resets_at"] = f.PeriodEnd.Format(time.RFC3339)
	}
	return out
}

// freePreviewStatus: what's left, and whether a preview of units would be
// free now (subscribers: their period allowance and the daily cap;
// others: one on their first project).
func (s *Service) freePreviewStatus(ctx context.Context, uid string, at accountTier, units int) freePreviewState {
	r := s.rates(ctx)
	st := freePreviewState{Units: units, PeriodEnd: at.PeriodEnd, Period: previewPeriod(at.AllowanceKey)}
	if !r.FreePreviewsEnabled || s.Store == nil {
		return st
	}
	day := time.Now().UTC().Format("2006-01-02")
	key := at.PeriodKey
	if at.AllowanceKey == "" {
		key = "intro"
	}
	u, err := s.Store.GetPreviewUsage(ctx, uid, key, day)
	if err != nil {
		return st
	}
	st.DayLeft = max(r.FreePreviewDailyCap()-u.DayUsed, 0)
	if at.AllowanceKey == "" {
		st.Intro, st.Allowance = true, r.FreePreviewAllowance("intro")
		if u.IntroUsed || st.Allowance <= 0 || !s.onFirstProject(ctx, uid) {
			st.Used = st.Allowance
		}
		st.Remaining = max(st.Allowance-st.Used, 0)
		// one preview, whatever its size; only a preview's quote is free
		// (units > 0), never a full run's (billing UX 2026-11-07)
		st.Free = units > 0 && st.Remaining > 0 && st.DayLeft >= 1
		return st
	}
	st.Allowance = r.FreePreviewAllowance(at.AllowanceKey)
	st.Used = u.Used
	st.Remaining = max(st.Allowance-u.Used, 0)
	st.Free = units > 0 && st.Remaining >= units && st.DayLeft >= units
	return st
}

// onFirstProject: the account has made at most one project (the intro
// preview is for the first).
//
// The "Sunset session" sample doesn't count (owner bug 2026-11-07: a new
// account with the sample and one upload was charged $1.00 for the
// preview the onboarding promises free). Deleted projects don't count
// either: the intro is recorded once per account (IntroUsed, set in the
// same transaction that takes it, given back only when its run delivered
// nothing), and it's checked before this, so deleting and uploading again
// can't win a second one.
func (s *Service) onFirstProject(ctx context.Context, uid string) bool {
	n, err := s.Store.CountOwnProjects(ctx, uid, 2)
	return err == nil && n <= 1
}

// consumeFreePreview takes the free previews a quoted-free run needs;
// false when they're gone (the run is then priced normally).
func (s *Service) consumeFreePreview(ctx context.Context, conv *store.Conversion) bool {
	units := 0
	switch v := conv.Quote.Breakdown["free_preview_units"].(type) {
	case int:
		units = v
	case int64:
		units = int(v)
	}
	if units <= 0 {
		units = 1
	}
	at := s.accountTier(ctx, conv.UID)
	r := s.rates(ctx)
	day := time.Now().UTC().Format("2006-01-02")
	intro := at.AllowanceKey == ""
	key := at.PeriodKey
	if intro {
		key = "intro"
	}
	ok, err := s.Store.ConsumeFreePreviews(ctx, conv.UID, key, day, units, r.FreePreviewAllowance(at.AllowanceKey), r.FreePreviewDailyCap(), intro)
	if err != nil || !ok {
		return false
	}
	conv.FreePreview = &store.FreePreview{Units: units, PeriodKey: key, DayKey: day}
	return true
}

type noFreeKey struct{}

// withoutFree re-quotes a run whose free previews ran out meanwhile.
func withoutFree(ctx context.Context) context.Context {
	return context.WithValue(ctx, noFreeKey{}, true)
}

func allowFree(ctx context.Context) bool { return ctx.Value(noFreeKey{}) == nil }

// maxActiveFor is the account's concurrent-run cap: a plan's when higher.
func (s *Service) maxActiveFor(ctx context.Context, uid string, base int) int {
	if at := s.accountTier(ctx, uid); at.Plan != nil {
		if p, ok := s.rates(ctx).Plan(at.Tier); ok && p.MaxActiveRuns > base {
			return p.MaxActiveRuns
		}
	}
	return base
}

// tierLabel names a tier for quotes ("Pro", "Business", "Studio").
func tierLabel(t string) string {
	switch t {
	case pricing.TierPro:
		return "Pro"
	case pricing.TierBusiness:
		return "Business"
	case pricing.TierStudio:
		return "Studio"
	}
	return ""
}

// billableOr0 / effectiveFPS: a run's output seconds and frame rate for
// preview units (0 when the project isn't analyzed yet).
func billableOr0(p *store.Project, params store.Params) float64 {
	if p.Probe == nil {
		return 0
	}
	b, err := billableSeconds(p.Probe.NumFrames, p.Probe.FPS, params.FromFrame, params.ToFrame)
	if err != nil {
		return 0
	}
	return b
}

func effectiveFPS(p *store.Project, params store.Params) float64 {
	if params.TargetFPS > 0 {
		return params.TargetFPS
	}
	if p.Probe != nil {
		return p.Probe.PricingFPS() // VFR: the counted rate when higher
	}
	return 0
}
