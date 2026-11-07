//go:build stripetest

package stripex

// Adaptive Pricing against Stripe's TEST mode (owner 2026-11-07, Option
// B): our own session builders, completed the way Stripe.js completes an
// Elements Checkout Session, then read back through the gateway's readers.
//
//	STRIPE_TEST_SECRET_KEY=sk_test_… STRIPE_TEST_PUBLISHABLE_KEY=pk_test_… \
//	  go test -tags stripetest ./internal/stripex -run TestAP -v
//
// Test keys only (refused otherwise). Customers carry an email with
// +location_XX, Stripe's documented way to place a test customer in a
// country. Payments use Stripe's test token tok_visa. Each test cleans up
// what it made (the subscription's test clock is deleted).

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func apClient(t *testing.T) (*Client, string) {
	t.Helper()
	sk, pk := os.Getenv("STRIPE_TEST_SECRET_KEY"), os.Getenv("STRIPE_TEST_PUBLISHABLE_KEY")
	if sk == "" || pk == "" {
		t.Skip("needs STRIPE_TEST_SECRET_KEY and STRIPE_TEST_PUBLISHABLE_KEY")
	}
	if !strings.HasPrefix(sk, "sk_test_") && !strings.HasPrefix(sk, "rk_test_") || !strings.HasPrefix(pk, "pk_test_") {
		t.Fatal("test-mode keys only")
	}
	// env "itest": our sessions' and subscriptions' metadata say env=itest,
	// so the TEST gateway's webhooks ignore them (2026-11-07: with env=test
	// the KR subscription's events reached the plan and Pro-credit paths,
	// read RevenueCat for its made-up uid and mailed E18 to the owner).
	return New(sk, "", pk, "itest"), pk
}

// pkCall is a Stripe.js-style call with the publishable key (no version
// header, as Stripe.js sends it).
func pkCall(t *testing.T, pk, path string, form url.Values) map[string]any {
	t.Helper()
	form.Set("key", pk)
	req, _ := http.NewRequest(http.MethodPost, "https://api.stripe.com"+path, strings.NewReader(form.Encode()))
	req.Header.Set("Authorization", "Bearer "+pk)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	json.Unmarshal(raw, &out)
	if resp.StatusCode >= 300 {
		t.Fatalf("%s: %d %s", path, resp.StatusCode, raw)
	}
	return out
}

// payLikeStripeJS renders the session with adaptivePricing.allowed (what
// the web passes) and pays it with tok_visa; it returns the total the
// customer saw and its currency.
func payLikeStripeJS(t *testing.T, pk, sessionID string) (int64, string) {
	t.Helper()
	init := pkCall(t, pk, "/v1/payment_pages/"+sessionID+"/init", url.Values{"eid": {"NA"}, "browser_locale": {"en-US"},
		"redirect_type": {"embedded"}, "adaptive_pricing[allowed]": {"true"}})
	total := int64(init["total_summary"].(map[string]any)["total"].(float64))
	cur, _ := init["currency"].(string)
	pm := pkCall(t, pk, "/v1/payment_methods", url.Values{"type": {"card"}, "card[token]": {"tok_visa"}})
	pkCall(t, pk, "/v1/payment_pages/"+sessionID+"/confirm", url.Values{"eid": {"NA"}, "payment_method": {pm["id"].(string)},
		"expected_amount": {strconv.FormatInt(total, 10)}, "expected_payment_method_type": {"card"},
		"init_checksum": {init["init_checksum"].(string)}})
	return total, cur
}

func apCustomer(t *testing.T, country, clock string) string {
	t.Helper()
	f := url.Values{"email": {"svs-ap-it+location_" + country + "@example.com"}, "metadata[env]": {"itest"}, "metadata[probe]": {"ap-integration"}}
	if clock != "" {
		f.Set("test_clock", clock)
	}
	var cu struct {
		ID string `json:"id"`
	}
	if err := webCall(http.MethodPost, "/v1/customers", f, "", &cu); err != nil {
		t.Fatal(err)
	}
	return cu.ID
}

func paySession(t *testing.T, c *Client, pk string, spec SessionSpec) (*Session, int64, string) {
	t.Helper()
	sess, err := c.CreateWebSession(spec)
	if err != nil {
		t.Fatal(err)
	}
	total, cur := payLikeStripeJS(t, pk, sess.ID)
	return sess, total, cur
}

func webSpec(customer, label string, cents int64) SessionSpec {
	return SessionSpec{CustomerID: customer, UI: "elements", AmountCents: cents, Currency: "usd", Label: label,
		ReturnURL: "https://example.com/r", AdaptivePricing: true, Metadata: map[string]string{"probe": "ap-integration"},
		IdemKey: "ap_it_" + strconv.FormatInt(time.Now().UnixNano(), 36)}
}

