package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Plans surfaces (owner 2026-11-04, the plans/paywall starting set): the
// web reports views, dismissals and clicks of each place it offers the
// plans (POST /v1/events plans_surface_*); a start of Pro, Business or
// Studio records the last click of the 7 days before as the converting
// placement; the admin reads views, dismissals, clicks and conversions per
// placement. Dismissals the web brings back later (projects_banner after
// 7 days) live in /v1/account/settings dismissed.

var plansPlacements = []string{"header", "projects_banner", "quote", "receipt", "plans_sheet",
	"business_note", "business_banner", "plans_hint"}

const (
	plansEventsPerHour = 120
	attributionWindow  = 7 * 24 * time.Hour
	maxQuoteCents      = 100_000_000
)

// targetRE: an id ("checkout_business") or a path on the web ("/plans#studio"),
// never a full URL.
var targetRE = regexp.MustCompile(`^(/[a-z0-9_./#-]{0,79}|[a-z0-9][a-z0-9_.#-]{0,59})$`)

func isPlansSurfaceEvent(name string) bool { return strings.HasPrefix(name, "plans_surface_") }

// plansSurfaceProps: placement required (one of plansPlacements); variant
// and plan ids (60 chars); quote_cents a whole number of cents; target an
// id or path (80 chars). Anything else is dropped.
func plansSurfaceProps(in map[string]any) (map[string]any, bool) {
	placement, _ := in["placement"].(string)
	if !slices.Contains(plansPlacements, placement) {
		return nil, false
	}
	out := map[string]any{"placement": placement}
	for _, k := range []string{"variant", "plan"} {
		if v, ok := in[k].(string); ok {
			if !slugRE.MatchString(v) {
				return nil, false
			}
			out[k] = v
		}
	}
	if v, ok := in["quote_cents"]; ok && v != nil {
		f, isNum := v.(float64)
		if !isNum || f < 0 || f > maxQuoteCents || f != math.Trunc(f) {
			return nil, false
		}
		out["quote_cents"] = int64(f)
	}
	if v, ok := in["reason"].(string); ok {
		// why the surface showed: source_8k | source_fps | quote_size |
		// run_length | company_email (an id of at most 32)
		if len(v) > 32 || !slugRE.MatchString(v) {
			return nil, false
		}
		out["reason"] = v
	}
	if v, ok := in["target"].(string); ok {
		if !targetRE.MatchString(v) || strings.Contains(v, "//") {
			return nil, false
		}
		out["target"] = v
	}
	return out, true
}

func init() {
	for _, n := range []string{"plans_surface_view", "plans_surface_dismiss", "plans_surface_click"} {
		eventValidators[n] = plansSurfaceProps
	}
}

// ------------------------------------------------------------ attribution

// attributePlanStart records a start of product (pro | business | studio)
// once per key, with the last plans_surface_click of the 7 days before.
func (s *Service) attributePlanStart(ctx context.Context, uid, product, source, key string, at time.Time) bool {
	if s.Store == nil || uid == "" {
		return false
	}
	pc := store.PlanConversion{UID: uid, Product: product, Source: source, At: at}
	events, err := s.Store.ListUserEvents(ctx, uid, at.Add(-attributionWindow), 2000)
	if err != nil {
		slog.WarnContext(ctx, "plan attribution: events unreadable", "uid", uid, "err", err)
	}
	var last *store.Event
	for i := range events {
		e := &events[i]
		if e.Name == "plans_surface_click" && !e.At.After(at) && (last == nil || e.At.After(last.At)) {
			last = e
		}
	}
	if last != nil {
		pc.Placement, _ = last.Props["placement"].(string)
		pc.Variant, _ = last.Props["variant"].(string)
		pc.ClickPlan, _ = last.Props["plan"].(string)
		pc.Reason, _ = last.Props["reason"].(string)
		t := last.At
		pc.ClickAt = &t
	}
	added, err := s.Store.AddPlanConversion(ctx, key, pc)
	if err != nil {
		slog.WarnContext(ctx, "plan attribution not stored", "uid", uid, "key", key, "err", err)
	}
	return added
}

// proSeen: the Pro state this instance last stored per uid.
var proSeen sync.Map

