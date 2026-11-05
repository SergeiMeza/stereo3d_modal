package stripex

import (
	"errors"
	"regexp"

	"github.com/stripe/stripe-go/v78"
)

// ErrFacts is what Stripe said about a failed call, safe to log: no ids
// (Stripe's message can name the customer, method or invoice; those are
// masked).
type ErrFacts struct {
	Status      int
	Type        string
	Code        string
	DeclineCode string
	Param       string
	Message     string
}

// RequiresAction: the card needs confirming (3-D Secure) before it pays.
func (f ErrFacts) RequiresAction() bool {
	return f.Code == "subscription_payment_intent_requires_action" || f.Code == "authentication_required" ||
		f.DeclineCode == "authentication_required"
}

// Declined: the card was refused (a decline, not a confirm).
func (f ErrFacts) Declined() bool {
	return !f.RequiresAction() && (f.Type == "card_error" || f.DeclineCode != "" || f.Code == "card_declined")
}

// LogArgs are slog key/values.
func (f ErrFacts) LogArgs() []any {
	return []any{"stripe_status", f.Status, "stripe_type", f.Type, "stripe_code", f.Code,
		"stripe_decline_code", f.DeclineCode, "stripe_param", f.Param, "stripe_message", f.Message}
}

var stripeIDs = regexp.MustCompile(`\b(cus|pm|card|src|sub|sub_sched|si|ii|in|pi|seti|ch|py|price|prod|cs|txn|re)_[A-Za-z0-9]{6,}`)

// FactsOf reads them from an error (only Message when it isn't Stripe's).
func FactsOf(err error) ErrFacts {
	if err == nil {
		return ErrFacts{}
	}
	var se *stripe.Error
	if !errors.As(err, &se) {
		return ErrFacts{Message: stripeIDs.ReplaceAllString(err.Error(), "${1}_…")}
	}
	return ErrFacts{Status: se.HTTPStatusCode, Type: string(se.Type), Code: string(se.Code),
		DeclineCode: string(se.DeclineCode), Param: se.Param, Message: stripeIDs.ReplaceAllString(se.Msg, "${1}_…")}
}
