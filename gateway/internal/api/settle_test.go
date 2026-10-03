package api

import (
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func conversion(mode, pi string, cents int64) *store.Conversion {
	c := &store.Conversion{}
	c.Stripe.Mode = mode
	c.Stripe.PaymentIntentID = pi
	c.Quote.AmountCents = cents
	return c
}

// A free run (no Stripe state at all) owes nothing once it succeeds; it was
// marked capture_pending and the sweep captured "" every minute (2026-10-03).
func TestSettlementAfterSuccess(t *testing.T) {
	cases := []struct {
		name string
		c    *store.Conversion
		want string
	}{
		{"free daily image", conversion("", "", 0), ""},
		{"held on a PaymentIntent", conversion("", "pi_123", 500), store.PICapturePending},
		{"auto-billed", conversion(store.BillingModeAuto, "", 500), store.PIChargePending},
		{"auto-billed with an old PI", conversion(store.BillingModeAuto, "pi_123", 500), store.PIChargePending},
	}
	for _, tc := range cases {
		if got := settlementAfterSuccess(tc.c); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestCaptureDecision(t *testing.T) {
	if got := captureDecision(conversion("", "", 0)); got != captureNothing {
		t.Errorf("free run: got %d, want captureNothing", got)
	}
	if got := captureDecision(conversion("", "", 500)); got != captureLost {
		t.Errorf("priced without a PI: got %d, want captureLost", got)
	}
	if got := captureDecision(conversion("", "pi_123", 500)); got != captureStripe {
		t.Errorf("held: got %d, want captureStripe", got)
	}
}
