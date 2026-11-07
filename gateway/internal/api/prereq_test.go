package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stripe/stripe-go/v78/webhook"

	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// P3: one Idempotency-Key, one run id — per account and env.
func TestIdemConversionID(t *testing.T) {
	a := store.IdemConversionID("test", "u1", "key-1")
	if a != store.IdemConversionID("test", "u1", "key-1") || len(a) != 16 || a[0] != 'k' {
		t.Fatalf("not deterministic or bad shape: %q", a)
	}
	for _, other := range []string{store.IdemConversionID("test", "u2", "key-1"), store.IdemConversionID("prod", "u1", "key-1"), store.IdemConversionID("test", "u1", "key-2")} {
		if other == a {
			t.Errorf("collision: %q", other)
		}
	}
	s := &Service{Cfg: &config.Config{Env: "test"}}
	if s.idempotentConversionID("u1", "key-1") != a || s.idempotentConversionID("u1", "") == s.idempotentConversionID("u1", "") {
		t.Error("idempotentConversionID")
	}
}

// P4: the suffix fits the account prefix ("SPATIAL AI* " + suffix ≤ 22).
func TestDescriptorSuffix(t *testing.T) {
	for _, web := range []bool{true, false} {
		if n := len("SPATIAL AI* " + stripex.DescriptorSuffix(web)); n > 22 {
			t.Errorf("web=%v: %d characters", web, n)
		}
	}
}

// P1: a PaymentIntent event acts only on the run's current PaymentIntent.
func TestCurrentPI(t *testing.T) {
	c := &store.Conversion{Stripe: store.Stripe{PaymentIntentID: "pi_a"}}
	if !currentPI(c, "pi_a") || currentPI(c, "pi_b") {
		t.Error("current PI")
	}
	charging := &store.Conversion{Stripe: store.Stripe{PIStatus: store.PICharging}}
	if !currentPI(charging, "pi_x") {
		t.Error("a charging record (its request died) adopts its keyed PI")
	}
	if currentPI(&store.Conversion{Stripe: store.Stripe{PIStatus: store.PISucceeded}}, "pi_x") {
		t.Error("a settled record without a PI must not adopt one")
	}
}

// P2: processing is never paid.
func TestProcessingIsNotPaid(t *testing.T) {
	c := &store.Conversion{State: store.StateCreated, Quote: store.Quote{AmountCents: 3000},
		Stripe: store.Stripe{Mode: store.BillingModeAutoPrecharge, PIStatus: store.PIProcessing}}
	if got := paymentStatus(c); got != "processing" {
		t.Errorf("payment status %q", got)
	}
	if b := prechargeBilling(c); b["status"] != "waiting_for_payment" {
		t.Errorf("billing %v", b)
	}
}

// P1: events on objects other than PaymentIntents are received and left
// alone (the account is shared); no store access happens.
func TestWebhookRoutesByObjectType(t *testing.T) {
	const secret = "whsec_test"
	s := &Service{Cfg: &config.Config{Env: "test"}, Stripe: stripex.New("sk_test_x", secret, "pk", "test")}
	for _, body := range []string{
		`{"id":"evt_1","object":"event","type":"checkout.session.completed","api_version":"2024-04-10","data":{"object":{"id":"cs_1","object":"checkout.session","metadata":{}}}}`,
		`{"id":"evt_2","object":"event","type":"charge.refunded","api_version":"2024-04-10","data":{"object":{"id":"ch_1","object":"charge"}}}`,
		`{"id":"evt_3","object":"event","type":"payment_intent.succeeded","api_version":"2024-04-10","data":{"object":{"id":"pi_1","object":"payment_intent","metadata":{"env":"prod","conversion_id":"x"}}}}`,
	} {
		signed := webhook.GenerateTestSignedPayload(&webhook.UnsignedPayload{Payload: []byte(body), Secret: secret})
		req := httptest.NewRequest(http.MethodPost, "/webhooks/stripe", strings.NewReader(body))
		req.Header.Set("Stripe-Signature", signed.Header)
		rec := httptest.NewRecorder()
		s.HandleStripeWebhook(rec, req)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "received") {
			t.Errorf("%s: %d %s", body[:60], rec.Code, rec.Body.String())
		}
	}
}
