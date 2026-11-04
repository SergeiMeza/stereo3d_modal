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
