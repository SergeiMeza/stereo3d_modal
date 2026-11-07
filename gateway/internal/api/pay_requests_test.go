package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

var payIPs int

func payCall(t *testing.T, h func(http.ResponseWriter, *http.Request), method, token, body string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(method, "/v1/pay-requests/"+token, strings.NewReader(body))
	r.SetPathValue("token", token)
	payIPs++
	r.RemoteAddr = fmt.Sprintf("198.51.%d.%d:1", payIPs/250, payIPs%250) // a fresh IP per call: the limits stay out of the way
	h(rec, r)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func tokenOf(t *testing.T, link string) string {
	t.Helper()
	i := strings.LastIndex(link, "/pay/")
	if i < 0 {
		t.Fatalf("not a pay link: %s", link)
	}
	return link[i+5:]
}

// A failed auto-reload's link: GET shows only label, amount and state; the
// checkout is a top-up for exactly that amount (the client can't name
// another), under pmc_web with Adaptive Pricing per config; once the
// top-up is paid the link closes and refuses another payment.
func TestPayLinkTopup(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_1", ""})
	link, p := s.payLink(ctx, uid, store.PayKindTopup, "r_failed", 2000, "Auto-reload · $20.00")
	if p == nil || !strings.HasPrefix(link, "https://site.example/pay/pr_") {
		t.Fatalf("link %q", link)
	}
	again, _ := s.payLink(ctx, uid, store.PayKindTopup, "r_failed", 2000, "Auto-reload · $20.00")
	if again != link {
		t.Fatal("a second mail for the same debt made a second link")
	}
	tok := tokenOf(t, link)
	code, got := payCall(t, s.HandleGetPayRequest, "GET", tok, "")
	if code != 200 || len(got) != 5 || got["label"] != "Auto-reload · $20.00" || got["kind"] != "topup" || got["amount_cents"] != float64(2000) ||
		got["currency"] != "usd" || got["state"] != "open" || got["plan_name"] != nil {
		t.Fatalf("GET %d %v", code, got)
	}
	code, out := payCall(t, s.HandlePayRequestCheckout, "POST", tok, `{"amount_cents":1,"ui":"elements"}`)
	if code != 200 || out["amount_cents"] != float64(2000) || out["checkout"] == nil {
		t.Fatalf("checkout %d %v", code, out)
	}
	form := f.sessions[len(f.sessions)-1]
	if form["line_items[0][price_data][unit_amount]"] != "2000" || form["metadata[pay_request]"] != tok || form["metadata[kind]"] != "topup" ||
		form["payment_method_configuration"] != "pmc_test" || form["adaptive_pricing[enabled]"] != "true" {
		t.Fatalf("session %v", form)
	}
	pr, _ := s.Store.GetPayRequest(ctx, tok)
	tp, _ := s.Store.GetTopup(ctx, pr.TopupID)
	if tp.PayRequestID != tok || tp.Cents != 2000 || tp.Auto {
		t.Fatalf("topup %+v", tp)
	}
	// paid (the checkout webhook's path)
	if err := s.applyTopupPayment(ctx, tp.ID, stripexPaid("pi_pay", 2000)); err != nil {
		t.Fatal(err)
	}
	if _, got := payCall(t, s.HandleGetPayRequest, "GET", tok, ""); got["state"] != "paid" {
		t.Fatalf("after paying %v", got)
	}
	if code, out := payCall(t, s.HandlePayRequestCheckout, "POST", tok, `{}`); code != 409 || out["error"] != "pay_link_closed" {
		t.Fatalf("a second payment %d %v", code, out)
	}
	if b, _ := s.Store.GetBalance(ctx, uid); b.BalanceCents != 2000 {
		t.Fatalf("balance %d", b.BalanceCents)
	}
}

// Unknown, malformed and another environment's tokens all answer the same
// 404, revealing nothing.
func TestPayLinkUnknownTokens(t *testing.T) {
	s, _ := offService(t)
	for _, tok := range []string{"pr_doesnotexist0000000000000000000000000", "x", "pr_" + strings.Repeat("a", 80)} {
		code, out := payCall(t, s.HandleGetPayRequest, "GET", tok, "")
		if code != 404 || out["error"] != "pay_link_not_found" || out["details"] != nil {
			t.Fatalf("%q: %d %v", tok, code, out)
		}
		if code, _ := payCall(t, s.HandlePayRequestCheckout, "POST", tok, ""); code != 404 {
			t.Fatalf("%q POST %d", tok, code)
		}
	}
}

// Deletion dues: the link shows what is owed now and opens the settle
// sheet for it; paid another way (the dues charged), the link closes.
func TestPayLinkSettle(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_1", ""})
	owedConversion(t, s, uid, 1500)
	link, _ := s.payLink(ctx, uid, store.PayKindSettle, "deletion", 1500, "Your last runs")
	tok := tokenOf(t, link)
	owedConversion(t, s, uid, 500) // more owed since the mail: the live amount
	if _, got := payCall(t, s.HandleGetPayRequest, "GET", tok, ""); got["amount_cents"] != float64(2000) || got["state"] != "open" || got["kind"] != "settle" {
		t.Fatalf("GET %v", got)
	}
	code, out := payCall(t, s.HandlePayRequestCheckout, "POST", tok, `{}`)
	if code != 200 || out["amount_cents"] != float64(2000) || out["checkout"] == nil {
		t.Fatalf("checkout %d %v", code, out)
	}
	if form := f.sessions[len(f.sessions)-1]; form["metadata[kind]"] != "settle" || form["line_items[0][price_data][unit_amount]"] != "2000" {
		t.Fatalf("session %v", form)
	}
	// the sheet's settle lapses unpaid; the dues are then charged another way
	settles, _ := s.Store.ListSettlesByState(ctx, store.SettleSettling, 10)
	for _, st := range settles {
		if st.UID == uid {
			s.Store.FinishSettle(ctx, st.ID, store.SettleOutcome{}, nil)
		}
	}
	if res, err := s.collectOutstanding(ctx, uid, settleDelete, payContext{}); err != nil || !res.Paid {
		t.Fatalf("%v %+v", err, res)
	}
	if pr, _ := s.Store.GetPayRequest(ctx, tok); pr.State != store.PayPaid {
		t.Fatalf("link %s", pr.State)
	}
}

// A renewal invoice's link answers with Stripe's hosted invoice page; a
// paid invoice closes it; an expired link refuses.
func TestPayLinkInvoiceAndExpiry(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_1", ""})
	f.invoices["in_1"] = map[string]any{"id": "in_1", "object": "invoice", "status": "open", "amount_due": 29900, "hosted_invoice_url": "https://invoice.stripe.example/in_1"}
	tok := tokenOf(t, func() string {
		l, _ := s.payLink(ctx, uid, store.PayKindInvoice, "in_1", 29900, "Business renewal")
		return l
	}())
	if code, out := payCall(t, s.HandlePayRequestCheckout, "POST", tok, `{}`); code != 200 || out["url"] != "https://invoice.stripe.example/in_1" {
		t.Fatalf("%d %v", code, out)
	}
	// REV-13: the plan the invoice renews, for the page's heading
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error { c.Plan = &store.Plan{Tier: "business"}; return nil })
	if _, got := payCall(t, s.HandleGetPayRequest, "GET", tok, ""); got["kind"] != "invoice" || got["plan_id"] != "business" || got["plan_name"] == nil || got["plan_name"] == "" {
		t.Fatalf("invoice GET %v", got)
	}
	f.invoices["in_1"]["status"] = "paid"
	if _, got := payCall(t, s.HandleGetPayRequest, "GET", tok, ""); got["state"] != "paid" {
		t.Fatalf("%v", got)
	}
	tok2 := tokenOf(t, func() string { l, _ := s.payLink(ctx, uid, store.PayKindTopup, "r_x", 1000, "x"); return l }())
	s.Store.UpdatePayRequest(ctx, tok2, func(p *store.PayRequest) error { p.ExpiresAt = time.Now().Add(-time.Minute); return nil })
	if code, out := payCall(t, s.HandlePayRequestCheckout, "POST", tok2, `{}`); code != 409 || out["details"].(map[string]any)["state"] != "expired" {
		t.Fatalf("%d %v", code, out)
	}
}

