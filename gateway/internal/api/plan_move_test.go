package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"cloud.google.com/go/firestore"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func adminDo(s *Service, a *AdminUser, method, url, body string, h func(http.ResponseWriter, *http.Request, *AdminUser)) (int, map[string]any) {
	w := httptest.NewRecorder()
	h(w, httptest.NewRequest(method, url, strings.NewReader(body)), a)
	return decode(w)
}

func passkeyAdmin(at time.Time) *AdminUser {
	return &AdminUser{UID: "admin", Email: "owner@x", Method: "passkey", AssertedAt: at}
}

// moveFixture: a cancelled yearly Studio plan on a live account, a case
// opened for it, and a receiving account (emulator and fakes only).
func moveFixture(t *testing.T) (planFixture, *fakeIdentities, string, string) {
	t.Helper()
	f := newPlanFixture(t, "studio", "studio", 1198800, 70, 365)
	ctx := context.Background()
	ids := newFakeIdentities()
	f.s.Identities, f.s.Sessions, f.s.EmailCodes = ids, &fakeSessions{ids: ids}, &fakeCodes{spent: map[string]bool{}}
	f.s.UserExists = func(context.Context, string) (bool, error) { return true, nil }
	ids.add(f.uid, "from."+store.NewID()+"@example.com", "google.com")
	f.s.Store.UpdateCustomer(ctx, f.uid, func(c *store.Customer) error { c.Plan.Interval = "year"; return nil })
	f.fake.subs[f.sub]["items"] = map[string]any{"data": []any{map[string]any{"id": "si_1",
		"price": map[string]any{"id": "price_old", "recurring": map[string]any{"interval": "year"}}}}}
	c, _ := f.s.Store.GetCustomer(ctx, f.uid)
	def, _ := f.s.rates(ctx).Plan("studio")
	f.s.grantPlanMonth(ctx, f.uid, c.Plan, def, time.Now())
	callAs(f, f.s.HandleAccountPlanCancel, http.MethodPost, ``, false)
	to := "u" + store.NewID()
	ids.add(to, "to."+store.NewID()+"@example.com")
	code, out := adminDo(f.s, passkeyAdmin(time.Now()), http.MethodPost, "/v1/admin/cases",
		`{"uid":"`+f.uid+`","reason":"plan_move","text":"Checked the Stripe receipt and the card's last 4 with the customer."}`, f.s.HandleAdminOpenCase)
	cases, _ := out["cases"].([]any)
	if code != 200 || len(cases) != 1 {
		t.Fatalf("open case %d %v", code, out)
	}
	caseID := cases[0].(map[string]any)["case"].(map[string]any)["id"].(string)
	return f, ids, caseID, to
}

func moveAction(f planFixture, a *AdminUser, caseID, body string) (int, map[string]any) {
	return adminDo(f.s, a, http.MethodPost, "/", body, func(w http.ResponseWriter, r *http.Request, a *AdminUser) {
		f.s.HandleAdminCaseAction(w, r, a, caseID)
	})
}

