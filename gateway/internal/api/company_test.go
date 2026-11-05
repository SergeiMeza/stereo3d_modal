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
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

func companyCall(s *Service, h func(http.ResponseWriter, *http.Request, *AuthedUser), uid, method, body string) (int, map[string]any) {
	w := httptest.NewRecorder()
	h(w, httptest.NewRequest(method, "/v1/billing/company", strings.NewReader(body)), &AuthedUser{UID: uid})
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

// A Business Checkout's details land on the account and the Stripe
// Customer (business name, address, tax ID; once on a redelivery); PUT
// changes them (a bad tax ID → 400 with Stripe's message, nothing
// changed), the PO becomes the invoice custom field, the billing email
// is kept for receipt copies; the admin view shows the block.
func TestCompanyDetails(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	uid, cus := "u"+store.NewID(), "cus_c"+store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: cus, Email: "ann@example.com"})
	sess := `{"id":"cs_p1","mode":"subscription","customer":"` + cus + `","metadata":{"env":"test","product":"svs-web","kind":"plan","plan":"business","user_id":"` + uid + `"},
		"customer_details":{"name":"Ann Lee","business_name":"Acme GmbH","email":"ap@acme.example","address":{"line1":"Hauptstr. 1","city":"Berlin","postal_code":"10115","country":"DE"},
		"tax_ids":[{"type":"eu_vat","value":"DE123456789"}]}}`
	for i := 0; i < 2; i++ { // the second delivery changes nothing
		if err := s.handleCheckoutEvent(ctx, "checkout.session.completed", json.RawMessage(sess)); err != nil {
			t.Fatal(err)
		}
	}
	c := fake.customers[cus]
	if c.name != "Acme GmbH" || c.address["city"] != "Berlin" || len(c.taxIDs) != 1 {
		t.Fatalf("stripe customer %+v", c)
	}
	cust, _ := s.Store.GetCustomer(ctx, uid)
	if cust.Company == nil || cust.Company.CompanyName != "Acme GmbH" || cust.Company.BillingEmail != "ap@acme.example" || len(cust.Company.Changes) != 1 {
		t.Fatalf("stored %+v", cust.Company)
	}
	// A Pro Checkout without a business name or tax ID isn't a company.
	pro := "u" + store.NewID()
	s.Store.PutCustomer(ctx, pro, &store.Customer{StripeCustomerID: "cus_p" + pro})
	s.handleCheckoutEvent(ctx, "checkout.session.completed", json.RawMessage(`{"id":"cs_p2","customer":"cus_p`+pro+`","metadata":{"env":"test","product":"svs-web","kind":"plan","plan":"pro","user_id":"`+pro+`"},
		"customer_details":{"name":"Bo","email":"bo@example.com","address":{"country":"US"}}}`))
	if c, _ := s.Store.GetCustomer(ctx, pro); c.Company != nil {
		t.Fatalf("pro company %+v", c.Company)
	}

	code, out := companyCall(s, s.HandleGetCompany, uid, http.MethodGet, "")
	tax, _ := out["tax_id"].(map[string]any)
	addr, _ := out["address"].(map[string]any)
	if code != 200 || out["company_name"] != "Acme GmbH" || tax["value"] != "DE123456789" || tax["verification"] != "pending" ||
		addr["postal_code"] != "10115" || addr["line2"] != "" || out["billing_email"] != "ap@acme.example" || out["po_reference"] != nil {
		t.Fatalf("get %d %v", code, out)
	}

	code, out = companyCall(s, s.HandlePutCompany, uid, http.MethodPut, `{"company_name":"Acme AG","tax_id":{"type":"eu_vat","value":"DEBAD"}}`)
	if code != 400 || out["error"] != "invalid_tax_id" || !strings.Contains(out["message"].(string), "Invalid value") || fake.customers[cus].name != "Acme GmbH" {
		t.Fatalf("bad tax id %d %v", code, out)
	}
	code, out = companyCall(s, s.HandlePutCompany, uid, http.MethodPut, `{"company_name":"Acme AG","address":{"line2":"3rd floor"},
		"tax_id":{"type":"eu_vat","value":"DE999999999"},"po_reference":"PO-77","billing_email":"invoices@acme.example"}`)
	c = fake.customers[cus]
	if code != 200 || c.name != "Acme AG" || c.address["line2"] != "3rd floor" || c.address["city"] != "Berlin" || len(c.taxIDs) != 1 ||
		c.taxIDs[0]["value"] != "DE999999999" || c.po != "PO-77" || out["po_reference"] != "PO-77" || out["billing_email"] != "invoices@acme.example" {
		t.Fatalf("put %d %v customer %+v", code, out, c)
	}
	if got := s.billingEmailCopy(ctx, uid, "ann@example.com"); got != "invoices@acme.example" {
		t.Fatalf("receipt copy %q", got)
	}
	if code, _ = companyCall(s, s.HandlePutCompany, uid, http.MethodPut, `{"po_reference":null,"billing_email":"nope"}`); code != 400 {
		t.Fatalf("bad email %d", code)
	}
	if code, out = companyCall(s, s.HandlePutCompany, uid, http.MethodPut, `{"po_reference":null}`); code != 200 || fake.customers[cus].po != "" || out["po_reference"] != nil {
		t.Fatalf("po cleared %d %v", code, out)
	}
	cust, _ = s.Store.GetCustomer(ctx, uid)
	if n := len(cust.Company.Changes); n != 3 || cust.Company.Changes[n-1].By != "user" {
		t.Fatalf("changes %+v", cust.Company.Changes)
	}

	w := httptest.NewRecorder()
	s.HandleAdminAccount(w, httptest.NewRequest(http.MethodGet, "/v1/admin/accounts/"+uid, nil), &AdminUser{UID: "admin", Method: "passkey", AssertedAt: time.Now()}, uid)
	var adm map[string]any
	json.Unmarshal(w.Body.Bytes(), &adm)
	co, _ := adm["company"].(map[string]any)
	if co["company_name"] != "Acme AG" || co["tax_id"].(map[string]any)["verification"] != "pending" || co["billing_email"] != "invoices@acme.example" {
		t.Fatalf("admin company %v", adm["company"])
	}
}

