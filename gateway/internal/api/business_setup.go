package api

import (
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Business/Studio setup on /account (owner 2026-11-04): funnel events,
// the setup's answers on the account (settings.business_setup) and the
// admin's funnel report.

var businessSteps = []string{"business_setup_opened", "business_setup_plan_picked", "business_setup_details_done",
	"business_setup_checkout_started", "business_setup_purchased"}

var businessMainUses = []string{"client_work", "own_channel", "stock", "other"}

var teamSizeRE = regexp.MustCompile(`^[0-9a-z+-]{1,12}$`)

func init() {
	for _, n := range businessSteps {
		eventValidators[n] = func(in map[string]any) (map[string]any, bool) {
			out := map[string]any{}
			if v, ok := in["plan"]; ok && v != nil {
				if v != "business" && v != "studio" {
					return nil, false
				}
				out["plan"] = v
			}
			return out, true
		}
	}
}

// businessSetupPatch is PATCH /v1/account/settings business_setup
// {team_size?, main_use?, headsets?}; null clears the answers.
func parseBusinessSetup(raw json.RawMessage, now time.Time) (*store.BusinessSetup, bool, *httpx.APIError) {
	if len(raw) == 0 {
		return nil, false, nil
	}
	if string(raw) == "null" {
		return nil, true, nil
	}
	var in struct {
		TeamSize any      `json:"team_size"`
		MainUse  string   `json:"main_use"`
		Headsets []string `json:"headsets"`
	}
	if json.Unmarshal(raw, &in) != nil {
		return nil, false, httpx.ErrInvalid("business_setup is {team_size?, main_use?, headsets?}")
	}
	bs := &store.BusinessSetup{UpdatedAt: now}
	switch v := in.TeamSize.(type) {
	case nil:
	case string:
		bs.TeamSize = v
	case float64:
		bs.TeamSize = strconv.Itoa(int(v))
	}
	if bs.TeamSize != "" && !teamSizeRE.MatchString(bs.TeamSize) {
		return nil, false, httpx.ErrInvalid("business_setup.team_size is a number or a range such as 2-5 or 20+")
	}
	if in.MainUse != "" && !slices.Contains(businessMainUses, in.MainUse) {
		return nil, false, httpx.ErrInvalid("business_setup.main_use is client_work, own_channel, stock or other")
	}
	bs.MainUse = in.MainUse
	if len(in.Headsets) > maxHeadsets {
		return nil, false, httpx.ErrInvalid("business_setup.headsets: at most 12")
	}
	for _, h := range in.Headsets {
		if !slugRE.MatchString(h) {
			return nil, false, httpx.ErrInvalid("business_setup.headsets are ids such as avp or quest")
		}
	}
	bs.Headsets = dedupe(in.Headsets)
	return bs, true, nil
}

func businessSetupJSON(c *store.Customer) any {
	if c == nil || c.BusinessSetup == nil {
		return nil
	}
	b := c.BusinessSetup
	out := map[string]any{"headsets": append([]string{}, b.Headsets...), "updated_at": b.UpdatedAt.UTC().Format(time.RFC3339)}
	out["team_size"], out["main_use"] = nilIfEmpty(b.TeamSize), nilIfEmpty(b.MainUse)
	return out
}

// GET /v1/admin/onboarding/business_funnel?days=30 → {days, steps[{step,
// people, events, rate_from_previous}], by_plan[{step, plan, people}],
// answers {accounts, by_main_use[{main_use, count}], by_team_size[{team_size,
// count}]}, generated_at}. people = distinct accounts per step;
// rate_from_previous = people ÷ the previous step's people (4 decimals, 0
// for the first or when the previous is 0).
func (s *Service) HandleAdminBusinessFunnel(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	days := 30
	if v, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil && v > 0 && v <= 365 {
		days = v
	}
	now := time.Now().UTC()
	since := now.AddDate(0, 0, -days)
	var events []store.Event
	for _, n := range businessSteps {
		evs, err := s.Store.ListEventsSince(ctx, n, since, 50000)
		if err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
		events = append(events, evs...)
	}
	answers, err := s.Store.ListBusinessSetupsSince(ctx, since, 20000)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	out := businessFunnelReport(events, answers)
	out["days"], out["generated_at"] = days, now.Format(time.RFC3339)
	s.audit(ctx, a, "business_funnel", map[string]any{"days": days})
	httpx.WriteOK(w, out)
}

func businessFunnelReport(events []store.Event, answers []store.BusinessSetup) map[string]any {
	people := map[string]map[string]bool{}
	count := map[string]int{}
	type pk struct{ step, plan string }
	byPlan := map[pk]map[string]bool{}
	for _, e := range events {
		if people[e.Name] == nil {
			people[e.Name] = map[string]bool{}
		}
		people[e.Name][e.UID] = true
		count[e.Name]++
		if p, _ := e.Props["plan"].(string); p != "" {
			k := pk{e.Name, p}
			if byPlan[k] == nil {
				byPlan[k] = map[string]bool{}
			}
			byPlan[k][e.UID] = true
		}
	}
	steps := []map[string]any{}
	prev := 0
	for i, n := range businessSteps {
		cur := len(people[n])
		rate := 0.0
		if i > 0 && prev > 0 {
			rate = surfaceRate(cur, prev)
		}
		steps = append(steps, map[string]any{"step": n, "people": cur, "events": count[n], "rate_from_previous": rate})
		prev = cur
	}
	planRows := []map[string]any{}
	for k, uids := range byPlan {
		planRows = append(planRows, map[string]any{"step": k.step, "plan": k.plan, "people": len(uids)})
	}
	order := func(step string) int { return slices.Index(businessSteps, step) }
	sort.Slice(planRows, func(i, j int) bool {
		if planRows[i]["step"] != planRows[j]["step"] {
			return order(planRows[i]["step"].(string)) < order(planRows[j]["step"].(string))
		}
		return planRows[i]["plan"].(string) < planRows[j]["plan"].(string)
	})
	uses, sizes := map[string]int{}, map[string]int{}
	for _, a := range answers {
		if a.MainUse != "" {
			uses[a.MainUse]++
		}
		if a.TeamSize != "" {
			sizes[a.TeamSize]++
		}
	}
	rows := func(m map[string]int, key string) []map[string]any {
		out := []map[string]any{}
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			out = append(out, map[string]any{key: k, "count": m[k]})
		}
		return out
	}
	// The web admin's shape: business_setup[{step, people, by_plan
	// {business, studio}}].
	setup := []map[string]any{}
	for _, n := range businessSteps {
		bp := map[string]int{"business": len(byPlan[pk{n, "business"}]), "studio": len(byPlan[pk{n, "studio"}])}
		setup = append(setup, map[string]any{"step": n, "people": len(people[n]), "by_plan": bp})
	}
	return map[string]any{"steps": steps, "by_plan": planRows, "business_setup": setup,
		"answers": map[string]any{"accounts": len(answers), "by_main_use": rows(uses, "main_use"), "by_team_size": rows(sizes, "team_size")}}
}
