package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func callJSON(t *testing.T, h func(http.ResponseWriter, *http.Request), method, body string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(method, "/", strings.NewReader(body)))
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// GET/PATCH /v1/account/settings: headsets, hints_seen, onboarding flags,
// the steps worked out server-side without the sample; accounts from
// before onboarding see the welcome once too.
func TestOnboardingSettings(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1", CreatedAt: sampleSince.Add(time.Hour)})
	user := &AuthedUser{UID: uid}
	settings := func(method, body string) (int, map[string]any) {
		return callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleAccountSettings(w, r, user) }, method, body)
	}
	code, out := settings("GET", "")
	ob, _ := out["onboarding"].(map[string]any)
	if code != 200 || out["headsets"] != nil || len(out["hints_seen"].([]any)) != 0 || ob["welcome_done"] != false ||
		ob["checklist_hidden"] != false || ob["tips_done"] != false {
		t.Fatalf("new account %d %v", code, out)
	}
	for _, bad := range []string{`{"headsets":["Vision Pro"]}`, `{"hints_seen_add":["a b"]}`} {
		if code, out := settings("PATCH", bad); code != 400 {
			t.Fatalf("%s: %d %v", bad, code, out)
		}
	}
	code, out = settings("PATCH", `{"headsets":["vision_pro","quest","quest"],"hints_seen_add":["projects","billing"],"onboarding":{"welcome_done":true}}`)
	ob = out["onboarding"].(map[string]any)
	if code != 200 || fmt.Sprint(out["headsets"]) != "[vision_pro quest]" || fmt.Sprint(out["hints_seen"]) != "[projects billing]" ||
		ob["welcome_done"] != true || ob["tips_done"] != false {
		t.Fatalf("patch %d %v", code, out)
	}
	_, out = settings("PATCH", `{"hints_seen_add":["billing","pricing"],"onboarding":{"tips_done":true},"headsets":[]}`)
	ob = out["onboarding"].(map[string]any)
	if fmt.Sprint(out["hints_seen"]) != "[projects billing pricing]" || ob["welcome_done"] != true || ob["tips_done"] != true ||
		fmt.Sprint(out["headsets"]) != "[]" {
		t.Fatalf("partial %v", out)
	}

	// Steps: the sample's finished run doesn't count; theirs do.
	steps := func() map[string]any {
		_, out := settings("GET", "")
		return out["onboarding"].(map[string]any)["steps"].(map[string]any)
	}
	if _, added := s.ensureSample(ctx, uid, nil); !added {
		t.Fatal("sample not added")
	}
	if st := steps(); st["first_video"] != false || st["first_3d"] != false || st["watched"] != false {
		t.Fatalf("sample counted %v", st)
	}
	p := &store.Project{ID: store.NewID(), UID: uid, Method: store.MethodLifelike}
	s.Store.CreateProject(ctx, p)
	prev := &store.Conversion{ID: store.NewID(), UID: uid, ProjectID: p.ID, Kind: "video", Step: store.StepLifelikePreview, State: store.StateSucceeded}
	s.Store.CreateConversion(ctx, prev)
	if st := steps(); st["first_video"] != true || st["first_preview"] != true || st["first_3d"] != false {
		t.Fatalf("own %v", st)
	}
	s.noteWatched(ctx, &store.Conversion{UID: uid, ProjectID: sampleProjectID(uid), Sample: true})
	if st := steps(); st["watched"] != false {
		t.Fatal("watching the sample counted")
	}
	s.noteWatched(ctx, prev)
	if st := steps(); st["watched"] != true {
		t.Fatal("watched not noted")
	}

	// An account from before onboarding (customer and a project older
	// than sampleSince): the welcome is still due until it's saved as done
	// (owner 2026-11-05), and it still gets no sample.
	old := "u" + store.NewID()
	s.Store.PutCustomer(ctx, old, &store.Customer{StripeCustomerID: "cus_2", CreatedAt: sampleSince.Add(-time.Hour)})
	oldCtx := func(method, body string) (int, map[string]any) {
		return callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleAccountSettings(w, r, &AuthedUser{UID: old}) }, method, body)
	}
	_, out = oldCtx("GET", "")
	if out["onboarding"].(map[string]any)["welcome_done"] != false {
		t.Fatalf("old account must see the welcome: %v", out)
	}
	if c, _ := s.Store.GetCustomer(ctx, old); c.Onboarding != nil && c.Onboarding.WelcomeDone != nil {
		t.Fatal("a GET must not save welcome_done")
	}
	_, out = oldCtx("PATCH", `{"onboarding":{"welcome_done":true}}`)
	if _, out = oldCtx("GET", ""); out["onboarding"].(map[string]any)["welcome_done"] != true {
		t.Fatalf("saved welcome_done %v", out)
	}
	if !existingAccount(&store.Customer{CreatedAt: sampleSince.Add(-time.Hour)}, nil) {
		t.Fatal("existingAccount still marks older accounts (sample, app Pro)")
	}
}

