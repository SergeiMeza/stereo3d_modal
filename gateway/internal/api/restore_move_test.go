package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func callRestoreAs(s *Service, uid string, h func(http.ResponseWriter, *http.Request, *AuthedUser), body string) (int, map[string]any) {
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	r.Header.Set("X-Client-IP", uniqueIP())
	w := httptest.NewRecorder()
	h(w, r, &AuthedUser{UID: uid, AuthTime: time.Now()})
	return decode(w)
}

// restoreFixture: a yearly Studio plan three months in, its month credit
// partly spent, cancelled and its account deleted (emulator and fakes
// only; no real account is touched).
func restoreFixture(t *testing.T) (planFixture, *fakeIdentities, string) {
	t.Helper()
	f := newPlanFixture(t, "studio", "studio", 1198800, 70, 365)
	ctx := context.Background()
	ids := newFakeIdentities()
	f.s.Identities, f.s.Sessions, f.s.EmailCodes = ids, &fakeSessions{ids: ids}, &fakeCodes{spent: map[string]bool{}}
	f.s.UserExists = func(context.Context, string) (bool, error) { return true, nil }
	email := "owner." + store.NewID() + "@example.com"
	ids.add(f.uid, email)
	ids.holds("apple.com", "apple-"+f.uid, f.uid)
	f.s.Store.UpdateCustomer(ctx, f.uid, func(c *store.Customer) error { c.Email, c.Plan.Interval = email, "year"; return nil })
	f.fake.subs[f.sub]["items"] = map[string]any{"data": []any{map[string]any{"id": "si_1",
		"price": map[string]any{"id": "price_old", "recurring": map[string]any{"interval": "year"}}}}}
	c, _ := f.s.Store.GetCustomer(ctx, f.uid)
	def, _ := f.s.rates(ctx).Plan("studio")
	if !f.s.grantPlanMonth(ctx, f.uid, c.Plan, def, time.Now()) {
		t.Fatal("month not granted")
	}
	if code, out := callAs(f, f.s.HandleAccountPlanCancel, http.MethodPost, ``, false); code != 200 {
		t.Fatalf("cancel %d %v", code, out)
	}
	if code, out := deleteAccount(f, `{}`, false); code != 200 || out["deleted"] != true {
		t.Fatalf("delete %d %v", code, out)
	}
	return f, ids, email
}

