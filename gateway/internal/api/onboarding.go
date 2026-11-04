package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"sync"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Onboarding (owner 2026-11-04): account state behind the web's welcome,
// Get started list, first-project tips and first-time hints, all on the
// account (GET/PATCH /v1/account/settings); our own product events (POST
// /v1/events, allow-listed); the admin's headset answers.

var slugRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,59}$`)

const (
	maxHeadsets  = 12
	maxHintsAdd  = 30
	maxHintsSeen = 200
)

// onboardingPatch is PATCH /v1/account/settings's onboarding part.
type onboardingPatch struct {
	Headsets     *[]string `json:"headsets"`
	HintsSeenAdd []string  `json:"hints_seen_add"`
	Onboarding   *struct {
		WelcomeDone       *bool `json:"welcome_done"`
		ChecklistHidden   *bool `json:"checklist_hidden"`
		TipsDone          *bool `json:"tips_done"`
		AppProWelcomeDone *bool `json:"app_pro_welcome_done"`
	} `json:"onboarding"`
}

func (p *onboardingPatch) validate() *httpx.APIError {
	if p.Headsets != nil {
		if len(*p.Headsets) > maxHeadsets {
			return httpx.ErrInvalid("headsets: at most 12")
		}
		for _, h := range *p.Headsets {
			if !slugRE.MatchString(h) {
				return httpx.ErrInvalid("headsets are ids such as vision_pro or quest")
			}
		}
	}
	if len(p.HintsSeenAdd) > maxHintsAdd {
		return httpx.ErrInvalid("hints_seen_add: at most 30 at a time")
	}
	for _, h := range p.HintsSeenAdd {
		if !slugRE.MatchString(h) {
			return httpx.ErrInvalid("hints_seen_add holds hint ids such as projects or billing")
		}
	}
	return nil
}

func (p *onboardingPatch) apply(c *store.Customer) {
	if p.Headsets != nil {
		c.Headsets, c.HeadsetsSet = dedupe(*p.Headsets), true
	}
	for _, h := range p.HintsSeenAdd {
		if !slices.Contains(c.HintsSeen, h) && len(c.HintsSeen) < maxHintsSeen {
			c.HintsSeen = append(c.HintsSeen, h)
		}
	}
	if o := p.Onboarding; o != nil {
		if c.Onboarding == nil {
			c.Onboarding = &store.Onboarding{}
		}
		if o.WelcomeDone != nil {
			v := *o.WelcomeDone
			c.Onboarding.WelcomeDone = &v
		}
		if o.ChecklistHidden != nil {
			c.Onboarding.ChecklistHidden = *o.ChecklistHidden
		}
		if o.TipsDone != nil {
			c.Onboarding.TipsDone = *o.TipsDone
		}
		if o.AppProWelcomeDone != nil {
			c.Onboarding.AppProWelcomeDone = *o.AppProWelcomeDone
		}
	}
}

func (p *onboardingPatch) any() bool {
	return p.Headsets != nil || len(p.HintsSeenAdd) > 0 || p.Onboarding != nil
}

func dedupe(in []string) []string {
	out := make([]string, 0, len(in))
	for _, v := range in {
		if !slices.Contains(out, v) {
			out = append(out, v)
		}
	}
	return out
}

// onboardingSettings is GET /v1/account/settings's onboarding part. The
// steps are worked out here, the sample project left out.
func (s *Service) onboardingSettings(ctx context.Context, uid string, cust *store.Customer) map[string]any {
	projects, _ := s.Store.ListUserProjects(ctx, uid, 50)
	convs, _ := s.Store.ListUserConversions(ctx, uid, 200)
	steps := map[string]bool{"first_video": false, "first_preview": false, "first_3d": false, "watched": false}
	for _, p := range projects {
		if !p.Sample && !p.Deleted {
			steps["first_video"] = true
		}
	}
	for _, c := range convs {
		if c.Sample || c.ProjectID == "" || c.State != store.StateSucceeded {
			continue
		}
		switch c.Step {
		case store.StepProduction:
			steps["first_3d"] = true
		case store.StepLifelikePreview, store.StepStereoPreview, store.StepDepthPreview:
			steps["first_preview"] = true
		}
	}
	welcome := existingAccount(cust, projects) // accounts from before onboarding
	ob := map[string]any{"checklist_hidden": false, "tips_done": false, "steps": steps}
	var headsets any
	hints := []string{}
	if cust != nil {
		steps["watched"] = cust.FirstWatchedAt != nil
		if o := cust.Onboarding; o != nil {
			if o.WelcomeDone != nil {
				welcome = *o.WelcomeDone
			}
			ob["checklist_hidden"], ob["tips_done"] = o.ChecklistHidden, o.TipsDone
		}
		if cust.HeadsetsSet {
			headsets = append([]string{}, cust.Headsets...)
		}
		if len(cust.HintsSeen) > 0 {
			hints = cust.HintsSeen
		}
	}
	ob["welcome_done"] = welcome
	s.appOnboarding(ctx, uid, cust, ob) // variant, app_pro_welcome_done, headsets_from_app
	return map[string]any{"headsets": headsets, "hints_seen": hints, "onboarding": ob}
}

// watchedNoted: uids already marked this instance (saves a read per play).
var watchedNoted sync.Map

// noteWatched marks the account's first play or download of a run of its
// own (the Get started list's last step); the sample doesn't count.
func (s *Service) noteWatched(ctx context.Context, c *store.Conversion) {
	if c == nil || c.Sample || c.ProjectID == "" || s.Store == nil {
		return
	}
	if _, done := watchedNoted.Load(c.UID); done {
		return
	}
	now := time.Now().UTC()
	_, err := s.Store.UpdateCustomer(ctx, c.UID, func(cu *store.Customer) error {
		if cu.FirstWatchedAt == nil {
			cu.FirstWatchedAt = &now
		}
		return nil
	})
	if err == nil {
		watchedNoted.Store(c.UID, true)
	}
}

// ------------------------------------------------------------- events

const (
	eventBodyMax   = 4 << 10
	eventsPerHour  = 30
	eventRateEvery = time.Hour
)

// eventValidators: the allow-list. Each returns the props to store
// (cleaned) or false to refuse the event.
var eventValidators = map[string]func(map[string]any) (map[string]any, bool){
	// A sign-in on the web, by method (ADR 0136: passkey adoption). The
	// gateway logs passkey sign-ins itself; the web logs the others.
	"sign_in": func(in map[string]any) (map[string]any, bool) {
		m, _ := in["method"].(string)
		switch m {
		case "google", "apple", "email", "password", "email_code":
			return map[string]any{"method": m}, true
		}
		return nil, false
	},
	// The welcome's first question: where they'll watch (several allowed),
	// the plan at the time and where it was asked.
	"onboarding_headsets": func(in map[string]any) (map[string]any, bool) {
		raw, _ := in["devices"].([]any)
		if len(raw) == 0 || len(raw) > maxHeadsets {
			return nil, false
		}
		devices := []string{}
		for _, d := range raw {
			v, ok := d.(string)
			if !ok || !slugRE.MatchString(v) {
				return nil, false
			}
			if !slices.Contains(devices, v) {
				devices = append(devices, v)
			}
		}
		out := map[string]any{"devices": devices, "variant": variantDefault}
		for _, k := range []string{"plan", "source"} {
			if v, ok := in[k].(string); ok && slugRE.MatchString(v) {
				out[k] = v
			}
		}
		if v, ok := in["variant"]; ok && v != nil {
			if v != variantDefault && v != variantAppPro {
				return nil, false
			}
			out["variant"] = v
		}
		return out, true
	},
}

type eventRate struct {
	mu    sync.Mutex
	times []time.Time
}

var eventRates sync.Map // uid → *eventRate

// eventAllowed: at most limit an hour per key (account, or account and
// event family) per instance.
func eventAllowed(key string, limit int, now time.Time) bool {
	v, _ := eventRates.LoadOrStore(key, &eventRate{})
	r := v.(*eventRate)
	r.mu.Lock()
	defer r.mu.Unlock()
	keep := r.times[:0]
	for _, t := range r.times {
		if now.Sub(t) < eventRateEvery {
			keep = append(keep, t)
		}
	}
	r.times = keep
	if len(r.times) >= limit {
		return false
	}
	r.times = append(r.times, now)
	return true
}

// POST /v1/events {name, props} → {logged: true}. Allow-listed names only
// (400 unknown_event), a 4 KB body, 30 an hour per account (429); the
// plans_surface_* events have 120 an hour of their own.
func (s *Service) HandleEvents(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		Name  string         `json:"name"`
		Props map[string]any `json:"props"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, eventBodyMax)).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed or oversized JSON body (4 KB at most)"))
		return
	}
	validate, ok := eventValidators[req.Name]
	if !ok {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "unknown_event", "this event name isn't recorded"))
		return
	}
	props, ok := validate(req.Props)
	if !ok {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("props don't match the event"))
		return
	}
	now := time.Now().UTC()
	key, limit := user.UID, eventsPerHour
	if isPlansSurfaceEvent(req.Name) {
		key, limit = user.UID+"|plans", plansEventsPerHour // their own allowance
	}
	if !eventAllowed(key, limit, now) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusTooManyRequests, "rate_limited", "too many events; try again later"))
		return
	}
	if err := s.Store.AddEvent(ctx, store.Event{UID: user.UID, Name: req.Name, Props: props, At: now}); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.WriteOK(w, map[string]any{"logged": true})
}

