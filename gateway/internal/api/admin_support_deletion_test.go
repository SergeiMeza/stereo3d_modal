package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func adminAct(t *testing.T, s *Service, a *AdminUser, uid, body string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.HandleAdminAccountAction(rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)), a, uid)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// Support's "Delete account" (request_deletion): the customer path's
// runDeletion with the configured delay, on the person's behalf; needs a
// fresh sign-in; idempotent while pending; Process now then runs it.
func TestAdminRequestDeletion(t *testing.T) {
	f := deletionFixture(t)
	ctx := context.Background()
	stale := &AdminUser{UID: "admin", Email: "owner@x", Method: "passkey", AssertedAt: time.Now().Add(-time.Hour), AuthTime: time.Now().Add(-time.Hour)}
	if code, _ := adminAct(t, f.s, stale, f.uid, `{"action":"request_deletion"}`); code != http.StatusUnauthorized && code != http.StatusForbidden {
		t.Fatalf("stale sign-in allowed: %d", code)
	}
	a := &AdminUser{UID: "admin", Email: "owner@x", Method: "passkey", AssertedAt: time.Now(), AuthTime: time.Now()}
	code, out := adminAct(t, f.s, a, f.uid, `{"action":"request_deletion"}`)
	if code != http.StatusAccepted || out["state"] != "pending_deletion" {
		t.Fatalf("request %d %v", code, out)
	}
	d, _ := f.s.Store.GetAccountDeletion(ctx, f.uid)
	if d == nil || d.State != store.DeletionStatePending || d.Source != "admin" || d.DeleteAfter.Sub(d.RequestedAt) != f.s.accountDeleteDelay(ctx) {
		t.Fatalf("row %+v", d)
	}
	first := d.DeleteAfter
	if code, _ := adminAct(t, f.s, a, f.uid, `{"action":"request_deletion"}`); code != http.StatusAccepted {
		t.Fatalf("again %d", code)
	}
	if d, _ = f.s.Store.GetAccountDeletion(ctx, f.uid); !d.DeleteAfter.Equal(first) {
		t.Fatal("a second request moved the date")
	}
	if err := f.s.adminDeletionAction(ctx, a, f.uid, "process_deletion_now", "", ""); err != nil {
		t.Fatal(err)
	}
	if c, _ := f.s.Store.GetCustomer(ctx, f.uid); !c.AccountDeleted {
		t.Fatal("not deleted")
	}
}

// A cash balance (refund policy 2026-11-08): the request is scheduled
// without a confirmation and processing deletes the account, the balance
// forfeited; no closure case.
func TestAdminRequestDeletionCashBalance(t *testing.T) {
	f := deletionFixture(t)
	ctx := context.Background()
	paidTopup(t, f.s, f.uid, 2125)
	a := &AdminUser{UID: "admin", Email: "owner@x", Method: "passkey", AssertedAt: time.Now(), AuthTime: time.Now()}
	// refund policy 2026-11-08: no confirmation needed, balance_confirmed
	// is ignored; the deletion forfeits the balance, no closure case
	if code, out := adminAct(t, f.s, a, f.uid, `{"action":"request_deletion"}`); code != http.StatusAccepted {
		t.Fatalf("a cash balance without confirmation: %d %v", code, out)
	}
	outcome, err := f.s.processScheduledDeletion(ctx, f.uid, "admin:test", true)
	if err != nil || outcome != store.DeletionOutcomeDeleted {
		t.Fatalf("process: %q %v", outcome, err)
	}
	if cases, _ := f.s.Store.ListUserCases(ctx, f.uid, 10); len(cases) != 0 {
		t.Fatalf("a case for the deleted balance: %+v", cases)
	}
	if b, _ := f.s.Store.GetBalance(ctx, f.uid); b.CashCents() != 0 {
		t.Fatalf("cash left after the deletion: %d", b.CashCents())
	}
}

// auto_reload_off: support turns it off; a pending retry ends with it.
func TestAdminAutoReloadOff(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_1", "decline:generic_decline"})
	id := offReload(t, s, uid, 2000)
	s.runReload(ctx, id)
	a := &AdminUser{UID: "admin", Email: "owner@x", Method: "passkey", AssertedAt: time.Now(), AuthTime: time.Now()}
	if code, out := adminAct(t, s, a, uid, `{"action":"auto_reload_off"}`); code != 200 {
		t.Fatalf("%d %v", code, out)
	}
	b, _ := s.Store.GetBalance(ctx, uid)
	tp, _ := s.Store.GetTopup(ctx, id)
	if b.AutoReload.Enabled || tp.Retry.State != store.RetryCanceled {
		t.Fatalf("auto-reload %v retry %+v", b.AutoReload.Enabled, tp.Retry)
	}
}
