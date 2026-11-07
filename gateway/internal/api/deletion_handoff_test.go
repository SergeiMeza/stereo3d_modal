package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/auth"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Emulator only, made-up accounts; svs-backend is a stub.

type callbackStub struct {
	mu     sync.Mutex
	status int
	bodies []map[string]any
	urls   []string
}

func (c *callbackStub) post(_ context.Context, url string, body []byte) (int, []byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var m map[string]any
	json.Unmarshal(body, &m)
	c.bodies, c.urls = append(c.bodies, m), append(c.urls, url)
	return c.status, []byte(`{"ok":true,"already":true,"unknown":true,"counts":{}}`), nil
}

func handoffFixture(t *testing.T) (planFixture, *callbackStub) {
	f := deletionFixture(t)
	stub := &callbackStub{status: 204}
	f.s.Cfg.SVSBackendURL = "https://svs-backend.example"
	f.s.DeletionCallbackPost = stub.post
	return f, stub
}

// A keep_sign_in deletion completed by the 48-hour sweep calls svs-backend
// once {uid, environment, requested_at, completed_at, via: sweep}; a web
// deletion calls nobody.
func TestDeletionCallbackOnSweep(t *testing.T) {
	f, stub := handoffFixture(t)
	ctx := context.Background()
	deleteAccount(f, `{"keep_sign_in":true}`, true)
	due(t, f)
	if n := f.s.deletionScheduleSweep(ctx); n["deletions_deleted"] != 1 {
		t.Fatalf("sweep %v", n)
	}
	if len(stub.bodies) != 1 || stub.urls[0] != "https://svs-backend.example/internal/v1/account/deletion-completed" {
		t.Fatalf("calls %v %v", stub.urls, stub.bodies)
	}
	b := stub.bodies[0]
	if b["uid"] != f.uid || b["environment"] != "test" || b["via"] != "sweep" || b["requested_at"] == nil || b["completed_at"] == nil {
		t.Fatalf("body %v", b)
	}
	if cb, _ := f.s.Store.GetDeletionCallback(ctx, f.uid); cb.State != store.CallbackSent {
		t.Fatalf("row %+v", cb)
	}
	if c, _ := f.s.Store.GetCustomer(ctx, f.uid); !c.AccountDeleted {
		t.Fatal("not deleted")
	}
	f.s.deletionCallbackSweep(ctx)
	if len(stub.bodies) != 1 {
		t.Fatal("sent twice")
	}

	web, webStub := handoffFixture(t)
	deleteAccount(web, `{}`, false)
	due(t, web)
	web.s.deletionScheduleSweep(ctx)
	if len(webStub.bodies) != 0 {
		t.Fatalf("a web deletion called svs-backend %v", webStub.bodies)
	}
}

// The console's "Process now" reports via admin.
func TestDeletionCallbackOnAdmin(t *testing.T) {
	f, stub := handoffFixture(t)
	ctx := context.Background()
	deleteAccount(f, `{"keep_sign_in":true}`, true)
	a := &AdminUser{UID: "admin", Email: "owner@x", Method: "cli"}
	if err := f.s.adminDeletionAction(ctx, a, f.uid, "process_deletion_now", "", ""); err != nil {
		t.Fatal(err)
	}
	if len(stub.bodies) != 1 || stub.bodies[0]["via"] != "admin" {
		t.Fatalf("calls %v", stub.bodies)
	}
}

