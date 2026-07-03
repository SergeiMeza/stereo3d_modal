package stripex

import (
	"errors"
	"testing"

	"github.com/stripe/stripe-go/v78"
)

// ClassifyChargeError drives the settlement state machine: NeedsAction and
// hard declines make the account delinquent (blocks paid steps), Transient
// stays charge_pending for the reconciler. Misclassifying a decline as
// transient would retry a dead card forever and never surface the failure.
func TestClassifyChargeErrorAuthenticationRequired(t *testing.T) {
	err := &stripe.Error{
		Code: stripe.ErrorCodeAuthenticationRequired,
		Type: stripe.ErrorTypeCard,
		Msg:  "authentication required",
		PaymentIntent: &stripe.PaymentIntent{
			ID: "pi_123",
		},
	}
	f := ClassifyChargeError(err)
	if !f.NeedsAction {
		t.Error("authentication_required must set NeedsAction (web 3DS fallback)")
	}
	if f.Transient {
		t.Error("authentication_required is a card decision, not transient")
	}
	if f.PaymentIntentID != "pi_123" {
		t.Errorf("PaymentIntentID = %q, want pi_123 (retries must confirm the same PI)", f.PaymentIntentID)
	}
}

func TestClassifyChargeErrorCardDeclined(t *testing.T) {
	err := &stripe.Error{
		Code: stripe.ErrorCodeCardDeclined,
		Type: stripe.ErrorTypeCard,
		Msg:  "Your card was declined.",
	}
	f := ClassifyChargeError(err)
	if f.Transient {
		t.Error("a card decline must NOT be transient — it needs the user")
	}
	if f.NeedsAction {
		t.Error("a plain decline is not a 3DS challenge")
	}
}

func TestClassifyChargeErrorAPIOutageIsTransient(t *testing.T) {
	err := &stripe.Error{
		Type: stripe.ErrorTypeAPI,
		Msg:  "An error occurred with our API.",
	}
	if f := ClassifyChargeError(err); !f.Transient {
		t.Error("a Stripe API error must be transient (reconciler retries)")
	}
}

func TestClassifyChargeErrorNonStripeIsTransient(t *testing.T) {
	if f := ClassifyChargeError(errors.New("dial tcp: i/o timeout")); !f.Transient {
		t.Error("network errors must be transient — never delinquent on infrastructure trouble")
	}
}
