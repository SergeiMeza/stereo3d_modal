package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func TestPlansSurfaceEvents(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	post := func(body string) (int, map[string]any) {
		return callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleEvents(w, r, &AuthedUser{UID: uid}) }, "POST", body)
	}
	for _, bad := range []string{
		`{"name":"plans_surface_view","props":{"placement":"footer"}}`,
		`{"name":"plans_surface_click","props":{"placement":"quote","quote_cents":12.5}}`,
		`{"name":"plans_surface_click","props":{"placement":"quote","variant":"Big Blue"}}`,
		`{"name":"plans_surface_click","props":{"placement":"quote","target":"https://evil.example"}}`,
	} {
		if code, _ := post(bad); code != 400 {
			t.Fatalf("%s: %d", bad, code)
		}
	}
	code, _ := post(`{"name":"plans_surface_click","props":{"placement":"quote","variant":"a","plan":"business","quote_cents":4200,"target":"/plans#business","note":"x"}}`)
	if code != 200 {
		t.Fatalf("click %d", code)
	}
	evs, _ := s.Store.ListUserEvents(ctx, uid, time.Now().Add(-time.Minute), 10)
	if len(evs) != 1 || fmt.Sprint(evs[0].Props) != "map[placement:quote plan:business quote_cents:4200 target:/plans#business variant:a]" {
		t.Fatalf("stored %+v", evs)
	}
	// 120 an hour of their own: the onboarding allowance is untouched
	n := 1
	for ; n < 130; n++ {
		if code, _ := post(`{"name":"plans_surface_view","props":{"placement":"header"}}`); code == 429 {
			break
		}
	}
	if n != plansEventsPerHour {
		t.Fatalf("plans limit after %d", n)
	}
	if code, _ := post(`{"name":"onboarding_headsets","props":{"devices":["quest"]}}`); code != 200 {
		t.Fatalf("onboarding after plans limit: %d", code)
	}
}

// A start of Pro/Business/Studio records the last click of the 7 days
// before, once per key; Pro counts only as a change from not-Pro.
func TestPlanAttribution(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	now := time.Now().UTC()
	click := func(placement string, ago time.Duration) {
		s.Store.AddEvent(ctx, store.Event{UID: uid, Name: "plans_surface_click", At: now.Add(-ago),
			Props: map[string]any{"placement": placement, "variant": "v1", "plan": "business"}})
	}
	click("header", 8*24*time.Hour) // outside the window
	click("quote", 3*time.Hour)
	click("receipt", time.Hour) // the last one
	s.Store.AddEvent(ctx, store.Event{UID: uid, Name: "plans_surface_view", At: now.Add(-time.Minute), Props: map[string]any{"placement": "plans_sheet"}})
	key := "plan:sub_" + uid
	s.attributePlanStart(ctx, uid, "business", "checkout", key, now)
	s.attributePlanStart(ctx, uid, "business", "checkout", key, now.Add(time.Hour)) // a renewal: kept once
	convs, _ := s.Store.ListPlanConversionsSince(ctx, now.Add(-time.Minute), 100)
	var mine []store.PlanConversion
	for _, c := range convs {
		if c.UID == uid {
			mine = append(mine, c)
		}
	}
	if len(mine) != 1 || mine[0].Placement != "receipt" || mine[0].Variant != "v1" || mine[0].Product != "business" || mine[0].ClickAt == nil {
		t.Fatalf("attribution %+v", mine)
	}

	// Pro: first seen with Pro isn't a start; free → Pro is.
	already, buyer := "u"+store.NewID(), uid
	s.noteProSeen(ctx, already, true)
	s.noteProSeen(ctx, buyer, false)
	s.noteProSeen(ctx, buyer, true)
	s.noteProSeen(ctx, buyer, true) // seen again: nothing new
	convs, _ = s.Store.ListPlanConversionsSince(ctx, now.Add(-time.Minute), 100)
	pros := map[string]int{}
	for _, c := range convs {
		if c.Product == "pro" {
			pros[c.UID]++
			if c.UID == buyer && c.Placement != "receipt" {
				t.Fatalf("pro placement %+v", c)
			}
		}
	}
	if pros[already] != 0 || pros[buyer] != 1 {
		t.Fatalf("pro starts %v", pros)
	}
}

func TestPlansSurfaceReport(t *testing.T) {
	ev := func(name, uid, placement string) store.Event {
		return store.Event{UID: uid, Name: name, Props: map[string]any{"placement": placement}}
	}
	events := []store.Event{ev("plans_surface_view", "a", "quote"), ev("plans_surface_view", "a", "quote"), ev("plans_surface_view", "b", "quote"),
		ev("plans_surface_view", "b", "quote"), ev("plans_surface_click", "a", "quote"), ev("plans_surface_click", "b", "quote"),
		ev("plans_surface_dismiss", "b", "projects_banner")}
	convs := []store.PlanConversion{{UID: "a", Product: "pro", Placement: "quote"}, {UID: "c", Product: "studio"}}
	rep := plansSurfaceReport(events, convs)
	var quote, banner map[string]any
	for _, p := range rep["placements"].([]map[string]any) {
		switch p["placement"] {
		case "quote":
			quote = p
		case "projects_banner":
			banner = p
		}
	}
	if len(rep["placements"].([]map[string]any)) != len(plansPlacements) {
		t.Fatalf("every placement listed: %v", rep["placements"])
	}
	if quote["views"] != 4 || quote["viewers"] != 2 || quote["clicks"] != 2 || quote["conversions"] != 1 ||
		quote["click_rate"] != 0.5 || quote["conversion_rate"] != 0.5 || quote["conversions_by_product"].(map[string]int)["pro"] != 1 {
		t.Fatalf("quote %v", quote)
	}
	if banner["dismissals"] != 1 || banner["click_rate"] != 0.0 {
		t.Fatalf("banner %v", banner)
	}
	if u := rep["unattributed"].(map[string]any); u["conversions"] != 1 || u["by_product"].(map[string]int)["studio"] != 1 {
		t.Fatalf("unattributed %v", u)
	}
}

