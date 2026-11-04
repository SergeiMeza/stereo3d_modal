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
	s.HandleAdminAccount(w, httptest.NewRequest(http.MethodGet, "/v1/admin/accounts/"+uid, nil), &AdminUser{UID: "admin", AuthTime: time.Now()}, uid)
	var adm map[string]any
	json.Unmarshal(w.Body.Bytes(), &adm)
	co, _ := adm["company"].(map[string]any)
	if co["company_name"] != "Acme AG" || co["tax_id"].(map[string]any)["verification"] != "pending" || co["billing_email"] != "invoices@acme.example" {
		t.Fatalf("admin company %v", adm["company"])
	}
}

// Business and Studio Checkouts require the billing address and offer a
// business name; Pro keeps the address optional.
func TestPlanSessionCompanyFields(t *testing.T) {
	s, fake := e0Service(t)
	for _, tier := range []string{"business", "pro"} {
		if _, err := s.Stripe.CreatePlanSession(stripex.PlanSessionSpec{CustomerID: "cus_1", PriceID: "price_1", UI: "elements", ReturnURL: "https://x/r", Tier: tier, UID: "u1"}); err != nil {
			t.Fatal(err)
		}
	}
	b, p := fake.sessionForms[0], fake.sessionForms[1]
	if b["billing_address_collection"] != "required" || b["tax_id_collection[enabled]"] != "true" || b["name_collection[business][enabled]"] != "true" ||
		b["name_collection[business][optional]"] != "true" || p["billing_address_collection"] != "auto" || p["name_collection[business][enabled]"] != "" {
		t.Fatalf("business %v pro %v", b, p)
	}
}
