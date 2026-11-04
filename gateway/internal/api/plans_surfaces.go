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
func (s *Service) attributePlanStart(ctx context.Context, uid, product, source, key string, at time.Time) {
	if s.Store == nil || uid == "" {
		return
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
		t := last.At
		pc.ClickAt = &t
	}
	if _, err := s.Store.AddPlanConversion(ctx, key, pc); err != nil {
		slog.WarnContext(ctx, "plan attribution not stored", "uid", uid, "key", key, "err", err)
	}
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

func plansSurfaceReport(events []store.Event, convs []store.PlanConversion) map[string]any {
	type row struct {
		views, dismissals, clicks, conversions int
		viewers                                map[string]bool
		byProduct                              map[string]int
	}
	rows := map[string]*row{}
	get := func(p string) *row {
		if rows[p] == nil {
			rows[p] = &row{viewers: map[string]bool{}, byProduct: map[string]int{"pro": 0, "business": 0, "studio": 0}}
		}
		return rows[p]
	}
	for _, p := range plansPlacements {
		get(p)
	}
	for _, e := range events {
		p, _ := e.Props["placement"].(string)
		if p == "" {
			continue
		}
		r := get(p)
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
	unattributed := map[string]int{"pro": 0, "business": 0, "studio": 0}
	nUnattributed := 0
	for _, c := range convs {
		if c.Placement == "" {
			unattributed[c.Product]++
			nUnattributed++
			continue
		}
		r := get(c.Placement)
		r.conversions++
		r.byProduct[c.Product]++
	}
	rate := func(a, b int) float64 {
		if b == 0 {
			return 0
		}
		return math.Round(float64(a)/float64(b)*10000) / 10000
	}
	names := make([]string, 0, len(rows))
	for p := range rows {
		names = append(names, p)
	}
	sort.Strings(names)
	list := make([]map[string]any, 0, len(names))
	for _, p := range names {
		r := rows[p]
		list = append(list, map[string]any{"placement": p, "views": r.views, "viewers": len(r.viewers), "dismissals": r.dismissals,
			"clicks": r.clicks, "conversions": r.conversions, "conversions_by_product": r.byProduct,
			"click_rate": rate(r.clicks, r.views), "conversion_rate": rate(r.conversions, r.clicks)})
	}
	return map[string]any{"placements": list, "unattributed": map[string]any{"conversions": nUnattributed, "by_product": unattributed}}
}

// ------------------------------------------------------------ dismissed

// dismissedPatch is PATCH /v1/account/settings dismissed {placement: true
// (now) | RFC 3339 time | null (clear)}.
func parseDismissed(raw json.RawMessage, now time.Time) (map[string]*time.Time, *httpx.APIError) {
	if len(raw) == 0 {
		return nil, nil
	}
	var in map[string]json.RawMessage
	if json.Unmarshal(raw, &in) != nil || len(in) > len(plansPlacements) {
		return nil, httpx.ErrInvalid("dismissed is {placement: true | time | null}")
	}
	out := map[string]*time.Time{}
	for k, v := range in {
		if !slices.Contains(plansPlacements, k) {
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