func stripexPaid(pi string, cents int64) stripex.Outcome {
	return stripex.Outcome{Paid: true, PaymentIntentID: pi, AmountReceived: cents, PaymentMethod: "pm_1"}
}

// REV-08: the pay routes' limits key on the address the load balancer
// saw: a made-up X-Client-IP (or a forged first X-Forwarded-For hop) on
// every call doesn't get past them; the relay's X-Client-IP still counts
// per caller.
func TestPayLinkLimitIgnoresClaimedIPs(t *testing.T) {
	s, _ := offService(t)
	s.Cfg.LBIPs, s.Cfg.RelayIPs = "34.117.11.37", "101.47.76.86"
	call := func(i int, xff, claimed string) int {
		rec := httptest.NewRecorder()
		r := httptest.NewRequest("GET", "/v1/pay-requests/pr_x", nil)
		r.SetPathValue("token", "pr_doesnotexist0000000000000000000000000")
		r.RemoteAddr = "169.254.1.1:1"
		r.Header.Set("X-Forwarded-For", xff)
		if claimed != "" {
			r.Header.Set("X-Client-IP", claimed)
		}
		s.HandleGetPayRequest(rec, r)
		return rec.Code
	}
	limited := false
	for i := 0; i < 70; i++ {
		forged := fmt.Sprintf("10.9.%d.%d", i/250, i%250)
		if call(i, forged+", 203.0.113.77, 34.117.11.37", forged) == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("70 reads with made-up client addresses all got through")
	}
	// through the relay: each claimed caller has its own allowance
	for i := 0; i < 3; i++ {
		if code := call(i, fmt.Sprintf("198.18.0.%d, 101.47.76.86, 34.117.11.37", i), fmt.Sprintf("198.18.0.%d", i)); code != http.StatusNotFound {
			t.Fatalf("relay caller %d: %d", i, code)
		}
	}
}
