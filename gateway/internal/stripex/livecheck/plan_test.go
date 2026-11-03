package livecheck

import (
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Plans in TEST mode: the prices are found by lookup key and a
// subscription-mode session opens on the web PMC.
func TestPlanSessionInTestMode(t *testing.T) {
	key := os.Getenv("STRIPE_TEST_KEY")
	if !strings.HasPrefix(key, "sk_test_") {
		t.Skip("needs a TEST secret key")
	}
	c := stripex.New(key, "", "pk", "test")
	cus := rawStripe(t, key, "POST", "/v1/customers", url.Values{"name": {"Plan probe"}, "metadata[kind]": {"probe"}})
	cusID := cus["id"].(string)
	defer rawStripe(t, key, "DELETE", "/v1/customers/"+cusID, nil)
	for _, tier := range []string{"business", "studio"} {
		price, err := c.PriceByLookupKey("svs_web_" + tier + "_monthly")
		if err != nil || price == "" {
			t.Fatalf("%s price: %q %v", tier, price, err)
		}
		for _, ui := range []string{"elements", "hosted_page"} {
			s, err := c.CreatePlanSession(stripex.PlanSessionSpec{CustomerID: cusID, PMC: os.Getenv("PMC"), PriceID: price, UI: ui,
				ReturnURL: "https://www.stereo3d.studio/billing?plan=" + tier, Tier: tier, UID: "probe",
				IdemKey: "probe_plan_" + tier + ui + time.Now().Format("150405.000")})
			if err != nil {
				t.Fatalf("%s %s: %v", tier, ui, stripex.ErrMessage(err))
			}
			t.Logf("%s %s: %s secret=%v url=%v", tier, ui, s.ID, s.ClientSecret != "", s.URL != "")
			_, _ = c.ExpireCheckoutSession(s.ID)
		}
	}
}

// A plan subscription's PaymentIntent leads back to its invoice and
// subscription (refunds and disputes on plans, RevenueCat revokes).
func TestPlanPaymentLookupInTestMode(t *testing.T) {
	key := os.Getenv("STRIPE_TEST_KEY")
	if !strings.HasPrefix(key, "sk_test_") {
		t.Skip("needs a TEST secret key")
	}
	c := stripex.New(key, "", "pk", "test")
	price, err := c.PriceByLookupKey("svs_web_business_monthly")
	if err != nil {
		t.Fatal(err)
	}
	cus := rawStripe(t, key, "POST", "/v1/customers", url.Values{"name": {"Plan probe"}, "metadata[kind]": {"probe"},
		"payment_method": {"pm_card_visa"}, "invoice_settings[default_payment_method]": {"pm_card_visa"}})
	cusID := cus["id"].(string)
	defer rawStripe(t, key, "DELETE", "/v1/customers/"+cusID, nil)
	sub := rawStripe(t, key, "POST", "/v1/subscriptions", url.Values{"customer": {cusID}, "items[0][price]": {price},
		"metadata[product]": {"svs-web-probe"}, "metadata[env]": {"probe"}, "expand[]": {"latest_invoice"}})
	subID := sub["id"].(string)
	inv := sub["latest_invoice"].(map[string]any)
	pays := rawStripe(t, key, "GET", "/v1/invoice_payments?invoice="+inv["id"].(string), nil)
	data := pays["data"].([]any)
	if len(data) == 0 {
		t.Fatalf("no invoice payments: %v", pays)
	}
	pi := data[0].(map[string]any)["payment"].(map[string]any)["payment_intent"].(string)
	got, err := c.PlanPaymentOf(pi)
	if err != nil || got == nil || got.SubscriptionID != subID || got.InvoiceID != inv["id"] || got.AmountPaid <= 0 {
		t.Fatalf("lookup %+v %v (want %s)", got, stripex.ErrMessage(err), subID)
	}
	t.Logf("pi %s → invoice %s, subscription %s, paid %d", pi, got.InvoiceID, got.SubscriptionID, got.AmountPaid)
	if none, err := c.PlanPaymentOf("pi_does_not_exist"); none != nil {
		t.Fatalf("unknown pi: %+v %v", none, err)
	}
	rawStripe(t, key, "DELETE", "/v1/subscriptions/"+subID, nil)
}