// RP-05: preview, offer (a fresh passkey), the receiving account sees it
// and accepts (fresh): Stripe re-pointed (moved_from, never cancelled),
// the plan moves in one go (the old account keeps plan_moved_to), the
// credit carries once, months aren't given twice, the plan never renews;
// the accept again is a no-op; the case closes; audit rows written.
func TestPlanMoveOfferAndAccept(t *testing.T) {
	f, _, caseID, to := moveFixture(t)
	ctx := context.Background()
	s := f.s
	code, prev := adminDo(s, passkeyAdmin(time.Now()), http.MethodGet, "/?to="+to, "", func(w http.ResponseWriter, r *http.Request, a *AdminUser) {
		s.HandleAdminPlanMovePreview(w, r, a, caseID)
	})
	if code != 200 || len(prev["blockers"].([]any)) != 0 || prev["subscription_id"] != f.sub || prev["carry_cents"] != float64(150000) {
		t.Fatalf("preview %d %v", code, prev)
	}
	offer := `{"action":"offer_plan_move","to_uid":"` + to + `","expected_subscription_id":"` + f.sub + `"}`
	if code, out := moveAction(f, passkeyAdmin(time.Now().Add(-10*time.Minute)), caseID, offer); code != 401 || out["error"] != "reauth_required" {
		t.Fatalf("stale passkey %d %v", code, out)
	}
	if code, out := moveAction(f, passkeyAdmin(time.Now()), caseID, `{"action":"offer_plan_move","to_uid":"`+to+`","expected_subscription_id":"sub_other"}`); code != 409 || out["error"] != "subscription_changed" {
		t.Fatalf("stale subscription %d %v", code, out)
	}
	if code, out := moveAction(f, passkeyAdmin(time.Now()), caseID, offer); code != 200 {
		t.Fatalf("offer %d %v", code, out)
	}
	if code, out := moveAction(f, passkeyAdmin(time.Now()), caseID, offer); code != 409 || out["error"] != "move_open" {
		t.Fatalf("second offer %d %v", code, out)
	}
	// nothing moved yet
	if c, _ := s.Store.GetCustomer(ctx, f.uid); c.Plan == nil || c.PlanMovedTo != "" {
		t.Fatal("moved on the offer")
	}
	// only the receiving account sees it
	if _, out := callRestoreAs(s, f.uid, s.HandleSupportPlanMoves, ``); len(out["moves"].([]any)) != 0 {
		t.Fatalf("the old account sees it %v", out)
	}
	_, out := callRestoreAs(s, to, s.HandleSupportPlanMoves, ``)
	moves := out["moves"].([]any)
	if len(moves) != 1 {
		t.Fatalf("moves %v", out)
	}
	mv := moves[0].(map[string]any)
	if mv["plan"] != "studio" || anyStrings(mv["from"])[0] != "google.com" || strings.Contains(raw(mv), f.uid) {
		t.Fatalf("move row %v", mv)
	}
	id := mv["id"].(string)
	accept := func(uid string) (int, map[string]any) {
		return callRestoreAs(s, uid, func(w http.ResponseWriter, r *http.Request, u *AuthedUser) {
			s.HandleSupportPlanMoveAccept(w, r, u, id)
		}, ``)
	}
	if code, out := accept("u" + store.NewID()); code != 404 || out["error"] != "move_not_found" {
		t.Fatalf("someone else %d %v", code, out)
	}
	cancels := countForms(f.fake, "cancel_at_period_end")
	if code, out := accept(to); code != 200 || out["moved"] != true {
		t.Fatalf("accept %d %v", code, out)
	}
	md := f.fake.subs[f.sub]["metadata"].(map[string]string)
	if md["user_id"] != to || md["moved_from"] != f.uid || countForms(f.fake, "cancel_at_period_end") != cancels {
		t.Fatalf("stripe %v", md)
	}
	old, _ := s.Store.GetCustomer(ctx, f.uid)
	if old.Plan != nil || old.PlanMovedTo != to {
		t.Fatalf("old account %+v", old)
	}
	nc, _ := s.Store.GetCustomer(ctx, to)
	if nc.Plan == nil || nc.Plan.SubscriptionID != f.sub || !planNotRenewable(nc.Plan) {
		t.Fatalf("new plan %+v", nc.Plan)
	}
	if b, _ := s.Store.GetBalance(ctx, to); b.PlanCreditCents() != 150000 {
		t.Fatalf("carried %d", b.PlanCreditCents())
	}
	if b, _ := s.Store.GetBalance(ctx, f.uid); b.PlanCreditCents() != 0 {
		t.Fatalf("left on the old account %d", b.PlanCreditCents())
	}
	def, _ := s.rates(ctx).Plan("studio")
	if s.grantPlanMonth(ctx, to, nc.Plan, def, time.Now()) {
		t.Fatal("this month granted twice")
	}
	if code, out := accept(to); code != 200 || out["moved"] != true {
		t.Fatalf("again %d %v", code, out)
	}
	if b, _ := s.Store.GetBalance(ctx, to); b.PlanCreditCents() != 150000 {
		t.Fatalf("carried twice %d", b.PlanCreditCents())
	}
	cs, _ := s.Store.GetCase(ctx, caseID)
	if cs.Open || cs.PlanMove == nil || cs.PlanMove.State != store.PlanMoveDone || cs.PlanMove.TokenHash == "" || strings.Contains(cs.PlanMove.TokenHash, id) {
		t.Fatalf("case %+v %+v", cs, cs.PlanMove)
	}
	b, _ := json.Marshal(cs)
	if strings.Contains(string(b), id) {
		t.Fatal("the case shows the move id")
	}
}

