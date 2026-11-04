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
