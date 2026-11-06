package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/auth"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func callEmails(s *Service, uid, method, path, body string) (int, map[string]any) {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("X-Client-IP", uniqueIP())
	w := httptest.NewRecorder()
	u := &AuthedUser{UID: uid, AuthTime: time.Now()}
	parts := strings.Split(strings.TrimPrefix(path, "/v1/account/emails"), "/")
	switch {
	case method == http.MethodGet:
		s.HandleAccountEmails(w, r, u)
	case path == "/v1/account/emails/start":
		s.HandleAccountEmailStart(w, r, u)
	case path == "/v1/account/emails":
		s.HandleAddAccountEmail(w, r, u)
	case method == http.MethodPost && len(parts) == 3 && parts[2] == "main":
		s.HandleSetMainEmail(w, r, u, parts[1])
	case method == http.MethodDelete:
		s.HandleRemoveAccountEmail(w, r, u, parts[1])
	}
	code, out := decode(w)
	return code, out
}

// emailService is identityService keeping the Stripe fake.
func emailService(t *testing.T) (*Service, *fakeIdentities, *fakeStripe) {
	s, fake := e0Service(t)
	s.MintToken = func(_ context.Context, uid string) (string, error) { return "custom-" + uid, nil }
	ids := newFakeIdentities()
	s.Identities, s.Sessions, s.EmailCodes = ids, &fakeSessions{ids: ids}, &fakeCodes{spent: map[string]bool{}}
	return s, ids, fake
}

type emailRow struct {
	ID, Email   string
	Main, Relay bool
}

func emailRows(out map[string]any) []emailRow {
	var rows []emailRow
	list, _ := out["emails"].([]any)
	for _, x := range list {
		m := x.(map[string]any)
		rows = append(rows, emailRow{ID: m["id"].(string), Email: m["email"].(string), Main: m["main"] == true, Relay: m["relay"] == true})
	}
	return rows
}

func businessPlan(t *testing.T, s *Service, uid, email string) {
	t.Helper()
	end := time.Now().Add(20 * 24 * time.Hour)
	if err := s.Store.PutCustomer(context.Background(), uid, &store.Customer{StripeCustomerID: "cus_" + uid, Email: email,
		Plan: &store.Plan{Tier: "business", Status: "active", SubscriptionID: "sub_" + uid, CurrentPeriodEnd: &end}}); err != nil {
		t.Fatal(err)
	}
}

