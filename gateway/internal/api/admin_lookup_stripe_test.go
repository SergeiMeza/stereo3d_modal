package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// emailStripe answers the customer search by email from a list; the rest
// goes to fakeStripe.
type emailStripe struct {
	*fakeStripe
	customers []map[string]any // {id, email, metadata}
	searches  int
}

var searchEmail = regexp.MustCompile(`^email:'([^']+)'$`)

func (f *emailStripe) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/v1/customers/search" {
		f.fakeStripe.ServeHTTP(w, r)
		return
	}
	f.searches++
	data := []any{}
	if m := searchEmail.FindStringSubmatch(r.URL.Query().Get("query")); m != nil {
		for _, c := range f.customers {
			if c["email"] == m[1] {
				data = append(data, c)
			}
		}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"data": data, "has_more": false})
}

// A whole email also finds accounts by their Stripe customer: one whose
// record has another email (deleted here), one with no record; another
// env's customer and a partial email don't ask Stripe or don't count.
func TestAdminSearchStripeByEmail(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	es := &emailStripe{fakeStripe: fake}
	srv := httptest.NewServer(es)
	t.Cleanup(srv.Close)
	stripex.UseTestServer(srv.URL)

	tag := store.NewID()
	email := "kim." + tag + "@example.com"
	byRecord, renamed, noRecord := "u"+store.NewID(), "u"+store.NewID(), "u"+store.NewID()
	now := time.Now().UTC()
	s.Store.PutCustomer(ctx, byRecord, &store.Customer{StripeCustomerID: "cus_a", Email: email})
	s.Store.PutCustomer(ctx, renamed, &store.Customer{StripeCustomerID: "cus_b", Email: "relay." + tag + "@privaterelay.appleid.com",
		AccountDeleted: true, DeletedAt: &now})
	es.customers = []map[string]any{
		{"id": "cus_a", "email": email, "metadata": map[string]string{"firebase_uid": byRecord, "env": "test"}},
		{"id": "cus_b", "email": email, "metadata": map[string]string{"firebase_uid": renamed, "env": "test"}},
		{"id": "cus_c", "email": email, "metadata": map[string]string{"firebase_uid": noRecord, "env": "test"}},
		{"id": "cus_p", "email": email, "metadata": map[string]string{"firebase_uid": "uprod", "env": "prod"}},
	}

	out := adminGet(t, s.HandleAdminAccountSearch, "/v1/admin/accounts?q="+email)
	accs := out["accounts"].([]any)
	got := map[string]map[string]any{}
	for _, a := range accs {
		r := a.(map[string]any)
		got[r["uid"].(string)] = r
	}
	if len(accs) != 3 || got["uprod"] != nil {
		t.Fatalf("accounts %v", accs)
	}
	if r := got[byRecord]; r["found_by"] != "record" || r["deleted"] != false {
		t.Fatalf("by record %v", r)
	}
	if r := got[renamed]; r["found_by"] != "stripe" || r["deleted"] != true || r["email"] != "relay."+tag+"@privaterelay.appleid.com" {
		t.Fatalf("renamed %v", r)
	}
	if r := got[noRecord]; r["found_by"] != "stripe" || r["email"] != email || r["created_at"] != nil {
		t.Fatalf("no record %v", r)
	}
	// a prefix doesn't ask Stripe
	before := es.searches
	adminGet(t, s.HandleAdminAccountSearch, "/v1/admin/accounts?q=kim."+tag)
	if es.searches != before {
		t.Fatal("prefix asked Stripe")
	}
	if looksLikeEmail("kim@") || looksLikeEmail("a'b@x.com") || !looksLikeEmail("a@b.co") {
		t.Fatal("looksLikeEmail")
	}
}

// The email store answers too: an account holding the email as an
// additional one, and a deleted account whose email was released.
func TestAdminSearchEmailStore(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	tag := store.NewID()
	extra, released := "pat."+tag+"@example.com", "pat."+tag+"@old.example.com"
	holder, gone := "u"+store.NewID(), "u"+store.NewID()
	s.Store.PutCustomer(ctx, holder, &store.Customer{Email: "main." + tag + "@example.com"})
	s.Store.AddAccountEmail(ctx, store.AddEmailSpec{UID: holder, Email: "main." + tag + "@example.com", Claim: true})
	s.Store.AddAccountEmail(ctx, store.AddEmailSpec{UID: holder, Email: extra, Verified: true})
	s.Store.AddAccountEmail(ctx, store.AddEmailSpec{UID: gone, Email: released, Claim: true})
	s.Store.ReleaseAllAccountEmails(ctx, gone, "deleted")

	out := adminGet(t, s.HandleAdminAccountSearch, "/v1/admin/accounts?q=pat."+tag)
	got := map[string]map[string]any{}
	for _, a := range out["accounts"].([]any) {
		r := a.(map[string]any)
		got[r["uid"].(string)] = r
	}
	if r := got[holder]; r == nil || r["found_by"] != "email" || r["matched_email"] != extra || r["email_released"] != false ||
		r["email"] != "main."+tag+"@example.com" {
		t.Fatalf("additional %v", r)
	}
	if r := got[gone]; r == nil || r["found_by"] != "email" || r["matched_email"] != released || r["email_released"] != true {
		t.Fatalf("released %v", r)
	}
}