// noteProSeen: a person the gateway saw without Pro and now sees with it
// started Pro (bought on the web through RevenueCat, or anywhere else).
// Someone first seen already holding Pro isn't a start.
func (s *Service) noteProSeen(ctx context.Context, uid string, pro bool) {
	if s.Store == nil {
		return
	}
	if v, ok := proSeen.Load(uid); ok && v.(bool) == pro {
		return // unchanged since this instance last looked
	}
	now := time.Now().UTC()
	prev, err := s.Store.SwapProState(ctx, uid, pro, now)
	if err != nil {
		slog.WarnContext(ctx, "pro state not stored", "uid", uid, "err", err)
		return
	}
	proSeen.Store(uid, pro)
	if pro && prev != nil && !prev.Pro {
		s.attributePlanStart(ctx, uid, "pro", "revenuecat", "pro:"+uid+":"+now.Format("2006-01-02"), now)
	}
}

// ------------------------------------------------------------ admin

// GET /v1/admin/plans/surfaces?days=30 → {days, placements[{placement,
// views, viewers, dismissals, clicks, conversions, conversions_by_product
// {pro, business, studio}, click_rate, conversion_rate}], unattributed
// {conversions, by_product}, generated_at}. Counts are events (views a
// person saw twice count twice; viewers are people). click_rate = clicks
// ÷ views; conversion_rate = conversions ÷ clicks (0 when none).
func (s *Service) HandleAdminPlansSurfaces(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	days := 30
	if v, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil && v > 0 && v <= 365 {
		days = v
	}
	now := time.Now().UTC()
	since := now.AddDate(0, 0, -days)
	var events []store.Event
	for _, n := range []string{"plans_surface_view", "plans_surface_dismiss", "plans_surface_click"} {
		evs, err := s.Store.ListEventsSince(ctx, n, since, 50000)
		if err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
		events = append(events, evs...)
	}
	convs, err := s.Store.ListPlanConversionsSince(ctx, since, 10000)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	out := plansSurfaceReport(events, convs)
	out["days"], out["generated_at"] = days, now.Format(time.RFC3339)
	s.audit(ctx, a, "plans_surfaces", map[string]any{"days": days})
	httpx.WriteOK(w, out)
}

// surfaceRow accumulates one placement, or one reason within it.
type surfaceRow struct {
	views, dismissals, clicks, conversions int
	viewers                                map[string]bool
	byProduct                              map[string]int
}

func newSurfaceRow() *surfaceRow {
	return &surfaceRow{viewers: map[string]bool{}, byProduct: map[string]int{"pro": 0, "business": 0, "studio": 0}}
}

func (r *surfaceRow) add(e store.Event) {
	switch e.Name {
	case "plans_surface_view":
		r.views++
		r.viewers[e.UID] = true
	case "plans_surface_dismiss":
		r.dismissals++
	case "plans_surface_click":
		r.clicks++
	}
}

func surfaceRate(a, b int) float64 {
	if b == 0 {
		return 0
	}
	return math.Round(float64(a)/float64(b)*10000) / 10000
}

func (r *surfaceRow) json() map[string]any {
	return map[string]any{"views": r.views, "viewers": len(r.viewers), "dismissals": r.dismissals, "clicks": r.clicks,
		"conversions": r.conversions, "conversions_by_product": r.byProduct, "click_rate": surfaceRate(r.clicks, r.views)}
}

func plansSurfaceReport(events []store.Event, convs []store.PlanConversion) map[string]any {
	rows := map[string]*surfaceRow{}
	reasons := map[string]map[string]*surfaceRow{} // placement → reason → row
	get := func(p string) *surfaceRow {
		if rows[p] == nil {
			rows[p], reasons[p] = newSurfaceRow(), map[string]*surfaceRow{}
		}
		return rows[p]
	}
	getReason := func(p, reason string) *surfaceRow {
		get(p)
		if reason == "" {
			reason = "none"
		}
		if reasons[p][reason] == nil {
			reasons[p][reason] = newSurfaceRow()
		}
		return reasons[p][reason]
	}
	for _, p := range plansPlacements {
		get(p)
	}
	for _, e := range events {
		p, _ := e.Props["placement"].(string)
		if p == "" {
			continue
		}
		reason, _ := e.Props["reason"].(string)
		get(p).add(e)
		getReason(p, reason).add(e)
	}
	unattributed := map[string]int{"pro": 0, "business": 0, "studio": 0}
	nUnattributed := 0
	for _, c := range convs {
		if c.Placement == "" {
			unattributed[c.Product]++
			nUnattributed++
			continue
		}
		for _, r := range []*surfaceRow{get(c.Placement), getReason(c.Placement, c.Reason)} {
			r.conversions++
			r.byProduct[c.Product]++
		}
	}
	names := make([]string, 0, len(rows))
	for p := range rows {
		names = append(names, p)
	}
	sort.Strings(names)
	list := make([]map[string]any, 0, len(names))
	for _, p := range names {
		r := rows[p]
		rs := make([]string, 0, len(reasons[p]))
		for k := range reasons[p] {
			rs = append(rs, k)
		}
		sort.Strings(rs)
		byReason := make([]map[string]any, 0, len(rs))
		for _, k := range rs {
			m := reasons[p][k].json()
			m["placement"], m["reason"] = p, k
			byReason = append(byReason, m)
		}
		m := r.json()
		m["placement"], m["by_reason"], m["conversion_rate"] = p, byReason, surfaceRate(r.conversions, r.clicks)
		list = append(list, m)
	}
	return map[string]any{"placements": list, "unattributed": map[string]any{"conversions": nUnattributed, "by_product": unattributed}}
}