// POST /v1/events: allow-listed, checked props, 30 an hour.
func TestEvents(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	post := func(body string) (int, map[string]any) {
		return callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleEvents(w, r, &AuthedUser{UID: uid}) }, "POST", body)
	}
	if code, out := post(`{"name":"page_view","props":{}}`); code != 400 || out["error"] != "unknown_event" {
		t.Fatalf("unknown %d %v", code, out)
	}
	if code, _ := post(`{"name":"onboarding_headsets","props":{"devices":[]}}`); code != 400 {
		t.Fatal("empty devices")
	}
	if code, _ := post(`{"name":"onboarding_headsets","props":{"devices":["quest"],"x":"` + strings.Repeat("a", 5000) + `"}}`); code != 400 {
		t.Fatal("oversized body")
	}
	if code, out := post(`{"name":"onboarding_headsets","props":{"devices":["vision_pro","quest"],"plan":"pro","source":"welcome","email":"x@y.z"}}`); code != 200 || out["logged"] != true {
		t.Fatalf("ok %d %v", code, out)
	}
	evs, _ := s.Store.ListEventsSince(ctx, "onboarding_headsets", time.Now().Add(-time.Minute), 100)
	var mine *store.Event
	for i := range evs {
		if evs[i].UID == uid {
			mine = &evs[i]
		}
	}
	if mine == nil || mine.Props["plan"] != "pro" || mine.Props["email"] != nil || fmt.Sprint(mine.Props["devices"]) != "[vision_pro quest]" {
		t.Fatalf("stored %+v", mine)
	}
	n := 1
	for ; n < 40; n++ {
		if code, _ := post(`{"name":"onboarding_headsets","props":{"devices":["quest"]}}`); code == 429 {
			break
		}
	}
	if n != eventsPerHour {
		t.Fatalf("rate limit after %d", n)
	}
}

// The admin report: per day and plan a person counts once per device;
// converted = a paid full run after the answer (the sample aside).
func TestHeadsetReport(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	a, b := "u"+store.NewID(), "u"+store.NewID()
	day := time.Now().UTC().Truncate(24 * time.Hour).Add(-72*time.Hour + 9*time.Hour)
	ev := func(uid, plan string, at time.Time, devices ...any) store.Event {
		return store.Event{UID: uid, Name: "onboarding_headsets", At: at, Props: map[string]any{"devices": devices, "plan": plan}}
	}
	events := []store.Event{ev(a, "none", day, "vision_pro", "quest"), ev(a, "none", day.Add(time.Hour), "quest"),
		ev(b, "pro", day.Add(25*time.Hour), "quest")}
	s.Store.CreateConversion(ctx, &store.Conversion{ID: store.NewID(), UID: a, ProjectID: "p", Kind: "video", Step: store.StepProduction,
		State: store.StateSucceeded, Quote: store.Quote{AmountCents: 900}})
	s.Store.CreateConversion(ctx, &store.Conversion{ID: store.NewID(), UID: b, ProjectID: "p", Kind: "video", Step: store.StepProduction,
		State: store.StateSucceeded, Sample: true})
	rep := s.headsetReport(ctx, events)
	got := fmt.Sprint(rep["by_day"], rep["by_plan"], rep["conversion"])
	d1, d2 := day.Format("2006-01-02"), day.Add(25*time.Hour).Format("2006-01-02")
	want := "[map[count:1 day:" + d1 + " device:quest] map[count:1 day:" + d1 + " device:vision_pro] map[count:1 day:" + d2 + " device:quest]]" +
		" [map[count:1 device:quest plan:none] map[count:1 device:vision_pro plan:none] map[count:1 device:quest plan:pro]]" +
		" [map[converted:1 device:quest people:2] map[converted:1 device:vision_pro people:1]]"
	if got != want {
		t.Fatalf("report\n%s\nwant\n%s", got, want)
	}
}