// The list claims the Firebase email as main (no sync); a second email
// is added by code; making it main moves Firebase, customers.email and
// the Stripe customer, keeps the old one, and asks for a token refresh.
func TestAccountEmailsAddAndSwitchMain(t *testing.T) {
	s, ids, f := emailService(t)
	ctx := context.Background()
	me := "u" + store.NewID()
	ids.add(me, "first@example.com", "password")
	s.Store.PutCustomer(ctx, me, &store.Customer{StripeCustomerID: "cus_" + me, Email: "first@example.com"})

	code, out := callEmails(s, me, http.MethodGet, "/v1/account/emails", "")
	rows := emailRows(out)
	if code != 200 || len(rows) != 1 || rows[0].Email != "first@example.com" || !rows[0].Main || out["plan_email_needed"] != false {
		t.Fatalf("claimed %d %v", code, out)
	}
	if p, _ := s.Store.ListPendingEmailSyncs(ctx, 10); len(p) != 0 {
		t.Fatalf("a claim queued a sync: %+v", p)
	}
	code, out = callEmails(s, me, http.MethodPost, "/v1/account/emails/start", `{"email":"Second@Example.com","language":"zh-Hans"}`)
	if code != 202 || out["sent"] != true || out["resend_after_s"] != float64(30) {
		t.Fatalf("start %d %v", code, out)
	}
	if got := s.EmailCodes.(*fakeCodes).started; len(got) != 1 || got[0] != "second@example.com|zh-Hans" {
		t.Fatalf("started %v", got)
	}
	code, out = callEmails(s, me, http.MethodPost, "/v1/account/emails", `{"email":"second@example.com","code":"123456"}`)
	rows = emailRows(out)
	if code != 200 || len(rows) != 2 || rows[1].Email != "second@example.com" || rows[1].Main || out["refresh_token"] != false {
		t.Fatalf("added %d %v", code, out)
	}
	code, out = callEmails(s, me, http.MethodPost, "/v1/account/emails/"+rows[1].ID+"/main", "")
	rows = emailRows(out)
	if code != 200 || rows[0].Email != "second@example.com" || !rows[0].Main || rows[1].Main || out["refresh_token"] != true {
		t.Fatalf("switched %d %v", code, out)
	}
	if got, _ := ids.IdentityOf(ctx, me); got.Email != "second@example.com" || !got.EmailVerified {
		t.Fatalf("firebase %+v", got)
	}
	if c, _ := s.Store.GetCustomer(ctx, me); c.Email != "second@example.com" {
		t.Fatalf("customers.email %q", c.Email)
	}
	if p, _ := s.Store.ListPendingEmailSyncs(ctx, 10); len(p) != 0 {
		t.Fatalf("sync left pending: %+v", p)
	}
	f.mu.Lock()
	stripeEmail := ""
	if c := f.customers["cus_"+me]; c != nil {
		stripeEmail = c.email
	}
	f.mu.Unlock()
	if stripeEmail != "second@example.com" {
		t.Fatalf("stripe customer email %q", stripeEmail)
	}
	// the main can't go; the other can; an unknown id is 404
	if code, out := callEmails(s, me, http.MethodDelete, "/v1/account/emails/"+rows[0].ID, ""); code != 409 || out["error"] != "main_email_not_removable" {
		t.Fatalf("remove main %d %v", code, out)
	}
	if code, out := callEmails(s, me, http.MethodDelete, "/v1/account/emails/nope", ""); code != 404 || out["error"] != "email_not_found" {
		t.Fatalf("unknown %d %v", code, out)
	}
	code, out = callEmails(s, me, http.MethodDelete, "/v1/account/emails/"+rows[1].ID, "")
	if rows = emailRows(out); code != 200 || len(rows) != 1 {
		t.Fatalf("removed %d %v", code, out)
	}
}