// ------------------------------------------------------------ dismissed

// maxDismissed caps the stored keys (the newest kept).
const maxDismissed = 200

// perProjectDismissals: placements dismissed per project, keyed
// "<placement>:<projectId>".
var perProjectDismissals = []string{"business_note"}

// dismissedProject is the project id of a per-project key ("" for a plain
// placement).
func dismissedProject(k string) string {
	if p, id, ok := strings.Cut(k, ":"); ok && slices.Contains(perProjectDismissals, p) {
		return id
	}
	return ""
}

func validDismissedKey(k string) bool {
	if slices.Contains(plansPlacements, k) || k == passkeySuggestionKey {
		return true
	}
	id := dismissedProject(k)
	return id != "" && ValidResourceID(id)
}

// keepDismissed: the keys to keep, the per-project ones only whose project is the user's,
// not archived and not deleted, and at most maxDismissed keys (newest).
// It reads the projects before the customer update (no reads inside it).
func (s *Service) keepDismissed(ctx context.Context, uid string, keys []string) (map[string]bool, error) {
	ids := []string{}
	for _, k := range keys {
		if id := dismissedProject(k); id != "" && !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	projects, err := s.Store.GetProjectsByID(ctx, ids)
	if err != nil {
		return nil, err
	}
	keep := map[string]bool{}
	for _, k := range keys {
		if id := dismissedProject(k); id == "" {
			keep[k] = true
		} else if p := projects[id]; p != nil && p.UID == uid && !p.Archived && !p.Deleted {
			keep[k] = true
		}
	}
	return keep, nil
}

func capDismissed(m map[string]time.Time) {
	if len(m) <= maxDismissed {
		return
	}
	type kv struct {
		k string
		t time.Time
	}
	all := make([]kv, 0, len(m))
	for k, t := range m {
		all = append(all, kv{k, t})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].t.After(all[j].t) })
	for _, e := range all[maxDismissed:] {
		delete(m, e.k)
	}
}

// dismissedPatch is PATCH /v1/account/settings dismissed {placement: true
// (now) | RFC 3339 time | null (clear)}; business_note also per project
// ("business_note:<projectId>", the user's own project).
func parseDismissed(raw json.RawMessage, now time.Time) (map[string]*time.Time, *httpx.APIError) {
	if len(raw) == 0 {
		return nil, nil
	}
	var in map[string]json.RawMessage
	if json.Unmarshal(raw, &in) != nil || len(in) > maxDismissed {
		return nil, httpx.ErrInvalid("dismissed is {placement: true | time | null}, at most 200")
	}
	out := map[string]*time.Time{}
	for k, v := range in {
		if !validDismissedKey(k) {
			return nil, httpx.ErrInvalid("dismissed: unknown placement " + strconv.Quote(k))
		}
		switch s := strings.TrimSpace(string(v)); {
		case s == "null":
			out[k] = nil
		case s == "true":
			t := now
			out[k] = &t
		default:
			var str string
			t, err := time.Time{}, error(nil)
			if json.Unmarshal(v, &str) == nil {
				t, err = time.Parse(time.RFC3339, str)
			} else {
				err = strconv.ErrSyntax
			}
			if err != nil {
				return nil, httpx.ErrInvalid("dismissed values are true, an RFC 3339 time or null")
			}
			t = t.UTC()
			if t.After(now) {
				t = now
			}
			out[k] = &t
		}
	}
	return out, nil
}

func dismissedJSON(c *store.Customer) map[string]string {
	out := map[string]string{}
	if c == nil {
		return out
	}
	for k, t := range c.Dismissed {
		out[k] = t.UTC().Format(time.RFC3339)
	}
	return out
}