// RP-01/02/04, DL-01: found by the deleted account's email (with a code),
// moved once onto a new account: the subscription points to it and isn't
// cancelled again, this month's unspent credit carries over once, the
// month given before isn't given again and the next one is; a second move
// is a no-op; another account then hears restored_elsewhere.
func TestRestoreMoveFromDeletedAccount(t *testing.T) {
	f, ids, email := restoreFixture(t)
	ctx := context.Background()
	s := f.s
	rec, err := s.Store.GetPlanRestore(ctx, f.sub)
	if err != nil || rec.State != store.PlanRestoreAvailable || rec.CarryCents != 150000 || len(rec.CreditMonthsGranted) != 1 || len(rec.SubjectHashes) != 1 {
		t.Fatalf("record %+v %v", rec, err)
	}
	if b, _ := s.Store.GetBalance(ctx, f.uid); b.PlanCreditCents() != 0 {
		t.Fatalf("credit left on the deleted account: %d", b.PlanCreditCents())
	}
	me := "u" + store.NewID()
	ids.add(me, "new."+store.NewID()+"@example.com")
	if code, out := callRestoreAs(s, me, s.HandleRestoreFind, `{"email":"`+email+`"}`); code != 202 || out["sent"] != true {
		t.Fatalf("find %d %v", code, out)
	}
	if code, out := callRestoreAs(s, me, s.HandleRestoreFind, `{"email":"nobody@example.com"}`); code != 202 || out["sent"] != true {
		t.Fatalf("find, nothing there: the same answer %d %v", code, out)
	}
	code, out := callRestoreAs(s, me, s.HandleRestoreFindVerify, `{"email":"`+email+`","code":"123456"}`)
	found, _ := out["found"].([]any)
	if code != 200 || len(found) != 1 || out["proof_id"] == nil {
		t.Fatalf("verify %d %v", code, out)
	}
	offer := found[0].(map[string]any)
	if offer["plan"] != "studio" || offer["renews"] != false || offer["carry_cents"] != float64(150000) ||
		!strings.Contains(strings.Join(anyStrings(offer["moves"]), ","), "months_not_yet_given") || anyStrings(offer["from"])[0] != "apple.com" {
		t.Fatalf("offer %v", offer)
	}
	proof, offerID := out["proof_id"].(string), offer["offer_id"].(string)
	if strings.Contains(offerID, f.sub) {
		t.Fatal("the offer id shows the Stripe id")
	}
	cancelsBefore := countForms(f.fake, "cancel_at_period_end")
	code, out = callRestoreAs(s, me, s.HandleRestoreMove, `{"proof_id":"`+proof+`","offer_id":"`+offerID+`"}`)
	if code != 200 || out["restored"] != true {
		t.Fatalf("move %d %v", code, out)
	}
	md := f.fake.subs[f.sub]["metadata"].(map[string]string)
	if md["user_id"] != me || md["restored_from"] != f.uid || f.fake.subs[f.sub]["status"] != "active" || countForms(f.fake, "cancel_at_period_end") != cancelsBefore {
		t.Fatalf("stripe %v", f.fake.subs[f.sub])
	}
	c, _ := s.Store.GetCustomer(ctx, me)
	if c.Plan == nil || c.Plan.SubscriptionID != f.sub || c.Plan.RestoredFrom != f.uid || !c.Plan.Yearly() {
		t.Fatalf("plan %+v", c.Plan)
	}
	b, _ := s.Store.GetBalance(ctx, me)
	if b.PlanCreditCents() != 150000 {
		t.Fatalf("carried %d", b.PlanCreditCents())
	}
	def, _ := s.rates(ctx).Plan("studio")
	if s.grantPlanMonth(ctx, me, c.Plan, def, time.Now()) {
		t.Fatal("this month granted again")
	}
	if !s.grantPlanMonth(ctx, me, c.Plan, def, store.AddMonths(*c.Plan.CurrentPeriodStart, 3).Add(time.Hour)) {
		t.Fatal("the next month not granted")
	}
	// again: a no-op
	before, _ := s.Store.GetBalance(ctx, me)
	code, out = callRestoreAs(s, me, s.HandleRestoreMove, `{"proof_id":"`+proof+`","offer_id":"`+offerID+`"}`)
	if b2, _ := s.Store.GetBalance(ctx, me); code != 200 || out["restored"] != true || b2.PlanCreditCents() != before.PlanCreditCents() {
		t.Fatalf("again %d %v", code, out)
	}
	// someone else with the same email: restored elsewhere, named by how it signs in
	other := "u" + store.NewID()
	ids.add(other, "")
	s.EmailCodes.(*fakeCodes).spent[email] = false
	code, out = callRestoreAs(s, other, s.HandleRestoreFindVerify, `{"email":"`+email+`","code":"123456"}`)
	if d, _ := out["details"].(map[string]any); code != 409 || out["error"] != "restored_elsewhere" || d == nil || strings.Contains(raw(out), me) {
		t.Fatalf("elsewhere %d %v", code, out)
	}
}

