package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func cgCall(t *testing.T, h func(http.ResponseWriter, *http.Request), body string) (int, map[string]any) {
	t.Helper()
	w := httptest.NewRecorder()
	h(w, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body)))
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

// Grant credit: fresh sign-in, the cap, once per request_id, on the
// balance as kind grant (90 days by default, none with null), "Credit from
// Spatial Video Studio" in history without the reason, a dry-run mail off
// prod, revoke takes only what's left, the list's monthly totals.
func TestAdminCreditGrants(t *testing.T) {
	s, _ := e0Service(t)
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1", Email: "someone@example.test"})
	fresh := &AdminUser{UID: "admin", Email: "ops@example.test", Method: "passkey", AssertedAt: time.Now()}
	stale := &AdminUser{UID: "admin", Email: "ops@example.test", Method: "passkey", AssertedAt: time.Now().Add(-10 * time.Minute)}
	grant := func(a *AdminUser, body string) (int, map[string]any) {
		return cgCall(t, func(w http.ResponseWriter, r *http.Request) { s.HandleAdminCreditGrant(w, r, a, uid) }, body)
	}
	body := `{"amount_cents":2500,"reason":"support_goodwill","reason_text":"sorry for the wait","notify_user":true,"message":"Thanks for your patience.","request_id":"req-0001-abc"}`
	if code, _ := grant(stale, body); code != 401 && code != 403 {
		t.Fatalf("stale sign-in %d", code)
	}
	if code, out := grant(fresh, `{"amount_cents":60000,"reason":"promo","request_id":"req-0002-abc"}`); code != 409 || out["error"] != "over_cap" {
		t.Fatalf("over the cap %d %v", code, out)
	}
	if code, _ := grant(fresh, `{"amount_cents":100,"reason":"other","request_id":"req-0003-abc"}`); code != 400 {
		t.Fatal("other without text")
	}
	code, pv := cgCall(t, func(w http.ResponseWriter, r *http.Request) { s.HandleAdminCreditGrantPreview(w, r, fresh, uid) }, `{"amount_cents":2500,"reason":"promo"}`)
	if code != 200 || pv["balance_before_cents"] != 0.0 || pv["balance_after_cents"] != 2500.0 || pv["over_cap"] != false {
		t.Fatalf("preview %d %v", code, pv)
	}
	code, out := grant(fresh, body)
	g, _ := out["grant"].(map[string]any)
	ba, _ := out["balance_after"].(map[string]any)
	if code != 200 || g["state"] != "active" || g["mail_state"] != "dry_run" || g["unspent_cents"] != 2500.0 || ba["balance_cents"] != 2500.0 || out["replay"] != false {
		t.Fatalf("grant %d %v", code, out)
	}
	if exp, _ := time.Parse(time.RFC3339, g["expires_at"].(string)); exp.Sub(time.Now()) < 89*24*time.Hour {
		t.Fatalf("expiry %v", g["expires_at"])
	}
	credits := ba["credits"].([]any)
	if len(credits) != 1 || credits[0].(map[string]any)["kind"] != "grant" {
		t.Fatalf("credits %v", credits)
	}
	if code, out := grant(fresh, body); code != 200 || out["replay"] != true {
		t.Fatalf("replay %d %v", code, out)
	}
	if code, out := grant(fresh, strings.Replace(body, "2500", "2600", 1)); code != 409 || out["error"] != "request_id_reused" {
		t.Fatalf("reused id %d %v", code, out)
	}
	if b, _ := s.Store.GetBalance(ctx, uid); b.Available() != 2500 {
		t.Fatalf("granted twice: %d", b.Available())
	}
	// no end, over the cap with confirmation
	code, out = grant(fresh, `{"amount_cents":60000,"reason":"test","expires_days":null,"confirm_over_cap":true,"request_id":"req-0004-abc"}`)
	if g2 := out["grant"].(map[string]any); code != 200 || g2["expires_at"] != nil || g2["over_cap"] != true {
		t.Fatalf("no end %d %v", code, out)
	}
	// history: who gave it, never why
	entries, _, _ := s.Store.ListEntries(ctx, uid, 50, "")
	rows := creditRows(entries)
	found := false
	for _, r := range rows {
		if strings.HasPrefix(r.Label, "Credit from Spatial Video Studio · $25.00") {
			found = true
		}
		if strings.Contains(r.Label, "sorry") || strings.Contains(r.Label, "goodwill") {
			t.Fatalf("reason shown: %s", r.Label)
		}
	}
	if !found {
		t.Fatalf("history %+v", rows)
	}
	// spend $10 of it, then revoke: only the $15 left goes
	if _, _, err := s.Store.BalanceTx(ctx, uid, func(*store.Balance) ([]store.BalanceOp, error) {
		return []store.BalanceOp{{Kind: store.EntryAdjustment, Cents: -1000, Note: "spent"}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	id := g["id"].(string)
	revoke := func(a *AdminUser) (int, map[string]any) {
		return cgCall(t, func(w http.ResponseWriter, r *http.Request) { s.HandleAdminCreditGrantRevoke(w, r, a, uid, id) }, `{}`)
	}
	if code, _ := revoke(stale); code != 401 && code != 403 {
		t.Fatalf("stale revoke %d", code)
	}
	b0, _ := s.Store.GetBalance(ctx, uid)
	left := b0.RemainingByRef("admin:grant:" + id)
	code, out = revoke(fresh)
	if code != 200 || out["revoked_cents"] != float64(left) || out["grant"].(map[string]any)["state"] != "revoked" || left != 1500 {
		t.Fatalf("revoke %d %v (left %d)", code, out, left)
	}
	if code, out := revoke(fresh); code != 200 || out["revoked_cents"] != float64(left) {
		t.Fatalf("revoke again %d %v", code, out)
	}
	// the lists
	code, out = cgCall(t, func(w http.ResponseWriter, r *http.Request) { s.HandleAdminAccountCreditGrants(w, r, fresh, uid) }, ``)
	if code != 200 || len(out["grants"].([]any)) != 2 {
		t.Fatalf("account list %d %v", code, out)
	}
	code, out = cgCall(t, func(w http.ResponseWriter, r *http.Request) { s.HandleAdminAllCreditGrants(w, r, fresh) }, ``)
	months := out["months"].([]any)
	if code != 200 || len(months) != 1 || months[0].(map[string]any)["cents"] != 62500.0 || months[0].(map[string]any)["revoked_cents"] != float64(left) {
		t.Fatalf("all %d %v", code, out)
	}
}
