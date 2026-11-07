package stripex

import (
	"errors"
	"strings"
	"testing"

	"github.com/stripe/stripe-go/v78"
)

// Under 2026-10-28.endive the update's billing_cycle_anchor is an object:
// the string form answers 400 "Invalid object" (the 2026-11-05 Business →
// Studio failure on test).
func TestChangePlanFormEndive(t *testing.T) {
	f := changePlanForm(PlanChange{SubscriptionID: "sub_1", ItemID: "si_1", PriceID: "price_s", Metadata: map[string]string{"plan": "studio"}})
	if _, old := f["billing_cycle_anchor"]; old {
		t.Fatal("string billing_cycle_anchor is refused under endive")
	}
	if f.Get("billing_cycle_anchor[type]") != "now" || f.Get("proration_behavior") != "none" ||
		f.Get("payment_behavior") != "error_if_incomplete" || f.Get("items[0][id]") != "si_1" ||
		f.Get("items[0][price]") != "price_s" || f.Get("metadata[plan]") != "studio" {
		t.Fatalf("form %v", f)
	}
}

func TestFactsOf(t *testing.T) {
	f := FactsOf(&stripe.Error{HTTPStatusCode: 402, Type: "card_error", Code: "card_declined", DeclineCode: "generic_decline",
		Msg: "Your card was declined."})
	if !f.Declined() || f.RequiresAction() || f.DeclineCode != "generic_decline" {
		t.Fatalf("%+v", f)
	}
	f = FactsOf(&stripe.Error{HTTPStatusCode: 402, Type: "card_error", Code: "subscription_payment_intent_requires_action"})
	if !f.RequiresAction() || f.Declined() {
		t.Fatalf("%+v", f)
	}
	f = FactsOf(&stripe.Error{HTTPStatusCode: 400, Type: "invalid_request_error", Code: "resource_missing",
		Msg: "No such customer: 'cus_ABC123def456'"})
	if strings.Contains(f.Message, "ABC123") || f.Param != "" || f.Declined() {
		t.Fatalf("ids must be masked: %+v", f)
	}
	if FactsOf(errors.New("dial tcp: timeout")).Status != 0 {
		t.Fatal("not Stripe's")
	}
}