// RP-03: an account with its own paid plan is refused (Contact support);
// RP-04: the deleted account's Apple sign-in finds it with no email; a
// relay address never matches; a spent or foreign proof is refused.
func TestRestoreMoveRefusals(t *testing.T) {
	f, ids, _ := restoreFixture(t)
	ctx := context.Background()
	s := f.s
	// a new account signed in with the same Apple ID (a new Firebase user)
	me := "u" + store.NewID()
	ids.add(me, "")
	ids.mu.Lock()
	ids.users[me].Providers = []string{"apple.com"}
	ids.users[me].Subjects = map[string]string{"apple.com": "apple-" + f.uid}
	ids.mu.Unlock()
	code, out := callRestoreAs(s, me, s.HandleRestoreFindVerify, `{}`)
	found, _ := out["found"].([]any)
	if code != 200 || len(found) != 1 {
		t.Fatalf("by subject %d %v", code, out)
	}
	proof, offerID := out["proof_id"].(string), found[0].(map[string]any)["offer_id"].(string)
	// another account can't use this proof
	if code, out := callRestoreAs(s, "u"+store.NewID(), s.HandleRestoreMove, `{"proof_id":"`+proof+`","offer_id":"`+offerID+`"}`); code != 400 || out["error"] != "proof_invalid" {
		t.Fatalf("foreign proof %d %v", code, out)
	}
	// its own plan: refused
	end := time.Now().Add(30 * 24 * time.Hour)
	s.Store.PutCustomer(ctx, me, &store.Customer{Plan: &store.Plan{Tier: "business", SubscriptionID: "sub_own", Status: "active", CurrentPeriodEnd: &end}})
	if code, out := callRestoreAs(s, me, s.HandleRestoreMove, `{"proof_id":"`+proof+`","offer_id":"`+offerID+`"}`); code != 409 || out["error"] != "has_own_plan" {
		t.Fatalf("own plan %d %v", code, out)
	}
	if rec, _ := s.Store.GetPlanRestore(ctx, f.sub); rec.State != store.PlanRestoreAvailable {
		t.Fatalf("claimed though refused: %+v", rec)
	}
	// a relay address never matches
	relay := "z" + store.NewID() + "@privaterelay.appleid.com"
	plain := "u" + store.NewID()
	ids.add(plain, "")
	if code, out := callRestoreAs(s, plain, s.HandleRestoreFindVerify, `{"email":"`+relay+`","code":"123456"}`); code != 200 || len(out["found"].([]any)) != 0 || out["message"] != restoreMsgNone {
		t.Fatalf("relay %d %v", code, out)
	}
}

