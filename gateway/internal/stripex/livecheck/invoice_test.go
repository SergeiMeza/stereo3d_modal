package livecheck

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

func rawStripe(t *testing.T, key, method, path string, form url.Values) map[string]any {
	t.Helper()
	req, _ := http.NewRequest(method, "https://api.stripe.com"+path, strings.NewReader(form.Encode()))
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Stripe-Version", stripex.WebAPIVersion)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	if resp.StatusCode >= 300 {
		t.Fatalf("%s %s: %d %s", method, path, resp.StatusCode, raw)
	}
	return out
}

// C6 in TEST mode: a PaymentIntent that already succeeded gets an invoice
// (items, finalize without collecting, attach_payment), then a partial
// refund gets a credit note.
func TestInvoiceAfterPaymentInTestMode(t *testing.T) {
	key := os.Getenv("STRIPE_TEST_KEY")
	if !strings.HasPrefix(key, "sk_test_") {
		t.Skip("needs a TEST secret key")
	}
	c := stripex.New(key, "", "pk", "test")
	stamp := time.Now().Format("150405.000")
	cus := rawStripe(t, key, "POST", "/v1/customers", url.Values{"name": {"Invoice probe"}, "email": {"probe-invoice@example.com"},
		"metadata[kind]": {"probe"}, "metadata[env]": {"probe"}})
	cusID := cus["id"].(string)
	defer rawStripe(t, key, "DELETE", "/v1/customers/"+cusID, nil)
	pi := rawStripe(t, key, "POST", "/v1/payment_intents", url.Values{"amount": {"4972"}, "currency": {"usd"}, "customer": {cusID},
		"payment_method": {"pm_card_visa"}, "automatic_payment_methods[enabled]": {"true"}, "automatic_payment_methods[allow_redirects]": {"never"}, "confirm": {"true"}, "metadata[kind]": {"probe"}})
	piID := pi["id"].(string)
	if pi["status"] != "succeeded" {
		t.Fatalf("pi %v", pi["status"])
	}
	paidAt := time.Now().Add(-2 * time.Minute)
	inv, err := c.CreateInvoice(stripex.InvoiceSpec{CustomerID: cusID, ChargeID: "probe_" + stamp, Currency: "usd", EffectiveAt: paidAt}, "probe_inv_"+stamp)
	if err != nil {
		t.Fatalf("create: %v", stripex.ErrMessage(err))
	}
	for i, amt := range []int64{4000, 972} {
		if err := c.AddInvoiceItem(stripex.InvoiceItem{CustomerID: cusID, InvoiceID: inv.ID, AmountCents: amt, Currency: "usd",
			Description: "Kyoto walk · 3D video · 4K", ConversionID: "probe" + string(rune('a'+i))}, "probe_item_"+stamp+string(rune('a'+i))); err != nil {
			t.Fatalf("item: %v", stripex.ErrMessage(err))
		}
	}
	lines, err := c.InvoiceLineRuns(inv.ID)
	if err != nil || len(lines) != 2 {
		t.Fatalf("lines %v %v", lines, err)
	}
	inv, err = c.GetInvoice(inv.ID)
	if err != nil || inv.Total != 4972 {
		t.Fatalf("total %+v %v", inv, err)
	}
	if inv, err = c.FinalizeInvoice(inv.ID); err != nil {
		t.Fatalf("finalize: %v", stripex.ErrMessage(err))
	}
	if inv, err = c.AttachPayment(inv.ID, piID); err != nil {
		t.Fatalf("attach: %v", stripex.ErrMessage(err))
	}
	inv, _ = c.GetInvoice(inv.ID)
	t.Logf("invoice %s %s status=%s paid=%d pdf=%v hosted=%v", inv.ID, inv.Number, inv.Status, inv.AmountPaid, inv.InvoicePDF != "", inv.HostedInvoiceURL != "")
	if inv.Status != "paid" {
		t.Fatalf("status %s", inv.Status)
	}
	re := rawStripe(t, key, "POST", "/v1/refunds", url.Values{"payment_intent": {piID}, "amount": {"972"}})
	cn, err := c.CreditRefund(inv.ID, re["id"].(string), 972, "probe_cn_"+stamp)
	if err != nil {
		t.Fatalf("credit note: %v", stripex.ErrMessage(err))
	}
	t.Logf("credit note %s %s total=%d pdf=%v", cn.ID, cn.Number, cn.Total, cn.PDF != "")
	rec, ref, err := c.PaymentAmounts(piID)
	if err != nil || rec != 4972 || ref != 972 {
		t.Fatalf("amounts %d %d %v", rec, ref, err)
	}
	refunds, err := c.ListRefunds(piID)
	if err != nil || len(refunds) != 1 {
		t.Fatalf("refunds %v %v", refunds, err)
	}
	list, _, err := c.ListInvoices(cusID, 10, "")
	notes, err2 := c.ListCreditNotes(cusID)
	if err != nil || err2 != nil || len(list) != 1 || len(notes) != 1 {
		t.Fatalf("lists %d %d %v %v", len(list), len(notes), err, err2)
	}
}
