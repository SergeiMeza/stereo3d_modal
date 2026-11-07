//go:build stripetest

package api

// BUX-20 one-tap pay against real Stripe test mode (see
// stripetest_offsession_test.go for the guard rails). The bank's check
// (3184) is answered the way Stripe.js's handleNextAction does in test
// mode: 3ds2/authenticate with the publishable key, then "Complete" on
// Stripe's test ACS page. Link and PayPal methods can't be saved through
// the API in test mode, so a Link default under pmc_web is covered by the
// unit tests only.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stripe/stripe-go/v78"
	"github.com/stripe/stripe-go/v78/paymentintent"

	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// stOneTapService is stService with a Modal that refuses (a paid run's
// submit fails and is left to the reconciler).
func stOneTapService(t *testing.T) *Service {
	s := stService(t)
	modal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) }))
	t.Cleanup(modal.Close)
	s.Modal = modalapi.New(modal.URL, "", "")
	return s
}

// stPaidBefore marks the account's default as one that has paid.
func stPaidBefore(t *testing.T, s *Service, uid string) {
	t.Helper()
	if _, err := s.Store.UpdateCustomer(context.Background(), uid, func(c *store.Customer) error {
		c.PaidMethods, c.LifetimePaidCents = []string{c.DefaultPaymentMethod}, 1200
		c.CardBrand, c.CardLast4, c.DefaultMethodType = "visa", "4242", "card"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func stPayFirstRun(t *testing.T, s *Service, uid, cus string, cents int64) *store.Conversion {
	t.Helper()
	exp := time.Now().Add(30 * time.Minute)
	c := &store.Conversion{ID: store.NewID(), UID: uid, State: store.StateCreated, Kind: "video", PaymentFlow: store.FlowPayNow,
		ExpiresAt: &exp, Quote: store.Quote{AmountCents: cents, Currency: "usd"}}
	c.Stripe = store.Stripe{CustomerID: cus, Mode: store.BillingModeAutoPrecharge}
	if err := s.Store.CreateConversion(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	return c
}

// stPassBankCheck answers a requires_action PaymentIntent's 3DS2 test
// challenge with "Complete", as the web's handleNextAction would.
func stPassBankCheck(t *testing.T, piID string) {
	t.Helper()
	pk := strings.TrimSpace(os.Getenv("STRIPE_TEST_PK"))
	if !strings.HasPrefix(pk, "pk_test_") {
		t.Skip("needs STRIPE_TEST_PK (pk_test_) to answer the bank's check")
	}
	pi, err := paymentintent.Get(piID, nil)
	if err != nil || pi.NextAction == nil || pi.NextAction.RedirectToURL == nil {
		t.Fatalf("PI %s next action: %v", piID, err)
	}
	src := regexp.MustCompile(`source=([^&]+)`).FindStringSubmatch(pi.NextAction.RedirectToURL.URL)
	if src == nil {
		t.Fatalf("no 3DS source in the next action")
	}
	browser := `{"fingerprintAttempted":false,"fingerprintData":null,"challengeWindowSize":null,"threeDSCompInd":"Y",` +
		`"browserJavaEnabled":false,"browserJavascriptEnabled":true,"browserLanguage":"en-US","browserColorDepth":"24",` +
		`"browserScreenHeight":"1080","browserScreenWidth":"1920","browserTZ":"-540","browserUserAgent":"Mozilla/5.0"}`
	resp, err := http.PostForm("https://api.stripe.com/v1/3ds2/authenticate", url.Values{"source": {src[1]}, "browser": {browser},
		"one_click_authn_device_support[hosted]": {"false"}, "one_click_authn_device_support[spc_eligible]": {"false"},
		"one_click_authn_device_support[webauthn_eligible]":                 {"false"},
		"one_click_authn_device_support[publickey_credentials_get_allowed]": {"false"}, "key": {pk}})
	if err != nil {
		t.Fatal(err)
	}
	var auth struct {
		Ares struct {
			AcsURL string `json:"acsURL"`
		} `json:"ares"`
		Creq  string `json:"creq"`
		State string `json:"state"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&auth)
	resp.Body.Close()
	if auth.State != "challenge_required" || !strings.HasPrefix(auth.Ares.AcsURL, "https://testmode-acs.stripe.com/") {
		t.Fatalf("3ds2 authenticate: %s", auth.State)
	}
	if r, err := http.PostForm(auth.Ares.AcsURL, url.Values{"creq": {auth.Creq}}); err == nil {
		r.Body.Close()
	}
	r, err := http.PostForm(auth.Ares.AcsURL+"/complete", url.Values{"challenge": {"allow"}})
	if err != nil || r.StatusCode != 200 {
		t.Fatalf("challenge complete: %v", err)
	}
	r.Body.Close()
	for range 10 {
		if pi, err = paymentintent.Get(piID, nil); err == nil && pi.Status == stripe.PaymentIntentStatusSucceeded {
			t.Logf("evidence: bank check on %s answered: %s", piID, pi.Status)
			return
		}
		time.Sleep(time.Second)
	}
	t.Fatalf("PI %s still %s after the check", piID, pi.Status)
}

// A tap on a pay-first run: visa pays once (on-session, USD, pmc_web);
// 3184 asks for the bank's check, answered and applied once by the
// webhook; 0341 declines with a customer-safe message and the next tap is
// a fresh PaymentIntent; a mismatched amount makes nothing; four
// concurrent taps take money once.
func TestStripeTestOneTapRun(t *testing.T) {
	s := stOneTapService(t)
	ctx := context.Background()
	t.Run("visa", func(t *testing.T) {
		uid, cus, _ := stCustomer(t, s, "onetap-visa", "pm_card_visa")
		stPaidBefore(t, s, uid)
		run := stPayFirstRun(t, s, uid, cus, 1500)
		if code, out := tapRun(t, s, uid, run.ID, 1400); code != 409 || errCode(out) != "amount_changed" {
			t.Fatalf("mismatch %d %v", code, out)
		}
		code, out := tapRun(t, s, uid, run.ID, 1500)
		pis := stPIs(t, cus)
		got, _ := s.Store.GetConversion(ctx, run.ID)
		if code != 200 || out["state"] != "succeeded" || len(pis) != 1 || got.State != store.StatePaid {
			t.Fatalf("%d %v PIs %d run %s", code, out, len(pis), got.State)
		}
		pi := pis[0]
		if pi.Currency != "usd" || pi.Amount != 1500 || pi.PaymentMethodConfigurationDetails == nil ||
			pi.PaymentMethodConfigurationDetails.ID != s.Cfg.StripePMCWeb || pi.Metadata["conversion_id"] != run.ID ||
			pi.SetupFutureUsage != "" {
			t.Fatalf("PI %+v", pi)
		}
		if err := s.applyPaymentEvent(ctx, run.ID, pi.ID, 1500); err != nil { // the webhook, after the answer
			t.Fatal(err)
		}
		if n := countStatus(stPIs(t, cus), stripe.PaymentIntentStatusSucceeded); n != 1 {
			t.Fatalf("%d succeeded", n)
		}
	})
	t.Run("3184-bank-check", func(t *testing.T) {
		uid, cus, _ := stCustomer(t, s, "onetap-3184", "pm_card_authenticationRequired")
		stPaidBefore(t, s, uid)
		run := stPayFirstRun(t, s, uid, cus, 1500)
		code, out := tapRun(t, s, uid, run.ID, 1500)
		secret, _ := out["client_secret"].(string)
		if code != 200 || out["state"] != "requires_action" || !strings.Contains(secret, "_secret_") {
			t.Fatalf("%d %v", code, out["state"])
		}
		got, _ := s.Store.GetConversion(ctx, run.ID)
		piID := got.CurrentPayment.ID
		if got.State != store.StateCreated || !strings.HasPrefix(secret, piID+"_secret_") {
			t.Fatalf("run %s current %s", got.State, piID)
		}
		stPassBankCheck(t, piID)
		for range 2 { // the webhook, delivered twice
			if err := s.applyPaymentEvent(ctx, run.ID, piID, 1500); err != nil {
				t.Fatal(err)
			}
		}
		got, _ = s.Store.GetConversion(ctx, run.ID)
		pis := stPIs(t, cus)
		if got.State != store.StatePaid || got.Stripe.PaymentIntentID != piID || countStatus(pis, stripe.PaymentIntentStatusSucceeded) != 1 ||
			len(pis) != 1 {
			t.Fatalf("run %s PIs %d", got.State, len(pis))
		}
	})
	t.Run("0341-decline", func(t *testing.T) {
		uid, cus, _ := stCustomer(t, s, "onetap-0341", "pm_card_chargeCustomerFail")
		stPaidBefore(t, s, uid)
		run := stPayFirstRun(t, s, uid, cus, 1500)
		for i := range 2 {
			code, out := tapRun(t, s, uid, run.ID, 1500)
			msg, _ := out["message"].(string)
			if code != 200 || out["state"] != "declined" || msg == "" || strings.Contains(msg, "pi_") {
				t.Fatalf("tap %d: %d %v", i, code, out)
			}
			t.Logf("evidence: decline answer %q code %v", msg, out["decline_code"])
		}
		pis := stPIs(t, cus)
		got, _ := s.Store.GetConversion(ctx, run.ID)
		if len(pis) != 2 || countStatus(pis, stripe.PaymentIntentStatusCanceled) != 2 || got.State != store.StateCreated {
			t.Fatalf("PIs %d run %s", len(pis), got.State)
		}
	})
	t.Run("double-tap", func(t *testing.T) {
		uid, cus, _ := stCustomer(t, s, "onetap-double", "pm_card_visa")
		stPaidBefore(t, s, uid)
		run := stPayFirstRun(t, s, uid, cus, 1500)
		var wg sync.WaitGroup
		codes := make([]int, 4)
		for i := range codes {
			wg.Add(1)
			go func() { defer wg.Done(); codes[i], _ = tapRun(t, s, uid, run.ID, 1500) }()
		}
		wg.Wait()
		pis := stPIs(t, cus)
		t.Logf("evidence: four taps answered %v", codes)
		if countStatus(pis, stripe.PaymentIntentStatusSucceeded) != 1 {
			t.Fatalf("%d paid of %d PIs", countStatus(pis, stripe.PaymentIntentStatusSucceeded), len(pis))
		}
	})
}

// What the account owes, with one tap: visa pays the settle; 3184's check
// answered and the webhook settles it once; a mismatch makes nothing.
func TestStripeTestOneTapSettle(t *testing.T) {
	s := stOneTapService(t)
	ctx := context.Background()
	t.Run("visa", func(t *testing.T) {
		uid, cus, _ := stCustomer(t, s, "onetap-settle", "pm_card_visa")
		stPaidBefore(t, s, uid)
		stOwedRun(t, s, uid, 900)
		stOwedRun(t, s, uid, 600)
		if code, out := tapSettle(t, s, uid, 900); code != 409 || errCode(out) != "amount_changed" || len(stPIs(t, cus)) != 0 {
			t.Fatalf("mismatch %d %v", code, out)
		}
		code, out := tapSettle(t, s, uid, 1500)
		pis := stPIs(t, cus)
		if code != 200 || out["state"] != "succeeded" || s.owedCents(ctx, uid) != 0 || len(pis) != 1 ||
			pis[0].PaymentMethodConfigurationDetails == nil || pis[0].PaymentMethodConfigurationDetails.ID != s.Cfg.StripePMCWeb ||
			pis[0].Currency != "usd" {
			t.Fatalf("%d %v PIs %d", code, out, len(pis))
		}
	})
	t.Run("3184-bank-check", func(t *testing.T) {
		uid, cus, _ := stCustomer(t, s, "onetap-settle-3184", "pm_card_authenticationRequired")
		stPaidBefore(t, s, uid)
		stOwedRun(t, s, uid, 1500)
		code, out := tapSettle(t, s, uid, 1500)
		if code != 200 || out["state"] != "requires_action" {
			t.Fatalf("%d %v", code, out["state"])
		}
		sid, _ := out["settle_id"].(string)
		st, _ := s.Store.GetSettle(ctx, sid)
		piID := st.CurrentPayment.ID
		stPassBankCheck(t, piID)
		for range 2 {
			s.handleSettlePI(ctx, httptest.NewRecorder(), "payment_intent.succeeded", sid, piID, "succeeded", 1500)
		}
		st, _ = s.Store.GetSettle(ctx, sid)
		pis := stPIs(t, cus)
		if st.State != store.SettlePaid || s.owedCents(ctx, uid) != 0 || len(pis) != 1 || countStatus(pis, stripe.PaymentIntentStatusSucceeded) != 1 {
			t.Fatalf("settle %s owed %d PIs %d", st.State, s.owedCents(ctx, uid), len(pis))
		}
	})
}
