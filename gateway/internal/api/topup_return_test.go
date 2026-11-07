package api

import (
	"context"
	"net/http"
	"net/url"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// REV-14: a top-up's payment returns naming its own top-up (the topup
// query parameter, whatever the client's return_url carried), and the
// ledger's top-up rows carry topup_id, so the return page matches its own
// payment and no other.
func TestTopupReturnNamesItsTopup(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	s.Cfg.SiteURL = "https://site.example"
	s.Cfg.StripePMCWeb = "pmc_web"
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	for _, c := range []struct{ client, want string }{
		{"", "https://site.example/billing?topup=t1"},
		{"https://site.example/billing?topup=1", "https://site.example/billing?topup=t1"},
		{"https://site.example/projects/p1?pay=done", "https://site.example/projects/p1?pay=done&topup=t1"},
		{"https://site.example/billing/return/{TOPUP_ID}", "https://site.example/billing/return/t1?topup=t1"},
		{"https://evil.example/billing", "https://site.example/billing?topup=t1"},
		{"https://site.example.evil.com/x", "https://site.example/billing?topup=t1"},
	} {
		if got := s.topupReturnURL(c.client, "t1"); got != c.want {
			t.Errorf("%q → %q, want %q", c.client, got, c.want)
		}
	}
	// the card sheet's session: the client's topup=1 becomes the id
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	code, out := callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandleTopup(w, r, &AuthedUser{UID: uid}) },
		"POST", `{"amount_cents":2500,"ui":"elements","return_url":"https://site.example/billing?topup=1"}`)
	if code != 200 {
		t.Fatalf("topup %d %v", code, out)
	}
	ru, err := url.Parse(fake.sessionForms[len(fake.sessionForms)-1]["return_url"])
	if err != nil || ru.Query().Get("topup") != out["topup_id"] || len(ru.Query()["topup"]) != 1 {
		t.Fatalf("return_url %v for %v", ru, out["topup_id"])
	}
	// the ledger row
	row := ledgerRow(store.Entry{ID: "topup_pi_1", Kind: store.EntryTopup, Cents: 2500, Delta: 2500, TopupID: "t1"})
	if row["topup_id"] != "t1" || row["id"] != "topup_pi_1" {
		t.Fatalf("row %v", row)
	}
	if row := ledgerRow(store.Entry{ID: "adj_1", Kind: store.EntryAdjustment, Delta: 100, Note: "x"}); row["topup_id"] != nil {
		t.Fatalf("adjustment row %v", row)
	}
}