// ------------------------------------------------------------- admin

// GET /v1/admin/onboarding/headsets?days=30 → {days, by_day[{day, device,
// count}], by_plan[{plan, device, count}], conversion[{device, people,
// converted}], generated_at}. A person counts once per device (per day in
// by_day, per plan in by_plan). converted: paid for a full run (a
// succeeded production run with a price, the sample aside) after their
// first answer.
func (s *Service) HandleAdminOnboardingHeadsets(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	days := 30
	if v, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil && v > 0 && v <= 365 {
		days = v
	}
	now := time.Now().UTC()
	events, err := s.Store.ListEventsSince(ctx, "onboarding_headsets", now.AddDate(0, 0, -days), 20000)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	out := s.headsetReport(ctx, events)
	out["days"], out["generated_at"] = days, now.Format(time.RFC3339)
	// The Business/Studio setup funnel, as the web admin's onboarding view
	// reads it (also at /v1/admin/onboarding/business_funnel).
	var bevents []store.Event
	for _, n := range businessSteps {
		if evs, berr := s.Store.ListEventsSince(ctx, n, now.AddDate(0, 0, -days), 50000); berr == nil {
			bevents = append(bevents, evs...)
		}
	}
	out["business_setup"] = businessFunnelReport(bevents, nil)["business_setup"]
	s.audit(ctx, a, "onboarding_headsets", map[string]any{"days": days})
	httpx.WriteOK(w, out)
}

