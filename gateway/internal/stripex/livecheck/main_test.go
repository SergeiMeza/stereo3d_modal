package livecheck

import (
	"os"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Runs only with STRIPE_TEST_KEY (a sk_test_ key): builds the gateway's
// own Checkout Sessions against Stripe TEST mode.
func TestWebSessionsInTestMode(t *testing.T) {
	key := os.Getenv("STRIPE_TEST_KEY")
	if !strings.HasPrefix(key, "sk_test_") && !strings.HasPrefix(key, "rk_test_") {
		t.Skip("needs a TEST key")
	}
	c := stripex.New(key, "", "pk", "test")
	for _, ui := range []string{"elements", "hosted_page"} {
		for _, noWeChat := range []bool{false, true} {
			s, err := c.CreateWebSession(stripex.SessionSpec{
				CustomerID: os.Getenv("PROBE_CUSTOMER"), PMC: os.Getenv("PMC"), UI: ui,
				AmountCents: 4972, Currency: "usd", Label: "Kyoto walk · 3D video · 4K",
				ReturnURL: "https://www.stereo3d.studio/pay/return?c=probe", NoWeChat: noWeChat, NoKlarna: true,
				SaveMethod: true, ReceiptEmail: "probe-us@example.com", Description: "3D video",
				Metadata: map[string]string{"kind": "probe", "conversion_id": "probe"},
				IdemKey:  "probe_" + ui + "_" + time.Now().Format("150405.000"),
			})
			if err != nil {
				t.Fatalf("%s: %v", ui, stripex.ErrMessage(err))
			}
			t.Logf("%s noWeChat=%v: %s status=%s secret=%v url=%v expires_in=%s", ui, noWeChat, s.ID, s.Status,
				s.ClientSecret != "", s.URL != "", time.Until(s.Expires()).Round(time.Minute))
			if _, err := c.ExpireCheckoutSession(s.ID); err != nil {
				t.Errorf("expire: %v", err)
			}
			out, err := c.CloseCheckoutSession(s.ID)
			if err != nil || out.Paid {
				t.Errorf("close after expire: %+v %v", out, err)
			}
		}
	}
	setup, err := c.CreateSetupSession(os.Getenv("PROBE_CUSTOMER"), os.Getenv("PMC"), "https://www.stereo3d.studio/billing", map[string]string{"kind": "probe"}, "probe_setup_"+time.Now().Format("150405.000"))
	if err != nil {
		t.Fatalf("setup: %v", stripex.ErrMessage(err))
	}
	t.Logf("setup session %s secret=%v", setup.ID, setup.ClientSecret != "")
	_, _ = c.ExpireCheckoutSession(setup.ID)
}
