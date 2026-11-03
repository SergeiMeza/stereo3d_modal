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