func (s *Service) headsetReport(ctx context.Context, events []store.Event) map[string]any {
	type dayKey struct{ day, device string }
	type planKey struct{ plan, device string }
	byDay, byPlan := map[dayKey]map[string]bool{}, map[planKey]map[string]bool{}
	byVariant := map[planKey]map[string]bool{} // variant, device
	people := map[string]map[string]bool{}     // device → uids
	firstAt := map[string]time.Time{}
	for _, e := range events {
		devices, _ := e.Props["devices"].([]any)
		plan, _ := e.Props["plan"].(string)
		if plan == "" {
			plan = "none"
		}
		variant, _ := e.Props["variant"].(string)
		if variant == "" {
			variant = variantDefault // answers from before the variant
		}
		if t, ok := firstAt[e.UID]; !ok || e.At.Before(t) {
			firstAt[e.UID] = e.At
		}
		for _, d := range devices {
			dev, _ := d.(string)
			if dev == "" {
				continue
			}
			add := func(m map[string]bool) map[string]bool {
				if m == nil {
					m = map[string]bool{}
				}
				m[e.UID] = true
				return m
			}
			dk, pk := dayKey{e.At.UTC().Format("2006-01-02"), dev}, planKey{plan, dev}
			vk := planKey{variant, dev}
			byDay[dk], byPlan[pk], people[dev] = add(byDay[dk]), add(byPlan[pk]), add(people[dev])
			byVariant[vk] = add(byVariant[vk])
		}
	}
	converted := map[string]bool{}
	for uid, at := range firstAt {
		converted[uid] = s.paidFullRunSince(ctx, uid, at)
	}
	dayRows := []map[string]any{}
	for k, uids := range byDay {
		dayRows = append(dayRows, map[string]any{"day": k.day, "device": k.device, "count": len(uids)})
	}
	sort.Slice(dayRows, func(i, j int) bool {
		if dayRows[i]["day"] != dayRows[j]["day"] {
			return dayRows[i]["day"].(string) < dayRows[j]["day"].(string)
		}
		return dayRows[i]["device"].(string) < dayRows[j]["device"].(string)
	})
	planRows := []map[string]any{}
	for k, uids := range byPlan {
		planRows = append(planRows, map[string]any{"plan": k.plan, "device": k.device, "count": len(uids)})
	}
	sort.Slice(planRows, func(i, j int) bool {
		if planRows[i]["plan"] != planRows[j]["plan"] {
			return planRows[i]["plan"].(string) < planRows[j]["plan"].(string)
		}
		return planRows[i]["device"].(string) < planRows[j]["device"].(string)
	})
	variantRows := []map[string]any{}
	for k, uids := range byVariant {
		n := 0
		for uid := range uids {
			if converted[uid] {
				n++
			}
		}
		variantRows = append(variantRows, map[string]any{"variant": k.plan, "device": k.device, "count": len(uids), "converted": n})
	}
	sort.Slice(variantRows, func(i, j int) bool {
		if variantRows[i]["variant"] != variantRows[j]["variant"] {
			return variantRows[i]["variant"].(string) < variantRows[j]["variant"].(string)
		}
		return variantRows[i]["device"].(string) < variantRows[j]["device"].(string)
	})
	convRows := []map[string]any{}
	for dev, uids := range people {
		n := 0
		for uid := range uids {
			if converted[uid] {
				n++
			}
		}
		convRows = append(convRows, map[string]any{"device": dev, "people": len(uids), "converted": n})
	}
	sort.Slice(convRows, func(i, j int) bool { return convRows[i]["device"].(string) < convRows[j]["device"].(string) })
	return map[string]any{"by_day": dayRows, "by_plan": planRows, "by_variant": variantRows, "conversion": convRows}
}

// paidFullRunSince: the account paid for a full run (production, not the
// sample, succeeded, priced) made after t.
func (s *Service) paidFullRunSince(ctx context.Context, uid string, t time.Time) bool {
	convs, err := s.Store.ListUserConversions(ctx, uid, 200)
	if err != nil {
		slog.WarnContext(ctx, "onboarding report: runs unreadable", "uid", uid, "err", err)
		return false
	}
	for _, c := range convs {
		if !c.Sample && c.ProjectID != "" && c.Step == store.StepProduction && c.State == store.StateSucceeded &&
			c.Quote.AmountCents > 0 && !c.CreatedAt.Before(t) {
			return true
		}
	}
	return false
}
