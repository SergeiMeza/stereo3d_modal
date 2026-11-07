package api

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func TestBusinessSetup(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1", CreatedAt: sampleSince.Add(time.Hour)})
	settings := func(method, body string) (int, map[string]any) {
		return callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleAccountSettings(w, r, &AuthedUser{UID: uid}) }, method, body)
	}
	if _, out := settings("GET", ""); out["business_setup"] != nil {
		t.Fatalf("default %v", out["business_setup"])
	}
	for _, bad := range []string{`{"business_setup":{"main_use":"fun"}}`, `{"business_setup":{"team_size":"lots of people"}}`, `{"business_setup":{"headsets":["Vision Pro"]}}`} {
		if code, _ := settings("PATCH", bad); code != 400 {
			t.Fatalf("%s accepted", bad)
		}
	}
	code, out := settings("PATCH", `{"business_setup":{"team_size":"2-5","main_use":"client_work","headsets":["avp","quest","avp"]}}`)
	bs, _ := out["business_setup"].(map[string]any)
	if code != 200 || bs["team_size"] != "2-5" || bs["main_use"] != "client_work" || fmt.Sprint(bs["headsets"]) != "[avp quest]" {
		t.Fatalf("set %d %v", code, out["business_setup"])
	}
	_, out = settings("PATCH", `{"business_setup":{"team_size":12}}`)
	if bs := out["business_setup"].(map[string]any); bs["team_size"] != "12" || bs["main_use"] != nil {
		t.Fatalf("replace %v", bs)
	}
	ans, _ := s.Store.ListBusinessSetupsSince(ctx, time.Now().Add(-time.Minute), 100)
	if len(ans) == 0 {
		t.Fatal("answers not listed")
	}
	if _, out = settings("PATCH", `{"business_setup":null}`); out["business_setup"] != nil {
		t.Fatal("cleared")
	}
}

func TestBusinessFunnel(t *testing.T) {
	ev := func(name, uid, plan string) store.Event {
		p := map[string]any{}
		if plan != "" {
			p["plan"] = plan
		}
		return store.Event{UID: uid, Name: name, Props: p}
	}
	events := []store.Event{ev("business_setup_opened", "a", ""), ev("business_setup_opened", "a", ""), ev("business_setup_opened", "b", ""),
		ev("business_setup_opened", "c", ""), ev("business_setup_opened", "d", ""),
		ev("business_setup_plan_picked", "a", "business"), ev("business_setup_plan_picked", "b", "studio"),
		ev("business_setup_details_done", "a", ""), ev("business_setup_checkout_started", "a", "business"),
		ev("business_setup_purchased", "a", "business")}
	answers := []store.BusinessSetup{{TeamSize: "2-5", MainUse: "client_work"}, {MainUse: "stock"}, {TeamSize: "2-5"}}
	rep := businessFunnelReport(events, answers)
	steps := rep["steps"].([]map[string]any)
	if steps[0]["people"] != 4 || steps[0]["events"] != 5 || steps[1]["people"] != 2 || steps[1]["rate_from_previous"] != 0.5 ||
		steps[4]["people"] != 1 || steps[4]["rate_from_previous"] != 1.0 || steps[0]["rate_from_previous"] != 0.0 {
		t.Fatalf("steps %v", steps)
	}
	if got := fmt.Sprint(rep["by_plan"]); got != "[map[people:1 plan:business step:business_setup_plan_picked] map[people:1 plan:studio step:business_setup_plan_picked] map[people:1 plan:business step:business_setup_checkout_started] map[people:1 plan:business step:business_setup_purchased]]" {
		t.Fatalf("by_plan %s", got)
	}
	a := rep["answers"].(map[string]any)
	if a["accounts"] != 3 || fmt.Sprint(a["by_main_use"]) != "[map[count:1 main_use:client_work] map[count:1 main_use:stock]]" ||
		fmt.Sprint(a["by_team_size"]) != "[map[count:2 team_size:2-5]]" {
		t.Fatalf("answers %v", a)
	}
	if got := fmt.Sprint(rep["business_setup"]); got != "[map[by_plan:map[business:0 studio:0] people:4 step:business_setup_opened] map[by_plan:map[business:1 studio:1] people:2 step:business_setup_plan_picked] map[by_plan:map[business:0 studio:0] people:1 step:business_setup_details_done] map[by_plan:map[business:1 studio:0] people:1 step:business_setup_checkout_started] map[by_plan:map[business:1 studio:0] people:1 step:business_setup_purchased]]" {
		t.Fatalf("business_setup %s", got)
	}
	if !ValidTaxIDRef("txi_1Abc23") || ValidTaxIDRef("0123456789ab") || ValidTaxIDRef("txi_a/b") {
		t.Fatal("tax id ref")
	}
	if _, ok := eventValidators["business_setup_plan_picked"](map[string]any{"plan": "pro"}); ok {
		t.Fatal("plan must be business or studio")
	}
}