// The sample: once, on a new account's first list; read-only, never
// billed, its files the CDN's; archives like any project; out of usage.
func TestSampleProject(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	uid := "u" + store.NewID()
	user := &AuthedUser{UID: uid}
	list := func(q string) []any {
		rec := httptest.NewRecorder()
		s.HandleListProjects(rec, httptest.NewRequest("GET", "/v1/projects"+q, nil), user)
		var out map[string]any
		json.Unmarshal(rec.Body.Bytes(), &out)
		ps, _ := out["projects"].([]any)
		return ps
	}
	ps := list("")
	if len(ps) != 1 {
		t.Fatalf("first list %v", ps)
	}
	sp := ps[0].(map[string]any)
	id := sp["project_id"].(string)
	if sp["sample"] != true || sp["name"] != "Sunset session" || sp["method"] != "lifelike" || sp["preview_url"] == "" ||
		sp["analyze"].(map[string]any)["state"] != "succeeded" {
		t.Fatalf("sample %v", sp)
	}
	if ps := list(""); len(ps) != 1 {
		t.Fatalf("second list %d", len(ps))
	}
	convs, _ := s.Store.ListProjectConversions(ctx, id, 10)
	if len(convs) != 4 || convs[0].Params.Preset != "4k" {
		t.Fatalf("runs %d", len(convs))
	}
	for _, c := range convs {
		if !c.Sample || c.State != store.StateSucceeded || c.Quote.AmountCents != 0 || len(c.Outputs) != 3 {
			t.Fatalf("run %+v", c)
		}
	}
	// quotes and runs: 422 sample_project
	for _, h := range []func(http.ResponseWriter, *http.Request, *AuthedUser, string){s.HandleQuoteStep, s.HandleCreateStepConversion} {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest("POST", "/", strings.NewReader(`{"step":"production","preset":"1080p"}`)), user, id)
		if rec.Code != 422 || !strings.Contains(rec.Body.String(), "sample_project") {
			t.Fatalf("run on sample %d %s", rec.Code, rec.Body)
		}
	}
	// downloads: the CDN's files, sized
	rec := httptest.NewRecorder()
	s.HandleDownloads(rec, httptest.NewRequest("GET", "/", nil), user, convs[0].ID)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "cdn.public.spatial-video-studio.com/samples/2026-11/sunset-session-spatial.mov") ||
		!strings.Contains(rec.Body.String(), `"size_bytes":319972232`) {
		t.Fatalf("downloads %d %s", rec.Code, rec.Body)
	}
	// archive and unarchive like any project
	for _, arch := range []string{"true", "false"} {
		rec := httptest.NewRecorder()
		s.HandleUpdateProject(rec, httptest.NewRequest("PATCH", "/", strings.NewReader(`{"archived":`+arch+`}`)), user, id)
		if rec.Code != 200 {
			t.Fatalf("archive %s: %d %s", arch, rec.Code, rec.Body)
		}
	}
	if ps := list(""); len(ps) != 1 {
		t.Fatal("unarchived sample missing")
	}
	// not in their conversions list
	rec = httptest.NewRecorder()
	s.HandleListConversions(rec, httptest.NewRequest("GET", "/", nil), user)
	if strings.Contains(rec.Body.String(), convs[0].ID) {
		t.Fatalf("sample run listed %s", rec.Body)
	}
	// a smaller size downloads its own CDN files, sized; runs on it are refused too
	for _, c := range convs[1:] {
		rec := httptest.NewRecorder()
		s.HandleDownloads(rec, httptest.NewRequest("GET", "/", nil), user, c.ID)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "sunset-session-"+c.Params.Preset+"-spatial.mov") ||
			strings.Contains(rec.Body.String(), `"size_bytes":0`) || strings.Contains(rec.Body.String(), "sunset-session-spatial.mov") {
			t.Fatalf("downloads %s %d %s", c.Params.Preset, rec.Code, rec.Body)
		}
	}
	// never in usage: the month's usage rows skip sample runs
	rec = httptest.NewRecorder()
	s.HandleUsage(rec, httptest.NewRequest("GET", "/v1/billing/usage?month="+time.Now().UTC().Format("2006-01"), nil), user)
	for _, c := range convs {
		if strings.Contains(rec.Body.String(), c.ID) {
			t.Fatalf("sample run in usage %s", rec.Body)
		}
	}
	if spent := s.monthSpent(ctx, uid, store.NewBalance(uid)); spent != 0 {
		t.Fatalf("sample runs counted in the month's spend %d", spent)
	}
	// an account from before onboarding gets none
	old := "u" + store.NewID()
	s.Store.PutCustomer(ctx, old, &store.Customer{StripeCustomerID: "cus_3", CreatedAt: sampleSince.Add(-time.Hour)})
	if _, added := s.ensureSample(ctx, old, nil); added {
		t.Fatal("old account got a sample")
	}
}