func anyStrings(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

func countForms(f *fakeStripe, key string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, form := range f.subUpdates {
		if _, ok := form[key]; ok {
			n++
		}
	}
	return n
}

func raw(out map[string]any) string {
	var b strings.Builder
	for k, v := range out {
		b.WriteString(k)
		b.WriteString(fmtAny(v))
	}
	return b.String()
}

func fmtAny(v any) string { return fmt.Sprint(v) }

// A monthly plan's invoice replayed after a restore (a webhook again, the
// resync) grants nothing on the new account: its credit was granted on
// the deleted one and carried over once.
func TestRestoredMonthlyInvoiceNotGrantedAgain(t *testing.T) {
	f := newPlanFixture(t, "business", "business", 29900, 3, 30)
	ctx := context.Background()
	s := f.s
	ids := newFakeIdentities()
	s.Identities, s.Sessions, s.EmailCodes = ids, &fakeSessions{ids: ids}, &fakeCodes{spent: map[string]bool{}}
	s.UserExists = func(context.Context, string) (bool, error) { return true, nil }
	ids.add(f.uid, "biz."+store.NewID()+"@example.com")
	ids.holds("google.com", "g-"+f.uid, f.uid)
	inv := fmt.Sprintf(`{"id":"in_%s","subscription":"%s","billing_reason":"subscription_cycle","lines":{"data":[{"amount":29900}]}}`, f.sub, f.sub)
	s.handlePlanInvoicePaid(ctx, []byte(inv))
	callAs(f, s.HandleAccountPlanCancel, http.MethodPost, ``, false)
	if code, out := deleteAccount(f, `{}`, false); code != 200 {
		t.Fatalf("delete %d %v", code, out)
	}
	me := "u" + store.NewID()
	ids.add(me, "")
	ids.mu.Lock()
	ids.users[me].Providers, ids.users[me].Subjects = []string{"google.com"}, map[string]string{"google.com": "g-" + f.uid}
	ids.mu.Unlock()
	_, out := callRestoreAs(s, me, s.HandleRestoreFindVerify, `{}`)
	found := out["found"].([]any)
	if len(found) != 1 {
		t.Fatalf("found %v", out)
	}
	body := `{"proof_id":"` + out["proof_id"].(string) + `","offer_id":"` + found[0].(map[string]any)["offer_id"].(string) + `"}`
	if code, out := callRestoreAs(s, me, s.HandleRestoreMove, body); code != 200 {
		t.Fatalf("move %d %v", code, out)
	}
	before, _ := s.Store.GetBalance(ctx, me)
	s.handlePlanInvoicePaid(ctx, []byte(inv))
	if after, _ := s.Store.GetBalance(ctx, me); after.PlanCreditCents() != before.PlanCreditCents() || before.PlanCreditCents() == 0 {
		t.Fatalf("credit %d → %d", before.PlanCreditCents(), after.PlanCreditCents())
	}
}

// A restored plan never renews (its card is the other account's): the
// plan reads renewable false and restored_from true (never the old uid);
// resume, Keep plan, cancel {resume} and plan changes are 409
// not_renewable; nothing reaches Stripe.
func TestRestoredPlanNeverRenews(t *testing.T) {
	for _, tc := range []struct{ planID, tier string }{{"studio", "studio"}, {"pro_monthly", "pro"}} {
		t.Run(tc.planID, func(t *testing.T) {
			f := newPlanFixture(t, tc.planID, tc.tier, 1000, 3, 30)
			ctx := context.Background()
			f.s.Store.UpdateCustomer(ctx, f.uid, func(c *store.Customer) error {
				c.Plan.RestoredFrom, c.Plan.CancelAtPeriodEnd = "u-old-account", true
				return nil
			})
			f.fake.subs[f.sub]["cancel_at_period_end"] = true
			p := f.s.planJSON(ctx, f.uid)
			if p["renewable"] != false || p["restored_from"] != true || strings.Contains(fmt.Sprint(p), "u-old-account") {
				t.Fatalf("plan %v", p)
			}
			if tc.tier == "pro" {
				ps := f.s.withWebPlan(ctx, f.uid, ProStatus{})
				if ps.Renewable == nil || *ps.Renewable || !ps.RestoredFrom {
					t.Fatalf("pro %+v", ps)
				}
			}
			calls := f.fake.subCalls
			for name, call := range map[string]func() (int, map[string]any){
				"resume": func() (int, map[string]any) {
					return callAs(f, f.s.HandleAccountPlanResume, http.MethodPost, ``, false)
				},
				"keep plan": func() (int, map[string]any) {
					return callAs(f, f.s.HandleCancelScheduledChange, http.MethodDelete, ``, false)
				},
				"cancel resume":  func() (int, map[string]any) { return f.post(f.s.HandleCancelPlan, `{"resume":true}`) },
				"change":         func() (int, map[string]any) { return f.post(f.s.HandlePlanChange, `{"to":"business","confirm":true}`) },
				"preview change": func() (int, map[string]any) { return f.post(f.s.HandlePreviewPlanChange, `{"to":"pro_yearly"}`) },
			} {
				if code, out := call(); code != 409 || out["error"] != "not_renewable" || !strings.Contains(out["message"].(string), "restored from another account and ends on") {
					t.Fatalf("%s: %d %v", name, code, out)
				}
			}
			if f.fake.subCalls != calls || f.fake.subs[f.sub]["cancel_at_period_end"] != true {
				t.Fatal("Stripe was asked")
			}
		})
	}
}

// A plan that still renews on a deleted account (an old deletion path:
// deletion now needs a cancel) is found but never moved: 409
// plan_renewing_support; nothing changes; never cancelled (DL-01).
func TestRestoreRefusesRenewingPlan(t *testing.T) {
	f := newPlanFixture(t, "business", "business", 29900, 3, 30)
	ctx := context.Background()
	s := f.s
	ids := newFakeIdentities()
	s.Identities, s.Sessions, s.EmailCodes = ids, &fakeSessions{ids: ids}, &fakeCodes{spent: map[string]bool{}}
	s.UserExists = func(context.Context, string) (bool, error) { return true, nil }
	ids.add(f.uid, "renews."+store.NewID()+"@example.com")
	ids.holds("apple.com", "a-"+f.uid, f.uid)
	if err := s.finishAccountDeletionKeeping(ctx, f.uid, true); err != nil { // the old path: no cancel first
		t.Fatal(err)
	}
	me := "u" + store.NewID()
	ids.add(me, "")
	ids.mu.Lock()
	ids.users[me].Providers, ids.users[me].Subjects = []string{"apple.com"}, map[string]string{"apple.com": "a-" + f.uid}
	ids.mu.Unlock()
	_, out := callRestoreAs(s, me, s.HandleRestoreFindVerify, `{}`)
	found := out["found"].([]any)
	if len(found) != 1 || found[0].(map[string]any)["renews"] != true {
		t.Fatalf("found %v", out)
	}
	body := `{"proof_id":"` + out["proof_id"].(string) + `","offer_id":"` + found[0].(map[string]any)["offer_id"].(string) + `"}`
	calls := countForms(f.fake, "cancel_at_period_end")
	code, out := callRestoreAs(s, me, s.HandleRestoreMove, body)
	if code != 409 || out["error"] != "plan_renewing_support" || out["message"] != "This plan still renews on another account. Contact support to move it." {
		t.Fatalf("move %d %v", code, out)
	}
	if rec, _ := s.Store.GetPlanRestore(ctx, f.sub); rec.State != store.PlanRestoreAvailable {
		t.Fatalf("claimed %+v", rec)
	}
	md := f.fake.subs[f.sub]["metadata"].(map[string]string)
	if md["user_id"] != f.uid || countForms(f.fake, "cancel_at_period_end") != calls || f.fake.subs[f.sub]["cancel_at_period_end"] == true {
		t.Fatalf("changed in Stripe %v", f.fake.subs[f.sub])
	}
	if c, err := s.Store.GetCustomer(ctx, me); err == nil && c.Plan != nil {
		t.Fatalf("plan moved %+v", c.Plan)
	}
}

// The billing portal opens only the caller's own customer, for a live
// account: a deleted one is refused; an account whose plan was moved off
// it is refused while that plan runs on its customer; the receiving
// account gets a customer of its own, never the old one.
func TestBillingPortalGuards(t *testing.T) {
	f, _, caseID, to := moveFixture(t)
	ctx := context.Background()
	s := f.s
	portal := func(uid string) (int, map[string]any) {
		return callRestoreAs(s, uid, s.HandleBillingPortal, `{"return_url":"https://stereo3d.studio/account"}`)
	}
	if code, out := portal(f.uid); code != 200 || out["url"] == nil {
		t.Fatalf("before the move %d %v", code, out)
	}
	moveAction(f, passkeyAdmin(time.Now()), caseID, `{"action":"offer_plan_move","to_uid":"`+to+`","expected_subscription_id":"`+f.sub+`"}`)
	_, out := callRestoreAs(s, to, s.HandleSupportPlanMoves, ``)
	id := out["moves"].([]any)[0].(map[string]any)["id"].(string)
	if code, out := callRestoreAs(s, to, func(w http.ResponseWriter, r *http.Request, u *AuthedUser) { s.HandleSupportPlanMoveAccept(w, r, u, id) }, ``); code != 200 {
		t.Fatalf("accept %d %v", code, out)
	}
	if code, out := portal(f.uid); code != 409 || out["error"] != "portal_unavailable" {
		t.Fatalf("old account %d %v", code, out)
	}
	f.fake.mu.Lock()
	before := len(f.fake.portals)
	f.fake.mu.Unlock()
	if code, out := portal(to); code != 200 {
		t.Fatalf("new account %d %v", code, out)
	}
	f.fake.mu.Lock()
	got := f.fake.portals[before]
	f.fake.mu.Unlock()
	if got == "" || got == "cus_1" {
		t.Fatalf("portal customer %q", got)
	}
	if c, _ := s.Store.GetCustomer(ctx, to); c.StripeCustomerID != got {
		t.Fatalf("own customer %q vs %q", c.StripeCustomerID, got)
	}
	// a deleted account
	gone := "u" + store.NewID()
	s.Store.PutCustomer(ctx, gone, &store.Customer{StripeCustomerID: "cus_gone", AccountDeleted: true})
	if code, out := portal(gone); code != 403 || out["error"] != "account_deleted" {
		t.Fatalf("deleted %d %v", code, out)
	}
}
