package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/revenuecat"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Emulator only: every account here is made up (store.NewID uids, example
// addresses); nothing reaches Firebase Auth (s.Auth is nil).

// deletionFixture is an account on TEST's defaults (the 48-hour wait),
// with a billing record and no plan.
func deletionFixture(t *testing.T) planFixture {
	t.Helper()
	s, fake := e0Service(t)
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	s.RevenueCat = revenuecat.New("")
	uid := "u" + store.NewID()
	s.Store.PutCustomer(context.Background(), uid, &store.Customer{StripeCustomerID: "cus_1", Email: "del@example.com"})
	return planFixture{t, s, fake, uid, ""}
}

func cancelDeletion(f planFixture) (int, map[string]any) {
	return callAs(f, f.s.HandleCancelDeletion, http.MethodPost, `{}`, false)
}

// due moves a pending deletion's delete_after into the past (the 48 hours
// have gone).
func due(t *testing.T, f planFixture) {
	t.Helper()
	if _, err := f.s.Store.UpdateAccountDeletion(context.Background(), f.uid, func(d *store.AccountDeletion) error {
		d.DeleteAfter = time.Now().UTC().Add(-time.Minute)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// A delete request on TEST schedules: 202 {state: pending_deletion,
// delete_after ≈ now + 48 h, deleted: false}; nothing is deleted yet; a
// repeat answers the same delete_after; account reads show it.
func TestDeletionScheduledAndIdempotent(t *testing.T) {
	f := deletionFixture(t)
	ctx := context.Background()
	code, out := deleteAccount(f, `{}`, false)
	if code != 202 || out["state"] != "pending_deletion" || out["pending_deletion"] != true || out["deleted"] != false || out["success"] != true {
		t.Fatalf("schedule %d %v", code, out)
	}
	after, err := time.Parse(time.RFC3339, out["delete_after"].(string))
	if err != nil || after.Sub(time.Now()) < 47*time.Hour+59*time.Minute || after.Sub(time.Now()) > 48*time.Hour {
		t.Fatalf("delete_after %v (%v)", out["delete_after"], err)
	}
	if c, _ := f.s.Store.GetCustomer(ctx, f.uid); c.AccountDeleted || c.DeletionPending {
		t.Fatal("deleted at once")
	}
	time.Sleep(1100 * time.Millisecond)
	code, again := deleteAccount(f, `{}`, false)
	if code != 202 || again["delete_after"] != out["delete_after"] || again["requested_at"] != out["requested_at"] {
		t.Fatalf("repeat %d %v, first %v", code, again, out)
	}
	st := f.s.deletionState(ctx, f.uid)
	if st["pending_deletion"] != true || st["delete_after"] != out["delete_after"] {
		t.Fatalf("state %v", st)
	}
	code, prev := callAs(f, f.s.HandleDeletePreview, http.MethodGet, "", false)
	if code != 200 || prev["pending_deletion"] != true || prev["delete_after"] != out["delete_after"] || prev["delete_delay_hours"] != float64(48) {
		t.Fatalf("preview %d %v", code, prev)
	}
	w := httptest.NewRecorder()
	f.s.HandleLimits(w, httptest.NewRequest("GET", "/v1/limits", nil), &AuthedUser{UID: f.uid})
	_, lim := decode(w)
	if ad, _ := lim["account_deletion"].(map[string]any); ad["pending_deletion"] != true || ad["delete_after"] != out["delete_after"] {
		t.Fatalf("limits %v", lim["account_deletion"])
	}
}

// Keep my account: the cancel ends the wait (only while pending); a new
// request starts a fresh 48 hours.
func TestDeletionCancel(t *testing.T) {
	f := deletionFixture(t)
	ctx := context.Background()
	if code, out := cancelDeletion(f); code != 409 || out["error"] != "not_pending_deletion" {
		t.Fatalf("cancel with nothing pending %d %v", code, out)
	}
	if code, _ := deleteAccount(f, `{}`, false); code != 202 {
		t.Fatal("schedule")
	}
	code, out := cancelDeletion(f)
	if code != 200 || out["state"] != "active" || out["cancelled"] != true || out["pending_deletion"] != false {
		t.Fatalf("cancel %d %v", code, out)
	}
	d, _ := f.s.Store.GetAccountDeletion(ctx, f.uid)
	if d.State != store.DeletionStateCancelled || d.CancelledBy != "customer" || d.CancelledAt == nil {
		t.Fatalf("row %+v", d)
	}
	if f.s.deletionState(ctx, f.uid)["pending_deletion"] != false {
		t.Fatal("still pending")
	}
	if code, _ := cancelDeletion(f); code != 409 {
		t.Fatal("second cancel")
	}
	// a cancelled schedule never runs
	if n := f.s.deletionScheduleSweep(ctx); len(n) != 0 {
		t.Fatalf("sweep ran %v", n)
	}
	if code, out := deleteAccount(f, `{}`, false); code != 202 || out["state"] != "pending_deletion" {
		t.Fatalf("asked again %d %v", code, out)
	}
}

// While pending, the frozen routes answer 409 account_pending_deletion
// {delete_after}; after a cancel they work again.
func TestDeletionFreezes(t *testing.T) {
	f := deletionFixture(t)
	ran := 0
	h := f.s.FrozenWhileDeleting(func(w http.ResponseWriter, r *http.Request, u *AuthedUser) {
		ran++
		w.WriteHeader(204)
	})
	if code, _ := callAs(f, h, http.MethodPost, `{}`, false); code != 204 || ran != 1 {
		t.Fatalf("open account %d", code)
	}
	_, sched := deleteAccount(f, `{}`, false)
	code, out := callAs(f, h, http.MethodPost, `{}`, false)
	d, _ := out["details"].(map[string]any)
	if code != 409 || out["error"] != "account_pending_deletion" || d["delete_after"] != sched["delete_after"] || ran != 1 {
		t.Fatalf("frozen %d %v", code, out)
	}
	// the real handlers behind the wrapper: a top-up and a new run
	for _, hh := range []func(http.ResponseWriter, *http.Request, *AuthedUser){f.s.HandleTopup, f.s.HandleCreateConversion} {
		if code, out := callAs(f, f.s.FrozenWhileDeleting(hh), http.MethodPost, `{"amount_cents":2500}`, false); code != 409 || out["error"] != "account_pending_deletion" {
			t.Fatalf("frozen handler %d %v", code, out)
		}
	}
	cancelDeletion(f)
	if code, _ := callAs(f, h, http.MethodPost, `{}`, false); code != 204 || ran != 2 {
		t.Fatalf("after cancel %d", code)
	}
}

// At delete_after the sweep runs today's deletion: soft-deleted, the row
// done (outcome deleted), once; before then nothing happens.
func TestDeletionSweepAt48Hours(t *testing.T) {
	f := deletionFixture(t)
	ctx := context.Background()
	deleteAccount(f, `{}`, false)
	if n := f.s.deletionScheduleSweep(ctx); len(n) != 0 {
		t.Fatalf("ran early %v", n)
	}
	if c, _ := f.s.Store.GetCustomer(ctx, f.uid); c.AccountDeleted {
		t.Fatal("deleted early")
	}
	due(t, f)
	if n := f.s.deletionScheduleSweep(ctx); n["deletions_deleted"] != 1 {
		t.Fatalf("sweep %v", n)
	}
	c, _ := f.s.Store.GetCustomer(ctx, f.uid)
	if !c.AccountDeleted || c.DeletedAt == nil || c.StripeCustomerID != "cus_1" {
		t.Fatalf("customer %+v", c)
	}
	d, _ := f.s.Store.GetAccountDeletion(ctx, f.uid)
	if d.State != store.DeletionStateDone || d.Outcome != store.DeletionOutcomeDeleted || d.ProcessedBy != "sweep" || d.ProcessedAt == nil {
		t.Fatalf("row %+v", d)
	}
	if n := f.s.deletionScheduleSweep(ctx); len(n) != 0 {
		t.Fatalf("ran twice %v", n)
	}
	if f.s.deletionState(ctx, f.uid)["pending_deletion"] != false {
		t.Fatal("still pending after the deletion")
	}
}

// A cash balance confirmed at the request: the sweep opens the closure
// case then (not at the request), and the account waits for it as today.
func TestDeletionSweepOpensClosureCase(t *testing.T) {
	f := deletionFixture(t)
	ctx := context.Background()
	paidTopup(t, f.s, f.uid, 2000)
	if code, out := deleteAccount(f, `{}`, false); code != 409 || out["error"] != "balance_remaining" {
		t.Fatalf("unconfirmed %d %v", code, out)
	}
	if code, out := deleteAccount(f, `{"balance_confirmed":true}`, false); code != 202 || out["state"] != "pending_deletion" {
		t.Fatalf("confirmed %d %v", code, out)
	}
	if c, _ := f.s.Store.GetCustomer(ctx, f.uid); c.DeletionPending || c.DeletionCaseID != "" {
		t.Fatal("closure case opened at the request")
	}
	due(t, f)
	n := f.s.deletionScheduleSweep(ctx)
	if n["deletions_refund_case"] != 1 {
		t.Fatalf("sweep %v", n)
	}
	if c, _ := f.s.Store.GetCustomer(ctx, f.uid); !c.DeletionPending || c.DeletionCaseID == "" || c.AccountDeleted {
		t.Fatalf("customer %+v", c)
	}
}

// Something in the way at delete_after (here a plan that renews again):
// the row stays pending, flagged blocked_reason for the console, and is
// tried again only after the retry spacing.
func TestDeletionSweepBlocked(t *testing.T) {
	f := newPlanFixture(t, "business", "business", 29900, 3, 30)
	ctx := context.Background()
	now := time.Now().UTC()
	if _, _, err := f.s.Store.ScheduleAccountDeletion(ctx, &store.AccountDeletion{UID: f.uid, RequestedAt: now.Add(-49 * time.Hour),
		DeleteAfter: now.Add(-time.Hour), Email: "a@example.com", Source: "web"}); err != nil {
		t.Fatal(err)
	}
	if n := f.s.deletionScheduleSweep(ctx); n["deletions_blocked"] != 1 {
		t.Fatalf("sweep %v", n)
	}
	d, _ := f.s.Store.GetAccountDeletion(ctx, f.uid)
	if !d.Pending() || d.BlockedReason != deleteBlockPlanRenewing || d.BlockedAt == nil || d.NextAttemptAt == nil ||
		d.NextAttemptAt.Sub(now) < 5*time.Hour || d.Attempts != 1 {
		t.Fatalf("row %+v", d)
	}
	if c, _ := f.s.Store.GetCustomer(ctx, f.uid); c.AccountDeleted {
		t.Fatal("deleted over a renewing plan")
	}
	if n := f.s.deletionScheduleSweep(ctx); len(n) != 0 {
		t.Fatalf("retried at once %v", n)
	}
	if adminDeletionJSON(d)["blocked"] != true {
		t.Fatal("not flagged for the console")
	}
}

// The console: Cancel deletion and Process now (which skips delete_after),
// each on the account's case when one is named.
func TestAdminDeletionActions(t *testing.T) {
	f := deletionFixture(t)
	ctx := context.Background()
	a := &AdminUser{UID: "admin", Email: "owner@x", Method: "passkey", AssertedAt: time.Now(), AuthTime: time.Now()}
	if err := f.s.adminDeletionAction(ctx, a, f.uid, "process_deletion_now", "", ""); err == nil {
		t.Fatal("process with nothing pending")
	}
	deleteAccount(f, `{}`, false)
	if err := f.s.adminDeletionAction(ctx, a, f.uid, "cancel_deletion", "", "asked by mail"); err != nil {
		t.Fatal(err)
	}
	if d, _ := f.s.Store.GetAccountDeletion(ctx, f.uid); d.State != store.DeletionStateCancelled || d.CancelledBy != "admin:"+a.who() {
		t.Fatalf("cancelled %+v", d)
	}
	deleteAccount(f, `{}`, false)
	if err := f.s.adminDeletionAction(ctx, a, f.uid, "process_deletion_now", "", ""); err != nil {
		t.Fatal(err)
	}
	d, _ := f.s.Store.GetAccountDeletion(ctx, f.uid)
	if d.State != store.DeletionStateDone || d.ProcessedBy != "admin:"+a.who() {
		t.Fatalf("processed %+v", d)
	}
	if c, _ := f.s.Store.GetCustomer(ctx, f.uid); !c.AccountDeleted {
		t.Fatal("not deleted")
	}
	w := httptest.NewRecorder()
	f.s.HandleAdminDeletions(w, httptest.NewRequest("GET", "/v1/admin/deletions?state=done", nil), a)
	_, out := decode(w)
	rows, _ := out["deletions"].([]any)
	found := false
	for _, r := range rows {
		if r.(map[string]any)["uid"] == f.uid {
			found = true
		}
	}
	if !found {
		t.Fatalf("not listed %v", out)
	}
}

// svs-backend's call (keep_sign_in with the proxy key): at 0 h (prod
// until its release) it deletes at once as before, 200 {deleted: true,
// sign_in_removed: false}, no schedule; with the wait it schedules like
// the web, keeping the sign-in for svs-backend. keep_sign_in without the
// proxy key is ignored. An anonymous account never waits.
func TestDeletionKeepSignInThroughProxy(t *testing.T) {
	f := deletionFixture(t)
	ctx := context.Background()
	code, out := deleteAccountNow(f, `{"keep_sign_in":true}`) // not through the proxy: ignored, and 0 h
	if code != 200 || out["deleted"] != true {
		t.Fatalf("0 h %d %v", code, out)
	}
	g := deletionFixture(t)
	r := *g.s.Pricing.Rates(ctx)
	r.AccountDeleteDelayHours = 0
	g.s.Pricing = pricing.NewStatic(&r)
	code, out = deleteAccount(g, `{"keep_sign_in":true}`, true)
	if code != 200 || out["deleted"] != true || out["sign_in_removed"] != false || out["state"] != nil {
		t.Fatalf("proxy at 0 h %d %v", code, out)
	}
	if _, err := g.s.Store.GetAccountDeletion(ctx, g.uid); err != store.ErrNotFound {
		t.Fatalf("a schedule row at 0 h: %v", err)
	}
	if _, err := g.s.Store.GetDeletionCallback(ctx, g.uid); err != store.ErrNotFound {
		t.Fatal("a callback for a deletion svs-backend finishes itself")
	}

	h := deletionFixture(t)
	code, out = deleteAccount(h, `{"keep_sign_in":true}`, true)
	if code != 202 || out["state"] != "pending_deletion" {
		t.Fatalf("proxy with the wait %d %v", code, out)
	}
	if d, _ := h.s.Store.GetAccountDeletion(ctx, h.uid); !d.Pending() || !d.KeepSignIn || d.Source != "api" {
		t.Fatalf("row %+v", d)
	}
	if code, again := deleteAccount(h, `{"keep_sign_in":true}`, true); code != 202 || again["delete_after"] != out["delete_after"] {
		t.Fatalf("repeat %d %v", code, again)
	}

	anon := deletionFixture(t)
	code, out = callAs(anon, func(w http.ResponseWriter, r *http.Request, _ *AuthedUser) {
		anon.s.HandleDeleteAccount(w, r, &AuthedUser{UID: anon.uid, Anonymous: true})
	}, http.MethodPost, `{"keep_sign_in":true}`, true)
	if code != 200 || out["deleted"] != true {
		t.Fatalf("anonymous %d %v", code, out)
	}
}

// Prod's defaults keep the deletion at once until the release sets the
// wait.
func TestDeletionDelayDefaults(t *testing.T) {
	if pricing.DefaultsFor("test").AccountDeleteDelayHours != 48 || pricing.DefaultsFor("prod").AccountDeleteDelayHours != 0 {
		t.Fatal("delay defaults")
	}
	m := deletionScheduledMail(time.Date(2026, 11, 9, 14, 5, 0, 0, time.UTC), "https://example.test")
	if m.Subject != "Spatial Video Studio: your account will be deleted on 9 November 2026" || !m.OwnAddress ||
		m.Link != "https://example.test/account?deletion=keep" {
		t.Fatalf("mail %+v", m)
	}
	if c := deletionCancelledMail("x"); c.Subject != "Spatial Video Studio: your account won't be deleted" || !c.OwnAddress {
		t.Fatal("cancel mail")
	}
}
