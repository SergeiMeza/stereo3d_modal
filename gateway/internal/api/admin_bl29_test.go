package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func bl29Admin() *AdminUser {
	return &AdminUser{UID: "admin", Email: "owner@x", Method: "passkey", AssertedAt: time.Now()}
}

func adminGet(t *testing.T, h func(http.ResponseWriter, *http.Request, *AdminUser), url string) map[string]any {
	t.Helper()
	w := httptest.NewRecorder()
	h(w, httptest.NewRequest(http.MethodGet, url, nil), bl29Admin())
	if w.Code != 200 {
		t.Fatalf("%s: %d %s", url, w.Code, w.Body)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return out
}

// Case list rows carry the account's uid.
func TestAdminCaseRowsUID(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	if _, _, err := s.Store.CreateCase(ctx, &store.Case{UID: uid, Type: store.CaseRefund, Reason: ReasonQuality, Mode: "manual", Status: store.CaseOpen, DedupeKey: "bl29:" + uid}, "system", "x"); err != nil {
		t.Fatal(err)
	}
	out := adminGet(t, s.HandleAdminCases, "/v1/admin/cases?tab=all")
	for _, r := range out["cases"].([]any) {
		if r.(map[string]any)["uid"] == uid {
			return
		}
	}
	t.Fatalf("no row with the uid: %v", out["cases"])
}

// ⌘K: accounts by email prefix (any case) or exact uid, cases or not.
func TestAdminAccountSearch(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	a, b := "u"+store.NewID(), "u"+store.NewID()
	tag := store.NewID()
	s.Store.PutCustomer(ctx, a, &store.Customer{StripeCustomerID: "cus_1", Email: "ann." + tag + "@example.com", CreatedAt: time.Now()})
	s.Store.PutCustomer(ctx, b, &store.Customer{StripeCustomerID: "cus_2", Email: "bob." + tag + "@example.com"})
	out := adminGet(t, s.HandleAdminAccountSearch, "/v1/admin/accounts?q=ANN."+tag)
	accs := out["accounts"].([]any)
	if len(accs) != 1 || accs[0].(map[string]any)["uid"] != a || accs[0].(map[string]any)["created_at"] == nil {
		t.Fatalf("by email %v", accs)
	}
	out = adminGet(t, s.HandleAdminAccountSearch, "/v1/admin/accounts?q="+b)
	if accs := out["accounts"].([]any); len(accs) != 1 || accs[0].(map[string]any)["email"] != "bob."+tag+"@example.com" {
		t.Fatalf("by uid %v", accs)
	}
	w := httptest.NewRecorder()
	s.HandleAdminAccountSearch(w, httptest.NewRequest(http.MethodGet, "/v1/admin/accounts?q=a", nil), bl29Admin())
	if w.Code != 400 {
		t.Fatalf("too short %d", w.Code)
	}
}

// A run by its id.
func TestAdminRunLookup(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	c := &store.Conversion{ID: store.NewID(), UID: "u" + store.NewID(), State: store.StateSucceeded, Kind: "video", ProjectID: "p1",
		Quote: store.Quote{AmountCents: 1234, Currency: "usd"}}
	if err := s.Store.CreateConversion(ctx, c); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.HandleAdminRun(w, httptest.NewRequest(http.MethodGet, "/", nil), bl29Admin(), c.ID)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	run, _ := out["run"].(map[string]any)
	if w.Code != 200 || run["uid"] != c.UID || run["status"] != store.StateSucceeded || run["amount_cents"] != float64(1234) || run["project_id"] != "p1" {
		t.Fatalf("run %d %v", w.Code, out)
	}
	w = httptest.NewRecorder()
	s.HandleAdminRun(w, httptest.NewRequest(http.MethodGet, "/", nil), bl29Admin(), store.NewID())
	if w.Code != 404 {
		t.Fatalf("unknown run %d", w.Code)
	}
}

// Plan starts: who, plan, price, when.
func TestAdminPlanStarts(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	end := time.Now().Add(20 * 24 * time.Hour)
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1", Email: "ann@example.com",
		Plan: &store.Plan{Tier: "pro", PlanID: "pro_weekly", Status: "active", CurrentPeriodEnd: &end, PeriodPaidCents: 399}})
	s.Store.AddPlanConversion(ctx, "plan:sub_"+uid, store.PlanConversion{UID: uid, Product: "pro", Source: "checkout", At: time.Now()})
	app := "u" + store.NewID()
	s.Store.AddPlanConversion(ctx, "pro:"+app, store.PlanConversion{UID: app, Product: "pro", Source: "revenuecat", At: time.Now().Add(-time.Hour)})
	out := adminGet(t, s.HandleAdminPlansSurfaces, "/v1/admin/plans/surfaces?days=7")
	starts := out["starts"].([]any)
	var web, store_ map[string]any
	for _, x := range starts {
		m := x.(map[string]any)
		switch m["uid"] {
		case uid:
			web = m
		case app:
			store_ = m
		}
	}
	if web == nil || web["plan"] != "pro_weekly" || web["price_cents"] != float64(399) || web["email"] != "ann@example.com" || web["started_at"] == nil {
		t.Fatalf("web start %v", web)
	}
	if store_ == nil || store_["price_cents"] != nil || store_["source"] != "revenuecat" {
		t.Fatalf("app start %v", store_)
	}
}

