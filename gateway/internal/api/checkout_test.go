package api

import (
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

func TestPayNowBilling(t *testing.T) {
	exp := time.Date(2026, 11, 3, 13, 0, 0, 0, time.UTC)
	c := &store.Conversion{State: store.StateCreated, PaymentFlow: store.FlowPayNow, PayReason: "declined",
		DeclinedMethodLabel: "Visa •••• 4242",
		CurrentPayment: &store.Payment{Kind: store.PaymentCheckoutSession, ID: "cs_1", UI: "elements", ClientSecret: "cs_secret", ExpiresAt: &exp}}
	b := payNowBilling(c)
	ch, _ := b["checkout"].(map[string]any)
	if b["status"] != "requires_payment" || b["reason"] != "declined" || b["declined_method_label"] != "Visa •••• 4242" ||
		ch["client_secret"] != "cs_secret" || ch["expires_at"] != "2026-11-03T13:00:00Z" {
		t.Errorf("billing %v", b)
	}
	c.Stripe.PIStatus = store.PIProcessing
	if payNowBilling(c)["status"] != "waiting_for_payment" {
		t.Error("processing")
	}
	if payNowBilling(&store.Conversion{State: store.StatePaid, PaymentFlow: store.FlowPayNow}) != nil {
		t.Error("paid run has no sheet block")
	}
	if err := runPayable(&store.Conversion{State: store.StateSucceeded}); err == nil {
		t.Error("succeeded run payable")
	}
}

func TestMethodLabelsAndOrder(t *testing.T) {
	for _, tc := range []struct {
		m    stripex.CardInfo
		want string
	}{
		{stripex.CardInfo{Type: "card", Brand: "visa", Last4: "4242"}, "Visa •••• 4242"},
		{stripex.CardInfo{Type: "card", Brand: "visa", Last4: "4242", Wallet: "apple_pay"}, "Apple Pay · Visa •••• 4242"},
		{stripex.CardInfo{Type: "paypal", Email: "jane@gmail.com"}, "PayPal · j•••@gmail.com"},
		{stripex.CardInfo{Type: "link"}, "Link"},
	} {
		if got := methodLabel(&tc.m); got != tc.want {
			t.Errorf("%+v: %q", tc.m, got)
		}
	}
	ms := []*stripex.CardInfo{{PaymentMethodID: "a", Created: 1}, {PaymentMethodID: "b", Created: 2}, {PaymentMethodID: "c", Created: 3}, {PaymentMethodID: "d", Created: 4}}
	got := orderMethods(ms, "c", []string{"d", "a"})
	ids := ""
	for _, m := range got {
		ids += m.PaymentMethodID
	}
	if ids != "cdab" {
		t.Errorf("order %s, want default first, then backup order, then by age", ids)
	}
}