// A cash balance: the sweep opens the closure case and keeps the sign-in;
// the case's decision completes the deletion and reports via refund_case.
func TestDeletionCallbackOnRefundCase(t *testing.T) {
	f, stub := handoffFixture(t)
	ctx := context.Background()
	paidTopup(t, f.s, f.uid, 2000)
	if code, out := deleteAccount(f, `{"keep_sign_in":true,"balance_confirmed":true}`, true); code != 202 || out["state"] != "pending_deletion" {
		t.Fatalf("schedule %d %v", code, out)
	}
	due(t, f)
	if n := f.s.deletionScheduleSweep(ctx); n["deletions_refund_case"] != 1 {
		t.Fatalf("sweep %v", n)
	}
	c, _ := f.s.Store.GetCustomer(ctx, f.uid)
	if !c.DeletionPending || !c.DeletionKeepSignIn || len(stub.bodies) != 0 {
		t.Fatalf("customer %+v calls %d", c, len(stub.bodies))
	}
	cs, _ := f.s.Store.GetCase(ctx, c.DeletionCaseID)
	if err := f.s.applyCaseAction(ctx, cs, caseActionReq{Action: "approve"}, "owner@x"); err != nil {
		t.Fatal(err)
	}
	f.s.finishPendingDeletions(ctx) // the decision finishes it (or did already)
	if after, _ := f.s.Store.GetCustomer(ctx, f.uid); !after.AccountDeleted || after.DeletionPending {
		t.Fatalf("after the decision %+v", after)
	}
	if len(stub.bodies) != 1 || stub.bodies[0]["via"] != "refund_case" {
		t.Fatalf("calls %v", stub.bodies)
	}
}

// svs-backend down: the row stays pending with a backoff and is sent by a
// later sweep; past the 72-hour window it gives up (the backstop still
// lists it).
func TestDeletionCallbackRetries(t *testing.T) {
	f, stub := handoffFixture(t)
	ctx := context.Background()
	stub.status = 503
	f.s.deletionCompleted(ctx, f.uid, time.Now().Add(-49*time.Hour), viaSweep)
	cb, _ := f.s.Store.GetDeletionCallback(ctx, f.uid)
	if cb.State != store.CallbackPending || cb.Attempts != 1 || !cb.NextAttemptAt.After(time.Now()) || cb.LastError != "status 503" {
		t.Fatalf("after a 503 %+v", cb)
	}
	if n := f.s.deletionCallbackSweep(ctx); len(n) != 0 || len(stub.bodies) != 1 {
		t.Fatalf("retried before its time %v", n)
	}
	stub.status = 200
	if n := f.s.deletionCallbackSweep(ctx); n["deletion_callbacks_sent"] != 0 {
		t.Fatal("not due yet")
	}
	// once due, a later sweep sends it
	f.s.Store.FinishDeletionCallback(ctx, f.uid, false, time.Now().Add(-time.Second), "status 503", false, time.Now())
	if n := f.s.deletionCallbackSweep(ctx); n["deletion_callbacks_sent"] != 1 || len(stub.bodies) != 2 {
		t.Fatalf("retry %v", n)
	}
	if callbackBackoff(1) != time.Minute || callbackBackoff(3) != 4*time.Minute || callbackBackoff(30) != time.Hour {
		t.Fatal("backoff")
	}
	old := "u" + store.NewID()
	f.s.Store.EnqueueDeletionCallback(ctx, &store.DeletionCallback{UID: old, Environment: "test", RequestedAt: time.Now().Add(-130 * time.Hour),
		CompletedAt: time.Now().Add(-73 * time.Hour), Via: viaSweep})
	stub.status = 500
	if n := f.s.deletionCallbackSweep(ctx); n["deletion_callbacks_failed"] != 1 {
		t.Fatalf("give up %v", n)
	}
}

