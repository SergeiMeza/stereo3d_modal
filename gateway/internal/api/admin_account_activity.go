package api

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/auth"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The admin account view's activity (BL-29): account.created_at, runs
// (count and a page of the latest), the current period's usage, and how
// the account signs in.

const adminRunsPage = 20

func (s *Service) signInOf(ctx context.Context, uid string) (*auth.SignInInfo, error) {
	if s.SignInLookup != nil {
		return s.SignInLookup(ctx, uid)
	}
	if s.Auth == nil {
		return nil, nil
	}
	return s.Auth.SignInOf(ctx, uid)
}

// signInMethod names a Firebase provider the way the console shows it.
func signInMethod(provider string) string {
	switch provider {
	case "google.com":
		return "google"
	case "apple.com":
		return "apple"
	case "password":
		return "password"
	case "phone":
		return "phone"
	}
	return strings.TrimSuffix(provider, ".com")
}

func adminRunJSON(c *store.Conversion) map[string]any {
	out := map[string]any{"id": c.ID, "project_id": nilIfEmpty(c.ProjectID), "status": c.State, "kind": c.Kind,
		"created_at": c.CreatedAt, "amount_cents": c.Quote.AmountCents, "formats_added": repacksHistory(c),
		"bars_removed": runBarsJSON(c), "presentment": c.Stripe.Presentment}
	addRunMedia(out, c)
	return out
}

// addRunMedia adds what the run read sends of its encode (the console's
// run rows): quality (standard | high | master, web Lifelike),
// commercial and commercial_included (Commercial use),
// bitrate_requested (projects' runs: auto, match_source, Mbit/s or
// master), outputs_media and the worker's output_bit_depth (+ reason).
func addRunMedia(out map[string]any, c *store.Conversion) {
	out["campaign_cents"] = campaignCentsOf(c) // the launch offer's line, 0 without
	out["campaign_cents"] = campaignCentsOf(c) // the launch offer's line, 0 without
	out["quality"] = nilIfEmpty(c.Params.OutputQuality)
	// Commercial use (owner 2026-11-09): both, on Lifelike runs only, so the
	// console can say "no" there and nothing on runs that can't have it
	if c.Method == store.MethodLifelike {
		out["commercial"], out["commercial_included"] = c.Params.Commercial, c.Params.CommercialIncluded
	}
	out["bitrate_requested"] = nil
	if c.ProjectID != "" {
		req := c.Params.Bitrate
		if req == "" {
			req = "auto"
		}
		out["bitrate_requested"] = req
	}
	out["outputs_media"] = nil
	if len(c.OutputsMedia) > 0 {
		out["outputs_media"] = c.OutputsMedia
	}
	if c.Modal.OutputBitDepth > 0 {
		out["output_bit_depth"] = c.Modal.OutputBitDepth
	}
	if c.Modal.OutputBitDepthReason != "" {
		out["output_bit_depth_reason"] = c.Modal.OutputBitDepthReason
	}
}

func (s *Service) adminAccountActivity(r *http.Request, uid string, cust *store.Customer, passkeys int, out map[string]any) {
	ctx := r.Context()
	now := time.Now().UTC()
	q := r.URL.Query()
	if acc, ok := out["account"].(map[string]any); ok {
		acc["created_at"] = nil
		if !cust.CreatedAt.IsZero() {
			acc["created_at"] = cust.CreatedAt
		}
	}

	// Runs: count, then a page newest first (?runs_before=<created_at of
	// the last row>&runs_limit=1..100).
	limit := adminRunsPage
	if v, err := strconv.Atoi(q.Get("runs_limit")); err == nil && v > 0 && v <= 100 {
		limit = v
	}
	var before time.Time
	if v := q.Get("runs_before"); v != "" {
		before, _ = time.Parse(time.RFC3339Nano, v)
	}
	runs := map[string]any{"count": nil, "items": []map[string]any{}, "next_before": nil}
	if n, err := s.Store.CountUserConversions(ctx, uid); err == nil {
		runs["count"] = n
	}
	if page, err := s.Store.ListUserConversionsPage(ctx, uid, before, limit+1); err == nil {
		items := make([]map[string]any, 0, limit)
		for i, c := range page {
			if i == limit {
				runs["next_before"] = page[limit-1].CreatedAt.Format(time.RFC3339Nano)
				break
			}
			items = append(items, adminRunJSON(c))
		}
		runs["items"] = items
	}
	out["runs"] = runs

	// Usage in the current period: the plan's, else the calendar month.
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	end, period := start.AddDate(0, 1, 0), "month"
	if p := cust.Plan; p != nil && p.Active(now) && p.CurrentPeriodStart != nil && p.CurrentPeriodEnd != nil {
		start, end, period = *p.CurrentPeriodStart, *p.CurrentPeriodEnd, "plan"
	}
	usage := map[string]any{"period": period, "period_start": start, "period_end": end}
	if rs, err := s.Store.ListUserConversionsSince(ctx, uid, start, 2000); err == nil {
		var succeeded, previews int
		var spent int64
		for _, c := range rs {
			if c.State == store.StateSucceeded {
				succeeded++
				spent += c.Quote.AmountCents
			}
			if c.FreePreview != nil {
				previews++
			}
		}
		usage["runs"], usage["succeeded"], usage["spent_cents"], usage["free_preview_runs"] = len(rs), succeeded, spent, previews
	}
	at := s.accountTier(ctx, uid)
	usage["tier"] = nilIfEmpty(at.Tier)
	usage["free_previews"] = s.freePreviewStatus(ctx, uid, at, 0).JSON()
	if p := cust.Plan; p != nil && p.Active(now) {
		if def, ok := s.rates(ctx).Plan(p.Tier); ok && def.CreditCents > 0 {
			usage["plan_credit_cents"] = def.CreditCents
			if b, err := s.Store.GetBalance(ctx, uid); err == nil && b.Exists() {
				left := b.PlanCreditCents()
				usage["plan_credit_left_cents"] = left
				usage["plan_credit_used_cents"] = max(def.CreditCents-left, 0)
			}
		}
	}
	out["usage"] = usage

	// Sign-in: Firebase's providers plus passkeys.
	si := map[string]any{"methods": nil, "passkey_count": passkeys, "firebase_created_at": nil, "last_sign_in_at": nil}
	if info, err := s.signInOf(ctx, uid); err == nil && info != nil {
		methods := []string{}
		for _, p := range info.Providers {
			methods = append(methods, signInMethod(p))
		}
		if passkeys > 0 {
			methods = append(methods, "passkey")
		}
		si["methods"] = methods
		if !info.CreatedAt.IsZero() {
			si["firebase_created_at"] = info.CreatedAt
		}
		if !info.LastSignIn.IsZero() {
			si["last_sign_in_at"] = info.LastSignIn
		}
	}
	out["sign_in"] = si
}
