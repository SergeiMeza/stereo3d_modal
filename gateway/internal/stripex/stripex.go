// Package stripex wraps the Stripe SDK for the auth-then-capture flow.
//
// One PaymentIntent per conversion, capture_method=manual:
//   - hold at creation (app confirms via PaymentSheet / Apple Pay)
//   - capture the full quoted amount on job success
//   - cancel the hold on failure/cancel/expiry — user never charged
//
// Every PaymentIntent carries {conversion_id, user_id, env} metadata so the
// Stripe dashboard links straight back to the job record for support.
package stripex

import (
	"fmt"

	"github.com/stripe/stripe-go/v78"
	"github.com/stripe/stripe-go/v78/customer"
	"github.com/stripe/stripe-go/v78/ephemeralkey"
	"github.com/stripe/stripe-go/v78/paymentintent"
	"github.com/stripe/stripe-go/v78/webhook"
)

type Client struct {
	env             string
	webhookSecret   string
	PublishableKey  string
	// PaymentSheet pins a Stripe API version for the ephemeral key.
	ephemeralAPIVer string
}

func New(secretKey, webhookSecret, publishableKey, env string) *Client {
	stripe.Key = secretKey
	return &Client{
		env:             env,
		webhookSecret:   webhookSecret,
		PublishableKey:  publishableKey,
		ephemeralAPIVer: stripe.APIVersion,
	}
}

func (c *Client) EnsureCustomer(uid, email string) (string, error) {
	params := &stripe.CustomerParams{}
	if email != "" {
		params.Email = stripe.String(email)
	}
	params.AddMetadata("firebase_uid", uid)
	params.AddMetadata("env", c.env)
	cust, err := customer.New(params)
	if err != nil {
		return "", err
	}
	return cust.ID, nil
}

type PaymentSheet struct {
	PaymentIntentID     string `json:"-"`
	ClientSecret        string `json:"payment_intent_client_secret"`
	EphemeralKeySecret  string `json:"ephemeral_key_secret"`
	CustomerID          string `json:"customer_id"`
	PublishableKey      string `json:"publishable_key"`
}

// CreateHold creates the manual-capture PaymentIntent plus the ephemeral key
// the mobile PaymentSheet needs.
func (c *Client) CreateHold(customerID string, amountCents int64, currency, conversionID, uid string) (*PaymentSheet, error) {
	params := &stripe.PaymentIntentParams{
		Amount:        stripe.Int64(amountCents),
		Currency:      stripe.String(currency),
		Customer:      stripe.String(customerID),
		CaptureMethod: stripe.String(string(stripe.PaymentIntentCaptureMethodManual)),
		AutomaticPaymentMethods: &stripe.PaymentIntentAutomaticPaymentMethodsParams{
			Enabled: stripe.Bool(true),
		},
	}
	params.AddMetadata("conversion_id", conversionID)
	params.AddMetadata("user_id", uid)
	params.AddMetadata("env", c.env)
	// NO deterministic idempotency key: concurrent creates for the same
	// upload must get DISTINCT PIs, so a loser canceling its own hold can
	// never kill the winner's. App-level retry safety comes from the
	// Idempotency-Key header on POST /v1/conversions (Firestore lookup).

	pi, err := paymentintent.New(params)
	if err != nil {
		return nil, fmt.Errorf("create payment intent: %w", err)
	}
	return c.sheetFor(pi, customerID)
}

// PaymentSheetFor rebuilds PaymentSheet params for an existing hold — used
// when an Idempotency-Key replay must return the original conversion's
// payment material (the original response was lost in transit).
func (c *Client) PaymentSheetFor(customerID, paymentIntentID string) (*PaymentSheet, error) {
	pi, err := paymentintent.Get(paymentIntentID, nil)
	if err != nil {
		return nil, err
	}
	return c.sheetFor(pi, customerID)
}

func (c *Client) sheetFor(pi *stripe.PaymentIntent, customerID string) (*PaymentSheet, error) {
	ek, err := ephemeralkey.New(&stripe.EphemeralKeyParams{
		Customer:      stripe.String(customerID),
		StripeVersion: stripe.String(c.ephemeralAPIVer),
	})
	if err != nil {
		return nil, fmt.Errorf("create ephemeral key: %w", err)
	}
	return &PaymentSheet{
		PaymentIntentID:    pi.ID,
		ClientSecret:       pi.ClientSecret,
		EphemeralKeySecret: ek.Secret,
		CustomerID:         customerID,
		PublishableKey:     c.PublishableKey,
	}, nil
}

// IsTerminallyUncapturable reports whether the PI can never be captured
// (canceled — e.g. the 7-day authorization lapsed before capture). Used to
// stop the capture retry sweep. False on lookup errors (keep retrying).
func (c *Client) IsTerminallyUncapturable(paymentIntentID string) bool {
	pi, err := paymentintent.Get(paymentIntentID, nil)
	return err == nil && pi.Status == stripe.PaymentIntentStatusCanceled
}

// IsCaptured reports whether the PI already settled — a cancel can never
// succeed and the money needs a manual refund. False on lookup errors.
func (c *Client) IsCaptured(paymentIntentID string) bool {
	pi, err := paymentintent.Get(paymentIntentID, nil)
	return err == nil && pi.Status == stripe.PaymentIntentStatusSucceeded
}

// Capture settles the hold for the full authorized amount. Idempotent per PI.
func (c *Client) Capture(paymentIntentID string) (int64, error) {
	pi, err := paymentintent.Capture(paymentIntentID, &stripe.PaymentIntentCaptureParams{})
	if err != nil {
		// Already captured → treat as success (reconciler + GET can race).
		if stripeErrCode(err) == "payment_intent_unexpected_state" {
			if got, gerr := paymentintent.Get(paymentIntentID, nil); gerr == nil && got.Status == stripe.PaymentIntentStatusSucceeded {
				return got.AmountReceived, nil
			}
		}
		return 0, err
	}
	return pi.AmountReceived, nil
}

// CancelHold releases the hold. Safe to call on already-canceled intents.
func (c *Client) CancelHold(paymentIntentID string) error {
	_, err := paymentintent.Cancel(paymentIntentID, &stripe.PaymentIntentCancelParams{})
	if err != nil && stripeErrCode(err) == "payment_intent_unexpected_state" {
		if got, gerr := paymentintent.Get(paymentIntentID, nil); gerr == nil &&
			(got.Status == stripe.PaymentIntentStatusCanceled || got.Status == stripe.PaymentIntentStatusRequiresPaymentMethod) {
			return nil
		}
	}
	return err
}

// VerifyWebhook checks the Stripe signature and returns the event.
func (c *Client) VerifyWebhook(payload []byte, sigHeader string) (stripe.Event, error) {
	return webhook.ConstructEventWithOptions(payload, sigHeader, c.webhookSecret,
		webhook.ConstructEventOptions{IgnoreAPIVersionMismatch: true})
}

func stripeErrCode(err error) string {
	if serr, ok := err.(*stripe.Error); ok {
		return string(serr.Code)
	}
	return ""
}