// The backstop read: svs-backend's service account only, completions
// since the given time.
func TestInternalDeletionsBackstop(t *testing.T) {
	f, _ := handoffFixture(t)
	ctx := context.Background()
	f.s.Cfg.SVSBackendServiceAccounts = []string{"svs-backend@example.iam.gserviceaccount.com"}
	f.s.InternalCaller = func(_ context.Context, tok string) (string, error) {
		switch tok {
		case "good":
			return "svs-backend@example.iam.gserviceaccount.com", nil
		case "other":
			return "someone@example.iam.gserviceaccount.com", nil
		}
		return "", errors.New("bad token")
	}
	since := time.Now().UTC().Add(-time.Minute)
	f.s.deletionCompleted(ctx, f.uid, time.Now().Add(-48*time.Hour), viaSweep)
	get := func(tok, q string) (int, []map[string]any) {
		r := httptest.NewRequest(http.MethodGet, "/v1/internal/account-deletions"+q, nil)
		if tok != "" {
			r.Header.Set("Authorization", "Bearer "+tok)
		}
		w := httptest.NewRecorder()
		f.s.HandleInternalDeletions(w, r)
		var out []map[string]any
		json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	q := "?state=completed&since=" + since.Format(time.RFC3339)
	for _, tok := range []string{"", "bad", "other"} {
		if code, _ := get(tok, q); code != 401 {
			t.Fatalf("%q: %d", tok, code)
		}
	}
	code, rows := get("good", q)
	found := false
	for _, r := range rows {
		if r["uid"] == f.uid && r["via"] == "sweep" && r["completed_at"] != nil {
			found = true
		}
	}
	if code != 200 || !found {
		t.Fatalf("backstop %d %v", code, rows)
	}
	if code, _ := get("good", "?state=pending&since="+since.Format(time.RFC3339)); code != 400 {
		t.Fatal("state")
	}
	if code, rows := get("good", "?state=completed&since="+time.Now().Add(time.Hour).UTC().Format(time.RFC3339)); code != 200 || len(rows) != 0 {
		t.Fatalf("future since %d %v", code, rows)
	}
}

// The probe: operator token, test only, an unknown uid only (no Firebase
// user, no records), exactly one callback outside the outbox, audited.
func TestDeletionCallbackProbe(t *testing.T) {
	f, stub := handoffFixture(t)
	ctx := context.Background()
	f.s.Cfg.ReconcileToken = "tok"
	known := map[string]bool{"real-user": true}
	f.s.SignInLookup = func(_ context.Context, uid string) (*auth.SignInInfo, error) {
		if known[uid] {
			return &auth.SignInInfo{Providers: []string{"google.com"}}, nil
		}
		return nil, nil
	}
	probe := func(tok, body string) (int, map[string]any) {
		r := httptest.NewRequest(http.MethodPost, "/internal/deletion-callback-probe", strings.NewReader(body))
		if tok != "" {
			r.Header.Set("X-Reconcile-Token", tok)
		}
		w := httptest.NewRecorder()
		f.s.HandleDeletionCallbackProbe(w, r)
		return decode(w)
	}
	if code, _ := probe("", `{"uid":"x"}`); code != 401 {
		t.Fatalf("no token %d", code)
	}
	if code, out := probe("tok", `{"uid":"real-user"}`); code != 409 || out["error"] != "user_exists" {
		t.Fatalf("firebase user %d %v", code, out)
	}
	if code, out := probe("tok", `{"uid":"`+f.uid+`"}`); code != 409 || out["error"] != "known_uid" {
		t.Fatalf("billing record %d %v", code, out)
	}
	if len(stub.bodies) != 0 {
		t.Fatal("refusals sent a callback")
	}
	fake := "e2etest-" + store.NewID()
	code, out := probe("tok", `{"uid":"`+fake+`"}`)
	resp, _ := out["response"].(map[string]any)
	if code != 200 || out["status"] != float64(204) || resp["unknown"] != true || len(stub.bodies) != 1 || stub.bodies[0]["uid"] != fake || stub.bodies[0]["via"] != "admin" {
		t.Fatalf("probe %d %v %v", code, out, stub.bodies)
	}
	if _, err := f.s.Store.GetDeletionCallback(ctx, fake); err != store.ErrNotFound {
		t.Fatal("the probe used the outbox")
	}
	f.s.Cfg.Env = "prod"
	if code, _ := probe("tok", `{"uid":"`+fake+`2"}`); code != 403 {
		t.Fatalf("prod %d", code)
	}
}
