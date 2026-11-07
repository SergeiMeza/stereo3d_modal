package api

import (
	"net/http"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// campaignCentsOf is a run's launch-offer line (0 without one).
func campaignCentsOf(c *store.Conversion) int64 {
	switch v := c.Quote.Breakdown["campaign_cents"].(type) {
	case int64:
		return v
	case float64:
		return int64(v)
	case int:
		return int64(v)
	}
	return 0
}

// campaignLine is a run's launch-offer cents and its label ("Launch
// offer −25%"); 0, "" without one.
func campaignLine(c *store.Conversion) (int64, string) {
	cents := campaignCentsOf(c)
	if cents <= 0 {
		return 0, ""
	}
	label, _ := c.Quote.Breakdown["campaign_label"].(string)
	return cents, label
}

// GET /v1/admin/campaign → {campaign, totals {runs, quoted_cents,
// discounted_runs, discounted_cents, by_state {state: {runs, cents}}},
// by_month [{month, runs, cents}], truncated}: the launch offer's config
// and what it gave. discounted_* counts the runs that went through
// (succeeded); quoted_* every run created with it.
func (s *Service) HandleAdminCampaign(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	const limit = 5000
	runs, err := s.Store.ListCampaignRuns(ctx, limit)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	byState := map[string]map[string]int64{}
	months := map[string]map[string]int64{}
	var quoted, quotedRuns, done, doneRuns int64
	for _, c := range runs {
		if c.Sample {
			continue
		}
		cents := campaignCentsOf(c)
		if cents <= 0 {
			continue
		}
		quoted += cents
		quotedRuns++
		st := byState[c.State]
		if st == nil {
			st = map[string]int64{}
			byState[c.State] = st
		}
		st["runs"]++
		st["cents"] += cents
		if c.State == store.StateSucceeded {
			done += cents
			doneRuns++
			m := c.CreatedAt.UTC().Format("2006-01")
			if months[m] == nil {
				months[m] = map[string]int64{}
			}
			months[m]["runs"]++
			months[m]["cents"] += cents
		}
	}
	byMonth := []map[string]any{}
	for m, v := range months {
		byMonth = append(byMonth, map[string]any{"month": m, "runs": v["runs"], "cents": v["cents"]})
	}
	sortByKey(byMonth, "month")
	s.audit(ctx, a, "campaign_view", nil)
	httpx.WriteOK(w, map[string]any{
		"campaign": s.Pricing.Rates(ctx).PublicCampaign(time.Now()),
		"totals": map[string]any{"runs": quotedRuns, "quoted_cents": quoted, "discounted_runs": doneRuns, "discounted_cents": done,
			"by_state": byState},
		"by_month": byMonth, "truncated": len(runs) >= limit,
	})
}

func sortByKey(rows []map[string]any, key string) {
	for i := 1; i < len(rows); i++ {
		for j := i; j > 0 && rows[j][key].(string) < rows[j-1][key].(string); j-- {
			rows[j], rows[j-1] = rows[j-1], rows[j]
		}
	}
}