// A JP run: shown and charged in yen; the session, PaymentIntent and
// every amount we read stay USD with the yen beside them. Then two
// partial refunds in USD come back in yen at the original rate and add up
// to the whole.
func TestAPJapanRunAndRefunds(t *testing.T) {
	c, pk := apClient(t)
	sess, total, cur := paySession(t, c, pk, webSpec(apCustomer(t, "JP", ""), "AP integration run · 4K", 1000))
	if cur != "jpy" || total <= 0 {
		t.Fatalf("shown %d %s", total, cur)
	}
	out, s, err := c.SessionOutcome(sess.ID)
	if err != nil || !out.Paid || out.AmountReceived != 1000 || s.Currency != "usd" || out.Presentment == nil ||
		*out.Presentment != (Presentment{AmountMinor: total, Currency: "jpy"}) {
		t.Fatalf("outcome %+v session %s %v", out, s.Currency, err)
	}
	if p, err := c.PaymentPresentment(out.PaymentIntentID); err != nil || p == nil || *p != *out.Presentment {
		t.Fatalf("payment presentment %+v %v", p, err)
	}
	if f, err := c.PaymentFigures(out.PaymentIntentID); err != nil || f.Received != 1000 || f.Presentment == nil || f.Presentment.AmountMinor != total {
		t.Fatalf("figures %+v %v", f, err)
	}
	var back int64
	for i, amt := range []int64{400, 600} {
		re, err := c.RefundAmount(out.PaymentIntentID, amt, "ap_it_re_"+out.PaymentIntentID+strconv.Itoa(i), map[string]string{"probe": "ap-integration"})
		if err != nil || re.Amount != amt || re.Currency != "usd" || re.Presentment() == nil || re.Presentment().Currency != "jpy" {
			t.Fatalf("refund %d: %+v %v", amt, re, err)
		}
		back += re.Presentment().AmountMinor
		t.Logf("refunded US$%.2f = ¥%d", float64(amt)/100, re.Presentment().AmountMinor)
	}
	if back != total {
		t.Fatalf("refunds came back ¥%d of ¥%d", back, total)
	}
	refunds, err := c.ListRefunds(out.PaymentIntentID)
	if err != nil || len(refunds) != 2 || refunds[0].Presentment() == nil {
		t.Fatalf("listed refunds %+v %v", refunds, err)
	}
	t.Logf("JP run: US$10.00 shown and paid as ¥%d", total)
}

// A DE top-up: euros at checkout, a USD credit.
func TestAPGermanyTopup(t *testing.T) {
	c, pk := apClient(t)
	sess, total, cur := paySession(t, c, pk, webSpec(apCustomer(t, "DE", ""), "Balance top-up · $25.00", 2500))
	out, _, err := c.SessionOutcome(sess.ID)
	if cur != "eur" || err != nil || !out.Paid || out.AmountReceived != 2500 || out.Presentment == nil || out.Presentment.Currency != "eur" ||
		out.Presentment.AmountMinor != total {
		t.Fatalf("shown %d %s, outcome %+v %v", total, cur, out, err)
	}
	t.Logf("DE top-up: US$25.00 paid as €%d.%02d", total/100, total%100)
}

// A session with Adaptive Pricing sent false stays USD for a JP customer:
// what prod sends while adaptive_pricing_enabled is off.
func TestAPOffStaysUSD(t *testing.T) {
	c, pk := apClient(t)
	spec := webSpec(apCustomer(t, "JP", ""), "AP integration run (off)", 1000)
	spec.AdaptivePricing = false
	sess, total, cur := paySession(t, c, pk, spec)
	out, _, err := c.SessionOutcome(sess.ID)
	if cur != "usd" || total != 1000 || err != nil || !out.Paid || out.Presentment != nil {
		t.Fatalf("shown %d %s, outcome %+v %v", total, cur, out, err)
	}
}

