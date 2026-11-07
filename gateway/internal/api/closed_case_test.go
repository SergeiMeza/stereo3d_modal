package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func caseAction(s *Service, id, body string) (int, map[string]any) {
	w := httptest.NewRecorder()
	s.HandleAdminCaseAction(w, httptest.NewRequest(http.MethodPost, "/v1/admin/cases/"+id+"/actions", strings.NewReader(body)),
		&AdminUser{UID: "admin", Email: "owner@x", Method: "passkey", AssertedAt: time.Now()}, id)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func eventKinds(t *testing.T, s *Service, id string) map[string]int {
	evs, err := s.Store.ListCaseEvents(context.Background(), id, 100)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]int{}
	for _, e := range evs {
		out[e.Kind]++
	}
	return out
}

// A closed case takes only the allow-listed system events; admin notes
// and decisions are 409 case_closed until it is reopened (with a reason);
// a customer's message opens a linked follow-up case and leaves the
// closed one untouched.
func TestClosedCaseLock(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	cs, _, err := s.Store.CreateCase(ctx, &store.Case{UID: uid, Type: store.CaseRefund, Reason: ReasonQuality, Mode: "manual", Status: store.CaseOpen,
		DedupeKey: "t:" + uid, Related: store.CaseRelated{PIIDs: []string{"pi_x"}}}, "system", "opened")
	if err != nil {
		t.Fatal(err)
	}
	s.closeCase(ctx, cs.ID, "owner@x", store.CaseDenied, "denied: outside terms") // "closed" goes in after the close
	if k := eventKinds(t, s, cs.ID); k["closed"] != 1 {
		t.Fatalf("closed event %v", k)
	}
	for _, kind := range []string{"refund_executed", "refund_failed", "superseded", "plan_ended"} {
		if err := s.Store.AddCaseEvent(ctx, cs.ID, store.CaseEvent{Who: "system", Kind: kind}); err != nil {
			t.Fatalf("%s refused: %v", kind, err)
		}
	}
	for _, kind := range []string{"note", "decision", "customer_message_in", "evidence_refreshed", "reminder"} {
		if err := s.Store.AddCaseEvent(ctx, cs.ID, store.CaseEvent{Who: "owner@x", Kind: kind}); !errors.Is(err, store.ErrCaseClosed) {
			t.Fatalf("%s on a closed case: %v", kind, err)
		}
	}
	for _, body := range []string{`{"action":"note","text":"hi"}`, `{"action":"deny","template":"other","text":"no"}`, `{"action":"close","text":"x"}`} {
		if code, out := caseAction(s, cs.ID, body); code != http.StatusConflict || out["error"] != "case_closed" {
			t.Fatalf("%s: %d %v", body, code, out)
		}
	}
	w := httptest.NewRecorder()
	s.HandleAdminAccountAction(w, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"action":"adjust_balance","cents":100,"case_id":"`+cs.ID+`","note":"x"}`)),
		&AdminUser{UID: "admin", Method: "passkey", AssertedAt: time.Now()}, uid)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "case_closed") {
		t.Fatalf("adjustment on a closed case: %d %s", w.Code, w.Body)
	}

	// A customer's message: a follow-up case, the closed one untouched.
	before, _ := s.Store.GetCase(ctx, cs.ID)
	code, out := caseAction(s, cs.ID, `{"action":"customer_reply","text":"the video is still flat"}`)
	nc, _ := out["case"].(map[string]any)
	if code != 200 || nc["follow_up_of"] != cs.ID || nc["id"] == cs.ID || nc["open"] != true {
		t.Fatalf("follow-up %d %v", code, out)
	}
	fid := nc["id"].(string)
	code, out = caseAction(s, cs.ID, `{"action":"customer_reply","text":"any news?"}`)
	if again, _ := out["case"].(map[string]any); code != 200 || again["id"] != fid {
		t.Fatalf("second message goes on the same follow-up: %d %v", code, out)
	}
	if k := eventKinds(t, s, fid); k["customer_message_in"] != 2 {
		t.Fatalf("follow-up events %v", k)
	}
	after, _ := s.Store.GetCase(ctx, cs.ID)
	if after.Status != store.CaseClosed || !after.LastActivityAt.Equal(before.LastActivityAt) || eventKinds(t, s, cs.ID)["customer_message_in"] != 0 {
		t.Fatalf("closed case written: %+v", after)
	}
	page := s.casePage(ctx, after)
	if ids := page["case"].(*store.Case).FollowUpIDs; len(ids) != 1 || ids[0] != fid {
		t.Fatalf("follow_up_ids %v", ids)
	}

	// Reopen: a reason is required; then notes work again.
	if code, _ := caseAction(s, cs.ID, `{"action":"reopen"}`); code != 400 {
		t.Fatalf("reopen without a reason %d", code)
	}
	code, out = caseAction(s, cs.ID, `{"action":"reopen","text":"customer sent new proof"}`)
	if c, _ := out["case"].(map[string]any); code != 200 || c["status"] != store.CaseOpen || c["open"] != true {
		t.Fatalf("reopen %d %v", code, out)
	}
	if code, _ := caseAction(s, cs.ID, `{"action":"note","text":"looking again"}`); code != 200 {
		t.Fatalf("note after reopen %d", code)
	}
	if k := eventKinds(t, s, cs.ID); k["reopened"] != 1 || k["note"] != 1 {
		t.Fatalf("events %v", k)
	}
}
