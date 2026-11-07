package stripex

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// Every Stripe create sends currency=usd (the live account defaults to
// GBP; all our prices are USD): even when the caller's currency is empty.
// Subscription Checkout sends a price (a USD price) and no currency.
func TestEveryCreateIsUSD(t *testing.T) {
	var mu sync.Mutex
	forms := map[string][]url.Values{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		mu.Lock()
		forms[r.URL.Path] = append(forms[r.URL.Path], r.PostForm)
		mu.Unlock()
		switch {
		case strings.HasPrefix(r.URL.Path, "/v1/payment_intents"):
			w.Write([]byte(`{"id":"pi_1","object":"payment_intent","client_secret":"pi_1_secret","status":"requires_payment_method"}`))
		case strings.HasPrefix(r.URL.Path, "/v1/ephemeral_keys"):
			w.Write([]byte(`{"id":"ephkey_1","object":"ephemeral_key","secret":"ek_test"}`))
		case strings.HasPrefix(r.URL.Path, "/v1/checkout/sessions"):
			w.Write([]byte(`{"id":"cs_1","object":"checkout.session","client_secret":"cs_1_secret","expires_at":1999999999}`))
		case strings.HasPrefix(r.URL.Path, "/v1/invoices"):
			w.Write([]byte(`{"id":"in_1","object":"invoice","status":"draft"}`))
		default:
			w.Write([]byte(`{"id":"x_1"}`))
		}
	}))
	defer srv.Close()
	prevBase := apiBase
	UseTestServer(srv.URL)
	defer func() { apiBase = prevBase }()
	c := &Client{env: "test", ephemeralAPIVer: "2024-04-10"}
	job := Job{ConversionID: "c1", UID: "u1"}
	type call struct {
		name, path string
		run        func() error
	}
	calls := []call{
		{"hold (sheet)", "/v1/payment_intents", func() error { _, err := c.CreateHold("cus_1", 500, "", job); return err }},
		{"off-session hold", "/v1/payment_intents", func() error { _, err := c.CreateOffSessionHold("cus_1", "pm_1", 500, "", job); return err }},
		{"charge saved", "/v1/payment_intents", func() error { _, err := c.ChargeSaved("cus_1", "pm_1", 500, "", job); return err }},
		{"precharge", "/v1/payment_intents", func() error { _, err := c.PrechargeSaved("cus_1", "pm_1", 500, "", job); return err }},
		{"settle charge", "/v1/payment_intents", func() error { _, err := c.ChargeSettle("cus_1", "pm_1", 500, "", "st_1", job); return err }},
		{"alipay", "/v1/payment_intents", func() error {
			_, _, err := c.CreateAlipayPayment("cus_1", 500, "", "https://x/return", 1, job)
			return err
		}},
		{"top-up charge", "/v1/payment_intents", func() error { _, err := c.ChargeTopup("cus_1", "pm_1", 2000, "t1", job); return err }},
		{"alipay top-up", "/v1/payment_intents", func() error {
			_, _, err := c.CreateAlipayTopup("cus_1", 2000, "https://x/return", "t1", 1, job)
			return err
		}},
		{"payment checkout", "/v1/checkout/sessions", func() error {
			_, err := c.CreateWebSession(SessionSpec{CustomerID: "cus_1", UI: "elements", AmountCents: 500, Label: "Run", ReturnURL: "https://x/r", IdemKey: "k1"})
			return err
		}},
		{"setup checkout", "/v1/checkout/sessions", func() error {
			_, err := c.CreateSetupSession("cus_1", "", "https://x/r", nil, "k2")
			return err
		}},
		{"invoice", "/v1/invoices", func() error {
			_, err := c.CreateInvoice(InvoiceSpec{CustomerID: "cus_1", ChargeID: "run_c1"}, "k3")
			return err
		}},
		{"invoice item", "/v1/invoiceitems", func() error {
			return c.AddInvoiceItem(InvoiceItem{CustomerID: "cus_1", InvoiceID: "in_1", AmountCents: 500, Description: "Run"}, "k4")
		}},
		{"plan credit item", "/v1/invoiceitems", func() error {
			_, err := c.AddPendingCredit("cus_1", "sub_1", 1000, "Unused credit", "k5")
			return err
		}},
	}
	for _, cl := range calls {
		mu.Lock()
		before := len(forms[cl.path])
		mu.Unlock()
		if err := cl.run(); err != nil {
			t.Fatalf("%s: %v", cl.name, err)
		}
		mu.Lock()
		got := forms[cl.path][before:]
		mu.Unlock()
		if len(got) == 0 {
			t.Fatalf("%s: no request to %s", cl.name, cl.path)
		}
		f := got[0]
		cur := f.Get("currency")
		if cl.path == "/v1/checkout/sessions" && cur == "" {
			cur = f.Get("line_items[0][price_data][currency]")
		}
		if cur != "usd" {
			t.Errorf("%s: currency %q", cl.name, cur)
		}
	}
	// subscription Checkout: a USD price, no currency of its own
	if _, err := c.CreatePlanSession(PlanSessionSpec{CustomerID: "cus_1", PriceID: "price_usd", UI: "elements", ReturnURL: "https://x/r?plan=pro", IdemKey: "k6"}); err != nil {
		t.Fatal(err)
	}
	last := forms["/v1/checkout/sessions"][len(forms["/v1/checkout/sessions"])-1]
	if last.Get("line_items[0][price]") != "price_usd" || last.Get("mode") != "subscription" {
		t.Fatalf("plan session %v", last)
	}
}
