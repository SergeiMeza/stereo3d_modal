package api

import (
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The downloads payment gate: a succeeded conversion whose automatic charge
// FAILED must not hand out signed URLs (402 billing_overdue, the settle
// flow's machine code); every ordinary post-success payment state — and
// legacy conversions with no payment intent at all — stays downloadable.
func TestDownloadPaymentGate(t *testing.T) {
	conv := func(pi string) *store.Conversion {
		return &store.Conversion{State: store.StateSucceeded, Stripe: store.Stripe{PIStatus: pi}}
	}
	for _, pi := range []string{store.PIChargeFailed, store.PICaptureFailed} {
		if err := downloadPaymentGate(conv(pi)); err == nil {
			t.Fatalf("pi_status %q must block downloads", pi)
		} else if err.Code != "billing_overdue" || err.Status != 402 {
			t.Fatalf("want 402 billing_overdue, got %d %s", err.Status, err.Code)
		}
	}
	for _, pi := range []string{"", store.PISucceeded, store.PICapturePending, store.PIChargePending} {
		if err := downloadPaymentGate(conv(pi)); err != nil {
			t.Fatalf("pi_status %q must stay downloadable, got %v", pi, err)
		}
	}
}
