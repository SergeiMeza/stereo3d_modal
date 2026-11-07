package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// oneTapCustomer is a made-up account whose default (pm) has paid before.
func oneTapCustomer(t *testing.T, s *Service, f *offFake, pm, outcome string) (uid, cus string) {
	t.Helper()
	uid, cus = offCustomer(t, s, f, [2]string{pm, outcome})
	if _, err := s.Store.UpdateCustomer(context.Background(), uid, func(c *store.Customer) error {
		c.PaidMethods, c.LifetimePaidCents = []string{pm}, 1200
		c.CardBrand, c.CardLast4, c.DefaultMethodType = "visa", "4242", "card"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return uid, cus
}

// payFirstRun is a pay-first run waiting for its payment, its sheet's
// Checkout Session current.
func payFirstRun(t *testing.T, s *Service, uid, cus string, cents int64) *store.Conversion {
	t.Helper()
	exp := time.Now().Add(30 * time.Minute)
	sess := &store.Payment{Kind: store.PaymentCheckoutSession, ID: "cs_sheet_" + store.NewID(), Attempt: 1, CreatedAt: time.Now()}
	c := &store.Conversion{ID: store.NewID(), UID: uid, State: store.StateCreated, Kind: "video", PaymentFlow: store.FlowPayNow,
		CurrentPayment: sess, Payments: []store.Payment{*sess}, ExpiresAt: &exp, Quote: store.Quote{AmountCents: cents, Currency: "usd"}}
	c.Stripe = store.Stripe{CustomerID: cus, Mode: store.BillingModeAutoPrecharge}
	if err := s.Store.CreateConversion(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	return c
}

func tapRun(t *testing.T, s *Service, uid, id string, cents int64, header ...string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/v1/conversions/"+id+"/pay-one-tap", strings.NewReader(fmt.Sprintf(`{"amount_cents":%d}`, cents)))
	if len(header) == 2 {
		r.Header.Set(header[0], header[1])
	}
	s.HandleRunPayOneTap(rec, r, &AuthedUser{UID: uid, Email: uid + "@example.com"}, id)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func tapSettle(t *testing.T, s *Service, uid string, cents int64) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/v1/billing/settle/one-tap", strings.NewReader(fmt.Sprintf(`{"amount_cents":%d}`, cents)))
	s.HandleSettleOneTap(rec, r, &AuthedUser{UID: uid})
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func errCode(out map[string]any) string {
	c, _ := out["error"].(string)
	return c
}

// The offer appears only for a default that has paid, outside China,
// with the config on, and not for blocked or sheet-only accounts.
func TestOneTapOfferGates(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := oneTapCustomer(t, s, f, "pm_1", "")
	cust, _ := s.Store.GetCustomer(ctx, uid)
	got := s.oneTapOffer(ctx, uid, cust, 1500, false)
	if got == nil || got["brand"] != "visa" || got["last4"] != "4242" || got["amount_cents"] != int64(1500) || got["currency"] != "usd" {
		t.Fatalf("offer %v", got)
	}
	if s.oneTapOffer(ctx, uid, cust, 1500, true) != nil {
		t.Fatal("offered in China mode")
	}
	for name, mut := range map[string]func(c *store.Customer){
		"never paid":  func(c *store.Customer) { c.PaidMethods, c.LifetimePaidCents = nil, 0 },
		"other paid":  func(c *store.Customer) { c.PaidMethods = []string{"pm_old"} },
		"sheet only":  func(c *store.Customer) { c.SheetOnly = true },
		"all failed":  func(c *store.Customer) { c.AllMethodsFailed = true },
		"blocked":     func(c *store.Customer) { c.Blocked = true },
		"deleting":    func(c *store.Customer) { c.DeletionPending = true },
		"no default":  func(c *store.Customer) { c.DefaultPaymentMethod = "" },
		"in review":   func(c *store.Customer) { c.UnderReview = true },
		"no customer": func(c *store.Customer) { c.StripeCustomerID = "" },
	} {
		c := *cust
		mut(&c)
		if s.oneTapOffer(ctx, uid, &c, 1500, false) != nil {
			t.Errorf("%s: offered", name)
		}
	}
	r := pricing.DefaultsFor("test")
	r.OneTapEnabled = false
	s.Pricing = pricing.NewStatic(r)
	if s.oneTapOffer(ctx, uid, cust, 1500, false) != nil {
		t.Fatal("offered with one_tap_enabled off")
	}
	if pricing.DefaultsFor("prod").OneTapEnabled {
		t.Fatal("prod default must be off")
	}
}

// A tap pays the run: one on-session USD PaymentIntent under pmc_web on
// the default, made unconfirmed (recorded as the run's payment, the
// sheet's session closed) then confirmed with a return_url; the
// succeeded webhook afterwards changes nothing.
func TestOneTapRunPays(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, cus := oneTapCustomer(t, s, f, "pm_1", "")
	run := payFirstRun(t, s, uid, cus, 1500)
	code, out := tapRun(t, s, uid, run.ID, 1500)
	if code != 200 || out["state"] != "succeeded" {
		t.Fatalf("%d %v", code, out)
	}
	if len(f.creates) != 1 || len(f.confirms) != 1 || len(f.expired) != 1 || f.expired[0] != run.CurrentPayment.ID {
		t.Fatalf("creates %d confirms %d expired %v", len(f.creates), len(f.confirms), f.expired)
	}
	c := f.creates[0]
	if c["confirm"] == "true" || c["off_session"] == "true" || c["currency"] != "usd" || c["amount"] != "1500" || c["customer"] != cus ||
		c["payment_method"] != "pm_1" || c["payment_method_configuration"] != "pmc_test" || c["metadata[conversion_id]"] != run.ID ||
		!strings.HasPrefix(c["key"], "onetap_test_"+run.ID+"_") {
		t.Fatalf("create %v", c)
	}
	if cf := f.confirms[0]; cf["off_session"] == "true" || cf["return_url"] != "https://site.example/pay/return?c="+run.ID {
		t.Fatalf("confirm %v", cf)
	}
	got, _ := s.Store.GetConversion(ctx, run.ID)
	if got.State != store.StatePaid || got.Stripe.PIStatus != store.PISucceeded || got.Stripe.PaymentIntentID != "pi_off_1" {
		t.Fatalf("run %+v", got.Stripe)
	}
	if err := s.applyPaymentEvent(ctx, run.ID, "pi_off_1", 1500); err != nil {
		t.Fatal(err)
	}
	if f.succeeded() != 1 {
		t.Fatalf("%d payments", f.succeeded())
	}
	// A second tap on a paid run: already paid, no PaymentIntent.
	if code, out := tapRun(t, s, uid, run.ID, 1500); code != 409 || errCode(out) != "already_paid" || len(f.creates) != 1 {
		t.Fatalf("again: %d %v", code, out)
	}
}

// The client's amount must be the server's.
func TestOneTapRunAmountMismatch(t *testing.T) {
	s, f := offService(t)
	uid, cus := oneTapCustomer(t, s, f, "pm_1", "")
	run := payFirstRun(t, s, uid, cus, 1500)
	code, out := tapRun(t, s, uid, run.ID, 1400)
	d, _ := out["details"].(map[string]any)
	if code != 409 || errCode(out) != "amount_changed" || d["amount_cents"] != float64(1500) || len(f.creates) != 0 {
		t.Fatalf("%d %v", code, out)
	}
}

// Refused when one tap isn't allowed: never paid, China mode, a run that
// doesn't pay first.
func TestOneTapRunRefused(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, cus := offCustomer(t, s, f, [2]string{"pm_new", ""}) // never paid
	run := payFirstRun(t, s, uid, cus, 1500)
	if code, out := tapRun(t, s, uid, run.ID, 1500); code != 409 || errCode(out) != "one_tap_unavailable" {
		t.Fatalf("never paid: %d %v", code, out)
	}
	uid2, cus2 := oneTapCustomer(t, s, f, "pm_1", "")
	run2 := payFirstRun(t, s, uid2, cus2, 1500)
	if code, out := tapRun(t, s, uid2, run2.ID, 1500, "X-Client-Mode", "china"); code != 409 || errCode(out) != "one_tap_unavailable" {
		t.Fatalf("china: %d %v", code, out)
	}
	s.Store.Transition(ctx, run2.ID, []string{store.StateCreated}, func(c *store.Conversion) error { c.PaymentFlow = store.FlowChina; return nil })
	if code, out := tapRun(t, s, uid2, run2.ID, 1500); code != 409 || errCode(out) != "one_tap_unavailable" {
		t.Fatalf("china run: %d %v", code, out)
	}
	if code, _ := tapRun(t, s, "someone-else", run2.ID, 1500); code != 404 {
		t.Fatalf("another account's run: %d", code)
	}
	if len(f.creates) != 0 {
		t.Fatalf("%d PaymentIntents", len(f.creates))
	}
}

// The bank's check: requires_action with the client secret, no money and
// the run still waiting; the web confirms, the webhook pays it once.
func TestOneTapRunBankCheck(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, cus := oneTapCustomer(t, s, f, "pm_3ds", "auth")
	run := payFirstRun(t, s, uid, cus, 1500)
	code, out := tapRun(t, s, uid, run.ID, 1500)
	if code != 200 || out["state"] != "requires_action" || out["client_secret"] != "pi_off_1_secret_x" {
		t.Fatalf("%d %v", code, out)
	}
	got, _ := s.Store.GetConversion(ctx, run.ID)
	if got.State != store.StateCreated || got.CurrentPayment == nil || got.CurrentPayment.ID != "pi_off_1" || len(f.cancels) != 0 ||
		got.Stripe.OneTapUntil != nil {
		t.Fatalf("run %s %+v cancels %v", got.State, got.CurrentPayment, f.cancels)
	}
	f.mu.Lock()
	f.pis["pi_off_1"]["status"], f.pis["pi_off_1"]["amount_received"] = "succeeded", int64(1500) // handleNextAction done
	f.mu.Unlock()
	for range 2 { // delivered twice
		if err := s.applyPaymentEvent(ctx, run.ID, "pi_off_1", 1500); err != nil {
			t.Fatal(err)
		}
	}
	got, _ = s.Store.GetConversion(ctx, run.ID)
	if got.State != store.StatePaid || got.Stripe.PaymentIntentID != "pi_off_1" || f.succeeded() != 1 {
		t.Fatalf("after the webhook: %s %+v", got.State, got.Stripe)
	}
}

// A decline: a customer-safe message, the PaymentIntent closed, no
// credit; the next tap is a new PaymentIntent under a new key.
func TestOneTapRunDeclineThenFreshKey(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, cus := oneTapCustomer(t, s, f, "pm_1", "decline:insufficient_funds")
	run := payFirstRun(t, s, uid, cus, 1500)
	code, out := tapRun(t, s, uid, run.ID, 1500)
	msg, _ := out["message"].(string)
	if code != 200 || out["state"] != "declined" || msg == "" || strings.Contains(msg, "pi_") || out["decline_code"] != "insufficient_funds" {
		t.Fatalf("%d %v", code, out)
	}
	if got, _ := s.Store.GetConversion(ctx, run.ID); got.State != store.StateCreated || got.Stripe.PIStatus == store.PISucceeded {
		t.Fatalf("declined run %s %s", got.State, got.Stripe.PIStatus)
	}
	if len(f.cancels) != 1 || f.cancels[0] != "pi_off_1" {
		t.Fatalf("cancels %v", f.cancels)
	}
	f.mu.Lock()
	f.outcome["pm_1"] = ""
	f.mu.Unlock()
	code, out = tapRun(t, s, uid, run.ID, 1500)
	if code != 200 || out["state"] != "succeeded" || len(f.creates) != 2 || f.creates[0]["key"] == f.creates[1]["key"] {
		t.Fatalf("second tap %d %v keys %q %q", code, out, f.creates[0]["key"], f.creates[1]["key"])
	}
	if f.succeeded() != 1 {
		t.Fatalf("%d payments", f.succeeded())
	}
}

// A double tap: the second, while the first is held, is refused; at most
// one PaymentIntent takes money.
func TestOneTapRunDoubleTap(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, cus := oneTapCustomer(t, s, f, "pm_1", "")
	run := payFirstRun(t, s, uid, cus, 1500)
	until := time.Now().Add(time.Minute)
	s.Store.Transition(ctx, run.ID, []string{store.StateCreated}, func(c *store.Conversion) error { c.Stripe.OneTapUntil = &until; return nil })
	if code, out := tapRun(t, s, uid, run.ID, 1500); code != 409 || errCode(out) != "payment_in_progress" || len(f.creates) != 0 {
		t.Fatalf("held: %d %v", code, out)
	}
	s.Store.Transition(ctx, run.ID, []string{store.StateCreated}, func(c *store.Conversion) error { c.Stripe.OneTapUntil = nil; return nil })
	var wg sync.WaitGroup
	codes := make([]int, 4)
	for i := range codes {
		wg.Add(1)
		go func() { defer wg.Done(); codes[i], _ = tapRun(t, s, uid, run.ID, 1500) }()
	}
	wg.Wait()
	if f.succeeded() != 1 {
		t.Fatalf("%d payments from 4 taps (codes %v)", f.succeeded(), codes)
	}
	if got, _ := s.Store.GetConversion(ctx, run.ID); got.State != store.StatePaid {
		t.Fatalf("run %s", got.State)
	}
}

// What the account owes, with one tap: the amount checked, the charge
// recorded first (B5), an on-session PaymentIntent under pmc_web.
func TestOneTapSettlePays(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, cus := oneTapCustomer(t, s, f, "pm_1", "")
	owedConversion(t, s, uid, 900)
	owedConversion(t, s, uid, 600)
	if code, out := tapSettle(t, s, uid, 1400); code != 409 || errCode(out) != "amount_changed" || len(f.creates) != 0 {
		t.Fatalf("mismatch: %d %v", code, out)
	}
	code, out := tapSettle(t, s, uid, 1500)
	if code != 200 || out["state"] != "succeeded" || out["settled"] != true {
		t.Fatalf("%d %v", code, out)
	}
	c := f.creates[0]
	if len(f.creates) != 1 || c["confirm"] != "true" || c["off_session"] == "true" || c["currency"] != "usd" || c["customer"] != cus ||
		c["payment_method_configuration"] != "pmc_test" || c["metadata[payment_flow]"] != "settle_one_tap" ||
		!strings.HasPrefix(c["return_url"], "https://site.example/billing?settle=") || !strings.HasSuffix(c["key"], "_onetap") {
		t.Fatalf("create %v", c)
	}
	sid, _ := out["settle_id"].(string)
	st, _ := s.Store.GetSettle(ctx, sid)
	if st.State != store.SettlePaid || st.ChargeKey != c["key"] || st.ChargePM != "pm_1" || s.owedCents(ctx, uid) != 0 {
		t.Fatalf("settle %+v owed %d", st, s.owedCents(ctx, uid))
	}
}

// A bank check on a settle: requires_action with the client secret, the
// settle live; the succeeded webhook (twice) pays it once.
func TestOneTapSettleBankCheck(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := oneTapCustomer(t, s, f, "pm_3ds", "auth")
	owedConversion(t, s, uid, 1500)
	code, out := tapSettle(t, s, uid, 1500)
	if code != 200 || out["state"] != "requires_action" || out["client_secret"] != "pi_off_1_secret_x" {
		t.Fatalf("%d %v", code, out)
	}
	sid, _ := out["settle_id"].(string)
	// A second tap meanwhile answers the same check, no new PaymentIntent.
	if code, out := tapSettle(t, s, uid, 1500); code != 200 || out["state"] != "requires_action" || len(f.creates) != 1 {
		t.Fatalf("second tap: %d %v", code, out)
	}
	f.mu.Lock()
	f.pis["pi_off_1"]["status"], f.pis["pi_off_1"]["amount_received"] = "succeeded", int64(1500)
	f.mu.Unlock()
	for range 2 {
		s.handleSettlePI(ctx, httptest.NewRecorder(), "payment_intent.succeeded", sid, "pi_off_1", "succeeded", 1500)
	}
	st, _ := s.Store.GetSettle(ctx, sid)
	if st.State != store.SettlePaid || s.owedCents(ctx, uid) != 0 || f.succeeded() != 1 {
		t.Fatalf("settle %s owed %d", st.State, s.owedCents(ctx, uid))
	}
}

// A decline on a settle: the message, the debt still owed, nothing paid.
func TestOneTapSettleDecline(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := oneTapCustomer(t, s, f, "pm_1", "decline:card_declined")
	owedConversion(t, s, uid, 1500)
	code, out := tapSettle(t, s, uid, 1500)
	if code != 200 || out["state"] != "declined" || out["message"] == "" {
		t.Fatalf("%d %v", code, out)
	}
	if s.owedCents(ctx, uid) != 1500 || f.succeeded() != 0 {
		t.Fatalf("owed %d", s.owedCents(ctx, uid))
	}
}

// The sheet was open (a live settle with its Checkout Session): one tap
// closes the session and pays on the default; the sheet answer carries
// the offer, a China-mode one doesn't.
func TestOneTapOnLiveSheetSettle(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := oneTapCustomer(t, s, f, "pm_1", "")
	owedConversion(t, s, uid, 1500)
	sheet := func(header ...string) map[string]any {
		rec := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/v1/billing/settle", strings.NewReader(`{"ui":"elements"}`))
		if len(header) == 2 {
			r.Header.Set(header[0], header[1])
		}
		s.HandleSettle2(rec, r, &AuthedUser{UID: uid})
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}
	out := sheet()
	offer, _ := out["one_tap"].(map[string]any)
	if out["checkout"] == nil || offer == nil || offer["amount_cents"] != float64(1500) || len(f.sessions) != 1 {
		t.Fatalf("sheet %v", out)
	}
	if again := sheet("X-Client-Mode", "china"); again["one_tap"] != nil {
		t.Fatalf("China answer offers one tap: %v", again["one_tap"])
	}
	code, out := tapSettle(t, s, uid, 1500)
	if code != 200 || out["state"] != "succeeded" || len(f.expired) < 1 || f.succeeded() != 1 || s.owedCents(ctx, uid) != 0 {
		t.Fatalf("%d %v expired %v", code, out, f.expired)
	}
}
