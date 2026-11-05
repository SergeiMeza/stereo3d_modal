package stripex

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// No invoice of ours carries the withdrawal line (owner 2026-11-05): a
// run's invoice sends no footer; a top-up's keeps its own.
func TestInvoiceFooterHasNoWithdrawalLine(t *testing.T) {
	var forms []url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		forms = append(forms, r.PostForm)
		w.Write([]byte(`{"id":"in_1","status":"draft"}`))
	}))
	defer srv.Close()
	prev := apiBase
	apiBase = srv.URL
	defer func() { apiBase = prev }()
	c := &Client{env: "test"}
	if _, err := c.CreateInvoice(InvoiceSpec{CustomerID: "cus_1", ChargeID: "ch_1", Currency: "usd"}, "k1"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.CreateInvoice(InvoiceSpec{CustomerID: "cus_1", ChargeID: "ch_2", Currency: "usd", Footer: TopupInvoiceFooter}, "k2"); err != nil {
		t.Fatal(err)
	}
	if _, ok := forms[0]["footer"]; ok {
		t.Fatalf("run invoice footer %q", forms[0].Get("footer"))
	}
	if forms[1].Get("footer") != TopupInvoiceFooter {
		t.Fatalf("top-up footer %q", forms[1].Get("footer"))
	}
	for _, f := range forms {
		for k, v := range f {
			if strings.Contains(strings.Join(v, " "), "right to cancel") {
				t.Fatalf("%s carries the line", k)
			}
		}
	}
}