func TestSettingsDismissed(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1", CreatedAt: sampleSince.Add(time.Hour)})
	settings := func(method, body string) (int, map[string]any) {
		return callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleAccountSettings(w, r, &AuthedUser{UID: uid}) }, method, body)
	}
	if _, out := settings("GET", ""); fmt.Sprint(out["dismissed"]) != "map[]" {
		t.Fatalf("empty %v", out["dismissed"])
	}
	if code, _ := settings("PATCH", `{"dismissed":{"footer":true}}`); code != 400 {
		t.Fatal("unknown placement")
	}
	if code, _ := settings("PATCH", `{"dismissed":{"quote":"yesterday"}}`); code != 400 {
		t.Fatal("bad time")
	}
	code, out := settings("PATCH", `{"dismissed":{"projects_banner":true,"quote":"2026-11-01T09:00:00+09:00","header":"2999-01-01T00:00:00Z"}}`)
	d, _ := out["dismissed"].(map[string]any)
	if code != 200 || d["quote"] != "2026-11-01T00:00:00Z" || d["projects_banner"] == nil || !strings.HasPrefix(d["header"].(string), time.Now().UTC().Format("2006-")) {
		t.Fatalf("set %d %v", code, out["dismissed"])
	}
	_, out = settings("PATCH", `{"dismissed":{"quote":null}}`)
	if d := out["dismissed"].(map[string]any); d["quote"] != nil || d["projects_banner"] == nil {
		t.Fatalf("clear %v", d)
	}
}

// reason: why the surface showed; the report splits each placement by it
// and the attribution keeps the click's.
func TestPlansSurfaceReason(t *testing.T) {
	if _, ok := plansSurfaceProps(map[string]any{"placement": "quote", "reason": strings.Repeat("a", 33)}); ok {
		t.Fatal("long reason")
	}
	if _, ok := plansSurfaceProps(map[string]any{"placement": "quote", "reason": "Source 8K"}); ok {
		t.Fatal("charset")
	}
	if p, ok := plansSurfaceProps(map[string]any{"placement": "quote", "reason": "source_8k"}); !ok || p["reason"] != "source_8k" {
		t.Fatal("source_8k")
	}
	ev := func(name, placement, reason string) store.Event {
		props := map[string]any{"placement": placement}
		if reason != "" {
			props["reason"] = reason
		}
		return store.Event{UID: "a", Name: name, Props: props}
	}
	events := []store.Event{ev("plans_surface_view", "quote", "source_8k"), ev("plans_surface_view", "quote", "source_8k"),
		ev("plans_surface_click", "quote", "source_8k"), ev("plans_surface_view", "quote", "")}
	convs := []store.PlanConversion{{UID: "a", Product: "business", Placement: "quote", Reason: "source_8k"}}
	for _, p := range plansSurfaceReport(events, convs)["placements"].([]map[string]any) {
		if p["placement"] != "quote" {
			continue
		}
		br := p["by_reason"].([]map[string]any)
		if len(br) != 2 || br[0]["reason"] != "none" || br[0]["views"] != 1 || br[1]["placement"] != "quote" ||
			br[1]["reason"] != "source_8k" || br[1]["views"] != 2 || br[1]["viewers"] != 1 || br[1]["clicks"] != 1 ||
			br[1]["conversions"] != 1 || br[1]["click_rate"] != 0.5 || br[1]["dismissals"] != 0 ||
			br[1]["conversions_by_product"].(map[string]int)["business"] != 1 {
			t.Fatalf("by_reason %v", br)
		}
	}
}

// business_note per project: the user's own, pruned when archived.
func TestDismissedPerProject(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1", CreatedAt: sampleSince.Add(time.Hour)})
	mine, other := &store.Project{ID: store.NewID(), UID: uid}, &store.Project{ID: store.NewID(), UID: "someone"}
	s.Store.CreateProject(ctx, mine)
	s.Store.CreateProject(ctx, other)
	settings := func(body string) (int, map[string]any) {
		return callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleAccountSettings(w, r, &AuthedUser{UID: uid}) }, "PATCH", body)
	}
	if code, _ := settings(`{"dismissed":{"business_note:` + other.ID + `":true}}`); code != 400 {
		t.Fatal("someone else's project")
	}
	if code, _ := settings(`{"dismissed":{"quote:` + mine.ID + `":true}}`); code != 400 {
		t.Fatal("quote isn't per project")
	}
	code, out := settings(`{"dismissed":{"business_note:` + mine.ID + `":true,"header":true}}`)
	if d := out["dismissed"].(map[string]any); code != 200 || d["business_note:"+mine.ID] == nil || d["header"] == nil {
		t.Fatalf("set %d %v", code, out)
	}
	s.Store.UpdateProject(ctx, mine.ID, func(p *store.Project) error { p.Archived = true; return nil })
	_, out = settings(`{"dismissed":{"plans_hint":true}}`)
	if d := out["dismissed"].(map[string]any); d["business_note:"+mine.ID] != nil || d["header"] == nil || d["plans_hint"] == nil {
		t.Fatalf("pruned %v", d)
	}
	m := map[string]time.Time{}
	for i := 0; i < 210; i++ {
		m[fmt.Sprint("k", i)] = time.Unix(int64(i), 0)
	}
	capDismissed(m)
	if _, ok := m["k209"]; len(m) != maxDismissed || !ok {
		t.Fatalf("cap %d", len(m))
	}
}