// Every Checkout is a minimal sheet (owner 2026-11-05): no required
// address, no business name, no tax ID; the address Stripe takes with the
// card still goes onto the customer.
func TestPlanSessionCompanyFields(t *testing.T) {
	s, fake := e0Service(t)
	for _, tier := range []string{"business", "pro"} {
		if _, err := s.Stripe.CreatePlanSession(stripex.PlanSessionSpec{CustomerID: "cus_1", PriceID: "price_1", UI: "elements", ReturnURL: "https://x/r", Tier: tier, UID: "u1"}); err != nil {
			t.Fatal(err)
		}
	}
	b, p := fake.sessionForms[0], fake.sessionForms[1]
	// owner 2026-11-05: a minimal sheet for Business too (no required
	// address, no business name); details come after payment
	for _, f := range []map[string]string{b, p} {
		if f["billing_address_collection"] != "auto" || f["name_collection[business][enabled]"] != "" {
			t.Fatalf("business %v pro %v", b, p)
		}
	}
	// owner 2026-11-05: no tax ID in any payment form; the address still
	// goes onto the customer (tax is reckoned from it)
	if _, err := s.Stripe.CreateWebSession(stripex.SessionSpec{CustomerID: "cus_1", UI: "elements", AmountCents: 500, Currency: "usd",
		Label: "run", ReturnURL: "https://x/r"}); err != nil {
		t.Fatal(err)
	}
	for i, f := range fake.sessionForms {
		if _, ok := f["tax_id_collection[enabled]"]; ok || f["customer_update[address]"] != "auto" {
			t.Fatalf("session %d %v", i, f)
		}
	}
	for i, f := range fake.sessionForms {
		for k := range f {
			if strings.HasPrefix(k, "name_collection") || k == "customer_update[name]" {
				t.Fatalf("session %d asks for a name: %v", i, f)
			}
		}
	}
}

// Business details take Japan's and the US's tax IDs (and any other
// Stripe type): each PUT replaces the one before on the customer.
func TestCompanyTaxIDTypes(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	uid, cus := "u"+store.NewID(), "cus_t"+store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: cus})
	if code, _ := companyCall(s, s.HandlePutCompany, uid, http.MethodPut, `{"company_name":"Kabushiki Kaisha"}`); code != 200 {
		t.Fatalf("name %d", code)
	}
	for _, tc := range [][2]string{{"jp_trn", "T1234567890123"}, {"jp_cn", "1234567891234"}, {"us_ein", "12-3456789"}, {"gb_vat", "GB123456789"}} {
		code, out := companyCall(s, s.HandlePutCompany, uid, http.MethodPut, `{"tax_id":{"type":"`+tc[0]+`","value":"`+tc[1]+`"}}`)
		tax, _ := out["tax_id"].(map[string]any)
		if code != 200 || tax["type"] != tc[0] || tax["value"] != tc[1] || len(fake.customers[cus].taxIDs) != 1 {
			t.Fatalf("%s: %d %v %v", tc[0], code, out, fake.customers[cus].taxIDs)
		}
		cust, _ := s.Store.GetCustomer(ctx, uid)
		if len(cust.Company.TaxIDs) != 1 || cust.Company.TaxIDs[0].Type != tc[0] {
			t.Fatalf("%s stored %+v", tc[0], cust.Company.TaxIDs)
		}
	}
}