// Every grant, active first.
func TestAdminAllGrants(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1", Email: "g@example.com"})
	old := &store.AdminGrant{UID: uid, Entitlement: "pro", EndsAt: time.Now().Add(-time.Hour), GrantedBy: "owner@x", Reason: "old", CreatedAt: time.Now().Add(-48 * time.Hour), State: "granted"}
	cur := &store.AdminGrant{UID: uid, Entitlement: "business", EndsAt: time.Now().Add(48 * time.Hour), GrantedBy: "owner@x", Reason: "now", CreatedAt: time.Now().Add(-72 * time.Hour), State: "granted"}
	s.Store.CreateAdminGrant(ctx, old)
	s.Store.CreateAdminGrant(ctx, cur)
	out := adminGet(t, s.HandleAdminAllGrants, "/v1/admin/grants")
	var mine []map[string]any
	for _, x := range out["grants"].([]any) {
		if m := x.(map[string]any); m["uid"] == uid {
			mine = append(mine, m)
		}
	}
	if len(mine) != 2 || mine[0]["id"] != cur.ID || mine[0]["status"] != "active" || mine[0]["kind"] != "business" || mine[0]["email"] != "g@example.com" || mine[1]["status"] != "expired" {
		t.Fatalf("grants %v", mine)
	}
}

// Open early fraud warnings, with a case or only a hold.
func TestAdminOpenEFWs(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	cs, _, _ := s.Store.CreateCase(ctx, &store.Case{UID: uid, Type: store.CaseEFW, Reason: ReasonEFW, Mode: "manual", Status: store.CaseOpen,
		DedupeKey: "efw:issfr_a" + uid, RequestedCents: 900, Related: store.CaseRelated{EFWID: "issfr_a" + uid, PIIDs: []string{"pi_a"}}}, "system", "x")
	s.Store.CreatePromoRegrant(ctx, "efw:issfr_b"+uid, &store.PromoRegrant{UID: uid, Policy: promoPolicyAll, Status: "held", AmountCents: 29900})
	s.Store.CreatePromoRegrant(ctx, "efw:issfr_a"+uid, &store.PromoRegrant{UID: uid, Policy: promoPolicyAll, Status: "held", CaseID: cs.ID})
	out := adminGet(t, s.HandleAdminOpenEFWs, "/v1/admin/efws")
	got := map[string]map[string]any{}
	for _, x := range out["efws"].([]any) {
		m := x.(map[string]any)
		got[m["id"].(string)] = m
	}
	if a := got["issfr_a"+uid]; a == nil || a["case_id"] != cs.ID || a["amount_cents"] != float64(900) || a["payment_intent"] != "pi_a" {
		t.Fatalf("with a case %v", a)
	}
	if b := got["issfr_b"+uid]; b == nil || b["case_id"] != nil || b["amount_cents"] != float64(29900) || b["uid"] != uid {
		t.Fatalf("without a case %v", b)
	}
	if len(got) != 2 {
		t.Fatalf("efws %v", got)
	}
}