// A KR Pro Monthly subscription on a test clock: won at checkout; the
// subscription and its invoices stay USD with the currency fixed to KRW;
// the renewal is charged in won at Stripe's rate for that cycle; a
// step-up the way plan_change makes it (a USD pending credit, then the
// price swap billed now) bills a USD invoice net of the credit, paid in
// won.
func TestAPKoreaProSubscription(t *testing.T) {
	c, pk := apClient(t)
	var clock struct {
		ID string `json:"id"`
	}
	if err := webCall(http.MethodPost, "/v1/test_helpers/test_clocks", url.Values{"frozen_time": {strconv.FormatInt(time.Now().Unix(), 10)},
		"name": {"svs-ap-integration"}}, "", &clock); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		var out map[string]any
		webCall(http.MethodDelete, "/v1/test_helpers/test_clocks/"+clock.ID, nil, "", &out) // takes its customer and subscription
	})
	cus := apCustomer(t, "KR", clock.ID)
	monthly, err := c.PriceByLookupKey("svs_web_pro_monthly")
	if err != nil || monthly == "" {
		t.Fatalf("pro monthly price %q %v", monthly, err)
	}
	yearly, _ := c.PriceByLookupKey("svs_web_pro_yearly")
	sess, err := c.CreatePlanSession(PlanSessionSpec{CustomerID: cus, PriceID: monthly, UI: "elements", ReturnURL: "https://example.com/r?x=1",
		Tier: "pro", UID: "itest-no-account", PlanID: "pro_monthly", AdaptivePricing: true,
		IdemKey: "ap_it_plan_" + strconv.FormatInt(time.Now().UnixNano(), 36)})
	if err != nil {
		t.Fatal(err)
	}
	total, cur := payLikeStripeJS(t, pk, sess.ID)
	if cur != "krw" || total <= 0 {
		t.Fatalf("shown %d %s", total, cur)
	}
	var cs struct {
		Subscription string `json:"subscription"`
	}
	webCall(http.MethodGet, "/v1/checkout/sessions/"+sess.ID, nil, "", &cs)
	type subT struct {
		Currency           string              `json:"currency"`
		LatestInvoice      string              `json:"latest_invoice"`
		PresentmentDetails *presentmentDetails `json:"presentment_details"`
		Items              struct {
			Data []struct {
				ID               string `json:"id"`
				CurrentPeriodEnd int64  `json:"current_period_end"`
			} `json:"data"`
		} `json:"items"`
	}
	var sub subT
	if err := webCall(http.MethodGet, "/v1/subscriptions/"+cs.Subscription, nil, "", &sub); err != nil {
		t.Fatal(err)
	}
	if sub.Currency != "usd" || sub.PresentmentDetails == nil || sub.PresentmentDetails.PresentmentCurrency != "krw" {
		t.Fatalf("subscription %+v", sub)
	}
	invoicePaid := func(id string) (*Invoice, *Presentment) {
		t.Helper()
		inv, err := c.GetInvoice(id)
		if err != nil {
			t.Fatal(err)
		}
		pi, err := c.InvoicePaymentIntent(id)
		if err != nil || pi == "" {
			t.Fatalf("invoice %s payment %q %v", id, pi, err)
		}
		p, err := c.PaymentPresentment(pi)
		if err != nil {
			t.Fatal(err)
		}
		return inv, p
	}
	first, fp := invoicePaid(sub.LatestInvoice)
	if first.Currency != "usd" || first.AmountPaid != 499 || fp == nil || fp.Currency != "krw" || fp.AmountMinor != total {
		t.Fatalf("first invoice %+v presented %+v", first, fp)
	}
	// the renewal, a period later
	var adv map[string]any
	if err := webCall(http.MethodPost, "/v1/test_helpers/test_clocks/"+clock.ID+"/advance",
		url.Values{"frozen_time": {strconv.FormatInt(sub.Items.Data[0].CurrentPeriodEnd+3*3600, 10)}}, "", &adv); err != nil {
		t.Fatal(err)
	}
	for i := 0; ; i++ {
		var st struct {
			Status string `json:"status"`
		}
		webCall(http.MethodGet, "/v1/test_helpers/test_clocks/"+clock.ID, nil, "", &st)
		if st.Status == "ready" {
			break
		}
		if i > 60 {
			t.Fatal("test clock never ready")
		}
		time.Sleep(2 * time.Second)
	}
	webCall(http.MethodGet, "/v1/subscriptions/"+cs.Subscription, nil, "", &sub)
	renewal, rp := invoicePaid(sub.LatestInvoice)
	if renewal.ID == first.ID || renewal.Currency != "usd" || renewal.AmountPaid != 499 || rp == nil || rp.Currency != "krw" {
		t.Fatalf("renewal %+v presented %+v", renewal, rp)
	}
	t.Logf("KR Pro Monthly: first ₩%d, renewal ₩%d (Stripe's rate that cycle; a test clock still uses today's rate)", fp.AmountMinor, rp.AmountMinor)
	// a step-up: pending USD credit, then the price swap billed now
	if _, err := c.AddPendingCredit(cus, cs.Subscription, 200, "Unused time on Pro Monthly (integration)", "ap_it_credit_"+cs.Subscription); err != nil {
		t.Fatal(err)
	}
	f := url.Values{"items[0][id]": {sub.Items.Data[0].ID}, "items[0][price]": {yearly}, "proration_behavior": {"none"},
		"billing_cycle_anchor[type]": {"now"}, "payment_behavior": {"error_if_incomplete"}}
	var changed subT
	if err := webCall(http.MethodPost, "/v1/subscriptions/"+cs.Subscription, f, "", &changed); err != nil {
		t.Fatal(err)
	}
	step, sp := invoicePaid(changed.LatestInvoice)
	if step.Currency != "usd" || step.AmountPaid != 4999-200 || sp == nil || sp.Currency != "krw" {
		t.Fatalf("step-up invoice %+v presented %+v", step, sp)
	}
	t.Logf("KR step-up to yearly: US$%.2f net of the US$2.00 credit, paid as ₩%d", float64(step.AmountPaid)/100, sp.AmountMinor)
}