// One account per email: another account's email (its main in Firebase or
// an additional one in the store) is credential_in_use and the code stays
// good; five at most.
func TestAccountEmailsHeldAndLimit(t *testing.T) {
	s, ids, _ := emailService(t)
	ctx := context.Background()
	me, other := "u"+store.NewID(), "u"+store.NewID()
	ids.add(me, "me@example.com")
	ids.add(other, "other@example.com", "google.com")
	if _, err := s.Store.AddAccountEmail(ctx, store.AddEmailSpec{UID: other, Email: "other@example.com", Claim: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.AddAccountEmail(ctx, store.AddEmailSpec{UID: other, Email: "extra@example.com", Verified: true}); err != nil {
		t.Fatal(err)
	}
	for _, e := range []string{"other@example.com", "extra@example.com"} {
		code, out := callEmails(s, me, http.MethodPost, "/v1/account/emails", `{"email":"`+e+`","code":"123456"}`)
		if code != 409 || out["error"] != "credential_in_use" {
			t.Fatalf("%s: %d %v", e, code, out)
		}
		if err := s.EmailCodes.Peek(ctx, e, "123456"); err != nil {
			t.Fatalf("%s: code spent by a refused add", e)
		}
	}
	for i := 0; i < 4; i++ {
		if code, out := callEmails(s, me, http.MethodPost, "/v1/account/emails", `{"email":"m`+string(rune('a'+i))+`@example.com","code":"123456"}`); code != 200 {
			t.Fatalf("add %d: %d %v", i, code, out)
		}
	}
	if code, out := callEmails(s, me, http.MethodPost, "/v1/account/emails", `{"email":"sixth@example.com","code":"123456"}`); code != 409 || out["error"] != "too_many_emails" {
		t.Fatalf("sixth %d %v", code, out)
	}
	// a deleted account's email is free again
	s.Store.PutCustomer(ctx, other, &store.Customer{AccountDeleted: true})
	callEmails(s, me, http.MethodDelete, "/v1/account/emails/"+store.EmailID("ma@example.com"), "")
	ids.mu.Lock()
	delete(ids.users, other)
	ids.mu.Unlock()
	if code, out := callEmails(s, me, http.MethodPost, "/v1/account/emails", `{"email":"extra@example.com","code":"123456"}`); code != 200 {
		t.Fatalf("freed %d %v", code, out)
	}
}

// EM-03: on a Business or Studio account a Hide My Email address can be
// added, never made main; plan_email_needed while the main is a relay.
func TestAccountEmailsRelayOnPlan(t *testing.T) {
	s, ids, _ := emailService(t)
	me := "u" + store.NewID()
	relay := "abc" + store.NewID() + "@privaterelay.appleid.com"
	ids.add(me, relay, "apple.com")
	businessPlan(t, s, me, relay)
	code, out := callEmails(s, me, http.MethodGet, "/v1/account/emails", "")
	if rows := emailRows(out); code != 200 || len(rows) != 1 || !rows[0].Relay || !rows[0].Main || out["plan_email_needed"] != true {
		t.Fatalf("relay main %d %v", code, out)
	}
	other := "x" + store.NewID() + "@privaterelay.appleid.com"
	if code, out := callEmails(s, me, http.MethodPost, "/v1/account/emails", `{"email":"`+other+`","code":"123456","make_main":true}`); code != 409 || out["error"] != "relay_not_main" {
		t.Fatalf("relay make_main %d %v", code, out)
	}
	code, out = callEmails(s, me, http.MethodPost, "/v1/account/emails", `{"email":"`+other+`","code":"123456"}`)
	rows := emailRows(out)
	if code != 200 || len(rows) != 2 {
		t.Fatalf("relay additional %d %v", code, out)
	}
	if code, out := callEmails(s, me, http.MethodPost, "/v1/account/emails/"+rows[1].ID+"/main", ""); code != 409 || out["error"] != "relay_not_main" {
		t.Fatalf("relay main switch %d %v", code, out)
	}
	code, out = callEmails(s, me, http.MethodPost, "/v1/account/emails", `{"email":"work@example.com","code":"123456","make_main":true}`)
	if code != 200 || out["plan_email_needed"] != false || emailRows(out)[0].Email != "work@example.com" {
		t.Fatalf("real main %d %v", code, out)
	}
}

// The email code signs in with any active email: an additional one
// answers its account; the Firebase email takes the usual path; a deleted
// account's emails are released.
func TestEmailOwnersSignIn(t *testing.T) {
	s, ids, _ := emailService(t)
	ctx := context.Background()
	me := "u" + store.NewID()
	ids.add(me, "main@example.com")
	s.Store.AddAccountEmail(ctx, store.AddEmailSpec{UID: me, Email: "main@example.com", Claim: true})
	s.Store.AddAccountEmail(ctx, store.AddEmailSpec{UID: me, Email: "alt@example.com", Verified: true})
	o := s.EmailOwners()
	if uid, err := o.SignInOwner(ctx, "alt@example.com"); err != nil || uid != me {
		t.Fatalf("additional %q %v", uid, err)
	}
	if uid, err := o.SignInOwner(ctx, "main@example.com"); err != nil || uid != "" {
		t.Fatalf("firebase email %q %v", uid, err)
	}
	if uid, _ := o.SignInOwner(ctx, "nobody@example.com"); uid != "" {
		t.Fatalf("unknown %q", uid)
	}
	ids.mu.Lock()
	ids.users[me].Disabled = true
	ids.mu.Unlock()
	if _, err := o.SignInOwner(ctx, "alt@example.com"); err == nil {
		t.Fatal("a disabled account signs in")
	}
	ids.mu.Lock()
	ids.users[me].Disabled = false
	ids.mu.Unlock()
	// a new account by code records its email as main
	fresh := "u" + store.NewID()
	o.SignedIn(ctx, fresh, "New@Example.com", true)
	if list, _ := s.Store.ListAccountEmails(ctx, fresh); len(list) != 1 || !list[0].Main || list[0].Email != "new@example.com" {
		t.Fatalf("recorded %+v", list)
	}
	// deletion releases
	if err := s.finishAccountDeletionKeeping(ctx, me, true); err != nil {
		t.Fatal(err)
	}
	if uid, _ := o.SignInOwner(ctx, "alt@example.com"); uid != "" {
		t.Fatalf("deleted account still signs in: %q", uid)
	}
	if h, _ := s.Store.ListEmailHistory(ctx, me); len(h) != 2 || h[0].State != store.EmailReleased {
		t.Fatalf("history %+v", h)
	}
}

// A switch that can't reach Firebase stays pending; the reconcile retries
// it and, after five failures, flags main_email_drift.
func TestEmailSyncRetryAndDrift(t *testing.T) {
	s, ids, _ := emailService(t)
	ctx := context.Background()
	old := emailSyncRetryAfter
	emailSyncRetryAfter = 0
	t.Cleanup(func() { emailSyncRetryAfter = old })
	me := "u" + store.NewID()
	ids.add(me, "a@example.com")
	callEmails(s, me, http.MethodGet, "/v1/account/emails", "")
	_, out := callEmails(s, me, http.MethodPost, "/v1/account/emails", `{"email":"b@example.com","code":"123456"}`)
	b := emailRows(out)[1]
	ids.failSet = true
	if code, out := callEmails(s, me, http.MethodPost, "/v1/account/emails/"+b.ID+"/main", ""); code != 200 || emailRows(out)[0].Email != "b@example.com" {
		t.Fatalf("switch recorded %d %v", code, out)
	}
	if p, _ := s.Store.ListPendingEmailSyncs(ctx, 10); len(p) != 1 {
		t.Fatalf("pending %+v", p)
	}
	ids.failSet = false
	if st := s.emailSyncSweep(ctx); st["email_syncs_done"] != 1 {
		t.Fatalf("retry %v", st)
	}
	if got, _ := ids.IdentityOf(ctx, me); got.Email != "b@example.com" {
		t.Fatalf("firebase %q", got.Email)
	}
	// five failures: drift
	_, out = callEmails(s, me, http.MethodGet, "/v1/account/emails", "")
	a := emailRows(out)[1]
	ids.failSet = true
	callEmails(s, me, http.MethodPost, "/v1/account/emails/"+a.ID+"/main", "")
	drift := 0
	for i := 0; i < 5; i++ { // the request tried once; the fifth try is drift
		drift += s.emailSyncSweep(ctx)["main_email_drift"]
	}
	if drift != 1 {
		t.Fatalf("drift %d", drift)
	}
	if p, _ := s.Store.ListPendingEmailSyncs(ctx, 10); len(p) != 0 {
		t.Fatalf("still retried after drift: %+v", p)
	}
}

// EM-01: a dry run writes nothing and counts; a live run records each
// Firebase email as main (unverified as it is), a deleted account's
// email as released, and is idempotent.
func TestEmailBackfill(t *testing.T) {
	s, _, f := emailService(t)
	ctx := context.Background()
	tag := store.NewID()
	users := []*auth.Identity{
		{UID: "u1" + tag, Email: "a" + tag + "@example.com", EmailVerified: true, Providers: []string{"google.com"}},
		{UID: "u2" + tag, Email: "b" + tag + "@example.com", Providers: []string{"password"}},
		{UID: "u3" + tag, Email: "c" + tag + "@privaterelay.appleid.com", EmailVerified: true, Providers: []string{"apple.com"}},
		{UID: "u4" + tag},
	}
	each := func(ctx context.Context, fn func(*auth.Identity) error) error {
		for _, u := range users {
			if err := fn(u); err != nil {
				return err
			}
		}
		return nil
	}
	end := time.Now().Add(10 * 24 * time.Hour)
	s.Store.PutCustomer(ctx, "u3"+tag, &store.Customer{StripeCustomerID: "cus_3" + tag, Email: "old" + tag + "@example.com",
		Plan: &store.Plan{Tier: "studio", Status: "active", SubscriptionID: "sub_3", CurrentPeriodEnd: &end}})
	s.Store.PutCustomer(ctx, "ud"+tag, &store.Customer{Email: "gone" + tag + "@example.com", AccountDeleted: true})

	dry, err := s.BackfillAccountEmails(ctx, each, false, false)
	if err != nil || dry.Users != 4 || dry.WithEmail != 3 || dry.NoEmail != 1 || dry.ToAdd != 3 || dry.Added != 0 ||
		dry.PasswordUnverified != 1 || dry.Relay != 1 || dry.ToRelease != 1 || dry.PlanAccounts != 1 || dry.PlanRelayMain != 1 ||
		dry.StripeToResync != 1 || dry.CustomerDiffers != 1 {
		t.Fatalf("dry %+v %v", dry, err)
	}
	if owner, _ := s.Store.EmailOwner(ctx, "a"+tag+"@example.com"); owner != "" {
		t.Fatal("a dry run wrote")
	}
	live, err := s.BackfillAccountEmails(ctx, each, true, true)
	if err != nil || live.Added != 3 || live.Released != 1 || live.StripeResynced != 1 || live.CustomersResynced != 1 {
		t.Fatalf("live %+v %v", live, err)
	}
	if e, _ := s.Store.GetAccountEmail(ctx, "b"+tag+"@example.com"); e == nil || !e.Main || e.Verified {
		t.Fatalf("unverified main %+v", e)
	}
	if e, _ := s.Store.GetAccountEmail(ctx, "gone"+tag+"@example.com"); e == nil || e.State != store.EmailReleased {
		t.Fatalf("released %+v", e)
	}
	f.mu.Lock()
	got := f.customers["cus_3"+tag]
	f.mu.Unlock()
	if got == nil || got.email != "c"+tag+"@privaterelay.appleid.com" {
		t.Fatalf("stripe %+v", got)
	}
	again, _ := s.BackfillAccountEmails(ctx, each, true, false)
	if again.Added != 0 || again.AlreadyStored != 3 || again.Released != 0 {
		t.Fatalf("again %+v", again)
	}
	if p, _ := s.Store.ListPendingEmailSyncs(ctx, 10); len(p) != 0 {
		t.Fatalf("the backfill queued syncs %+v", p)
	}
}

// The Apple/Google gap: a Google sign-in whose email is another account's
// additional email made a new account; the identities read names the
// other one by how it signs in and offers the email code; nothing for an
// account whose email is its own.
func TestIdentitiesSpotOtherAccount(t *testing.T) {
	s, ids, _ := emailService(t)
	ctx := context.Background()
	owner, fresh := "u"+store.NewID(), "u"+store.NewID()
	shared := "shared." + store.NewID() + "@example.com"
	ids.add(owner, "main."+store.NewID()+"@example.com", "apple.com")
	s.Store.AddAccountEmail(ctx, store.AddEmailSpec{UID: owner, Email: ids.users[owner].Email, Claim: true})
	s.Store.AddAccountEmail(ctx, store.AddEmailSpec{UID: owner, Email: shared, Verified: true})
	ids.add(fresh, shared, "google.com")
	code, out, raw := callIdentity(s, fresh, http.MethodGet, "", "", uniqueIP())
	other, _ := out["other_account"].(map[string]any)
	if code != 200 || other == nil || other["sign_in_with"] != "email_code" || fmt.Sprint(other["providers"]) != "[apple.com email]" || strings.Contains(raw, owner) {
		t.Fatalf("gap %d %v", code, out)
	}
	if _, out, _ := callIdentity(s, owner, http.MethodGet, "", "", uniqueIP()); out["other_account"] != nil {
		t.Fatalf("own email %v", out["other_account"])
	}
}