// Blockers: a plan that still renews (refused until cancelled, the owner's
// open question), the receiving account's own plan, the same account; an
// offer withdrawn can't be accepted; an expired one is 410.
func TestPlanMoveBlockersCancelExpiry(t *testing.T) {
	f, _, caseID, to := moveFixture(t)
	ctx := context.Background()
	s := f.s
	preview := func(target string) []string {
		_, out := adminDo(s, passkeyAdmin(time.Now()), http.MethodGet, "/?to="+target, "", func(w http.ResponseWriter, r *http.Request, a *AdminUser) {
			s.HandleAdminPlanMovePreview(w, r, a, caseID)
		})
		return anyStrings(out["blockers"])
	}
	if b := preview(f.uid); len(b) == 0 || b[0] != "same_account" {
		t.Fatalf("same %v", b)
	}
	s.Store.UpdateCustomer(ctx, f.uid, func(c *store.Customer) error { c.Plan.CancelAtPeriodEnd = false; return nil })
	if b := preview(to); len(b) != 1 || b[0] != "plan_renewing" {
		t.Fatalf("renewing %v", b)
	}
	s.Store.UpdateCustomer(ctx, f.uid, func(c *store.Customer) error { c.Plan.CancelAtPeriodEnd = true; return nil })
	busy := "u" + store.NewID()
	end := time.Now().Add(30 * 24 * time.Hour)
	s.Store.PutCustomer(ctx, busy, &store.Customer{Plan: &store.Plan{Tier: "business", SubscriptionID: "sub_own", Status: "active", CurrentPeriodEnd: &end}})
	if b := preview(busy); len(b) != 1 || b[0] != "target_has_plan" {
		t.Fatalf("own plan %v", b)
	}
	offer := `{"action":"offer_plan_move","to_uid":"` + to + `","expected_subscription_id":"` + f.sub + `"}`
	if code, out := moveAction(f, passkeyAdmin(time.Now()), caseID, offer); code != 200 {
		t.Fatalf("offer %d %v", code, out)
	}
	_, out := callRestoreAs(s, to, s.HandleSupportPlanMoves, ``)
	id := out["moves"].([]any)[0].(map[string]any)["id"].(string)
	if code, out := moveAction(f, passkeyAdmin(time.Now()), caseID, `{"action":"cancel_plan_move"}`); code != 200 {
		t.Fatalf("cancel %d %v", code, out)
	}
	accept := func() (int, map[string]any) {
		return callRestoreAs(s, to, func(w http.ResponseWriter, r *http.Request, u *AuthedUser) {
			s.HandleSupportPlanMoveAccept(w, r, u, id)
		}, ``)
	}
	if code, out := accept(); code != 404 {
		t.Fatalf("cancelled %d %v", code, out)
	}
	// a new offer, then 7 days pass
	moveAction(f, passkeyAdmin(time.Now()), caseID, offer)
	_, out = callRestoreAs(s, to, s.HandleSupportPlanMoves, ``)
	id = out["moves"].([]any)[0].(map[string]any)["id"].(string)
	s.Store.UpdatePlanMove(ctx, f.sub, []firestoreUpdate{{Path: "expires_at", Value: time.Now().Add(-time.Minute)}})
	if code, out := accept(); code != 410 || out["error"] != "move_expired" {
		t.Fatalf("expired %d %v", code, out)
	}
	if c, _ := s.Store.GetCustomer(ctx, f.uid); c.Plan == nil {
		t.Fatal("moved after expiry")
	}
	// the plan resumed after the offer: the accept refuses and the offer stays
	moveAction(f, passkeyAdmin(time.Now()), caseID, offer)
	_, out = callRestoreAs(s, to, s.HandleSupportPlanMoves, ``)
	id = out["moves"].([]any)[0].(map[string]any)["id"].(string)
	s.Store.UpdateCustomer(ctx, f.uid, func(c *store.Customer) error { c.Plan.CancelAtPeriodEnd = false; return nil })
	if code, out := accept(); code != 409 || out["error"] != "plan_renewing" {
		t.Fatalf("renewing at accept %d %v", code, out)
	}
	if m, _ := s.Store.GetPlanMove(ctx, f.sub); m.State != store.PlanMoveOffered {
		t.Fatalf("offer state %s", m.State)
	}
}

type firestoreUpdate = firestore.Update
