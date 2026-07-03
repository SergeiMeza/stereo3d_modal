// Package stripex wraps the Stripe SDK for the gateway's two billing modes.
//
// Legacy mobile flow (POST /v1/conversions) — auth-then-capture:
//   - one manual-capture PaymentIntent per conversion, held at creation
//     (app confirms via PaymentSheet / Apple Pay)
//   - capture the full quoted amount on job success
//   - cancel the hold on failure/cancel/expiry — user never charged
//
// Pro step flow (web) — pay-as-you-go with a saved card:
//   - onboarding saves a default payment method via a SetupIntent
//   - nothing is held up front; on job success the quoted amount is charged
//     off-session against the saved card (one PaymentIntent per conversion,
//     deterministic idempotency key so a crash-retry can never double-charge)
//
// Every PaymentIntent carries {conversion_id, user_id, env} metadata so the
// Stripe dashboard links straight back to the job record for support.
package stripex

import (
	"errors"
	"fmt"

	"github.com/stripe/stripe-go/v78"
	portalsession "github.com/stripe/stripe-go/v78/billingportal/session"
	"github.com/stripe/stripe-go/v78/customer"
	"github.com/stripe/stripe-go/v78/ephemeralkey"
	"github.com/stripe/stripe-go/v78/paymentintent"
	"github.com/stripe/stripe-go/v78/paymentmethod"
	"github.com/stripe/stripe-go/v78/setupintent"
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

// BillingPortalURL creates a Stripe customer-portal session — the hosted
// page where the user manages saved payment methods and sees receipts. The
// portal sends the user back to returnURL when they're done.
func (c *Client) BillingPortalURL(customerID, returnURL string) (string, error) {
	s, err := portalsession.New(&stripe.BillingPortalSessionParams{
		Customer:  stripe.String(customerID),
		ReturnURL: stripe.String(returnURL),
	})
	if err != nil {
		return "", fmt.Errorf("create billing portal session: %w", err)
	}
	return s.URL, nil
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

// ------------------------------------------------------- pay-as-you-go

// SetupSheet is what the web onboarding page needs to save a card.
type SetupSheet struct {
	ClientSecret   string `json:"client_secret"`
	CustomerID     string `json:"customer_id"`
	PublishableKey string `json:"publishable_key"`
}

// CreateSetupIntent starts saving a payment method for off-session charges
// (the onboarding flow). Card only: every off-session charge and the 3DS
// fallback assume a card-shaped payment method (wallets tokenize as cards).
func (c *Client) CreateSetupIntent(customerID, uid string) (*SetupSheet, error) {
	params := &stripe.SetupIntentParams{
		Customer:           stripe.String(customerID),
		Usage:              stripe.String(string(stripe.SetupIntentUsageOffSession)),
		PaymentMethodTypes: stripe.StringSlice([]string{"card"}),
	}
	params.AddMetadata("firebase_uid", uid)
	params.AddMetadata("env", c.env)
	si, err := setupintent.New(params)
	if err != nil {
		return nil, fmt.Errorf("create setup intent: %w", err)
	}
	return &SetupSheet{
		ClientSecret:   si.ClientSecret,
		CustomerID:     customerID,
		PublishableKey: c.PublishableKey,
	}, nil
}

// CardInfo describes the customer's default (chargeable) payment method.
type CardInfo struct {
	PaymentMethodID string
	Brand           string
	Last4           string
	ExpMonth        int64
	ExpYear         int64
}

// DefaultCard resolves the customer's default payment method, promoting the
// newest saved card to default when none is set (a SetupIntent attaches the
// card but does not make it the default — this read-through heals that, and
// also picks up cards added or removed in the billing portal). nil, nil when
// the customer has no saved card.
func (c *Client) DefaultCard(customerID string) (*CardInfo, error) {
	cust, err := customer.Get(customerID, &stripe.CustomerParams{
		Params: stripe.Params{Expand: []*string{stripe.String("invoice_settings.default_payment_method")}},
	})
	if err != nil {
		return nil, fmt.Errorf("get customer: %w", err)
	}
	if pm := cust.InvoiceSettings.DefaultPaymentMethod; pm != nil && pm.Card != nil {
		return cardInfo(pm), nil
	}
	iter := paymentmethod.List(&stripe.PaymentMethodListParams{
		Customer: stripe.String(customerID),
		Type:     stripe.String(string(stripe.PaymentMethodTypeCard)),
	})
	if !iter.Next() { // newest first — the card just saved by onboarding
		return nil, iter.Err()
	}
	pm := iter.PaymentMethod()
	if _, err := customer.Update(customerID, &stripe.CustomerParams{
		InvoiceSettings: &stripe.CustomerInvoiceSettingsParams{
			DefaultPaymentMethod: stripe.String(pm.ID),
		},
	}); err != nil {
		return nil, fmt.Errorf("promote default payment method: %w", err)
	}
	return cardInfo(pm), nil
}

func cardInfo(pm *stripe.PaymentMethod) *CardInfo {
	info := &CardInfo{PaymentMethodID: pm.ID}
	if pm.Card != nil {
		info.Brand = string(pm.Card.Brand)
		info.Last4 = pm.Card.Last4
		info.ExpMonth = pm.Card.ExpMonth
		info.ExpYear = pm.Card.ExpYear
	}
	return info
}

// CreateOffSessionHold places a manual-capture hold on the saved payment
// method with no client interaction (the auto_hold mode for expensive
// runs): the bank re-approves the quote BEFORE the job runs, and success
// captures this same PI. A 3DS demand surfaces as authentication_required
// with the PI attached — the web client completes it via confirmCardPayment
// and the amount_capturable_updated webhook takes over. Deterministic
// idempotency key: one hold per conversion, ever.
func (c *Client) CreateOffSessionHold(customerID, paymentMethodID string, amountCents int64, currency, conversionID, uid string) (*stripe.PaymentIntent, error) {
	params := &stripe.PaymentIntentParams{
		Amount:        stripe.Int64(amountCents),
		Currency:      stripe.String(currency),
		Customer:      stripe.String(customerID),
		PaymentMethod: stripe.String(paymentMethodID),
		Confirm:       stripe.Bool(true),
		OffSession:    stripe.Bool(true),
		CaptureMethod: stripe.String(string(stripe.PaymentIntentCaptureMethodManual)),
	}
	params.AddMetadata("conversion_id", conversionID)
	params.AddMetadata("user_id", uid)
	params.AddMetadata("env", c.env)
	params.SetIdempotencyKey("hold_" + c.env + "_" + conversionID)
	return paymentintent.New(params)
}

// ChargeSaved charges the saved payment method off-session (automatic
// capture) for a succeeded conversion. The deterministic idempotency key
// makes the create safe to retry after a crash — the same conversion can
// never mint two PaymentIntents.
func (c *Client) ChargeSaved(customerID, paymentMethodID string, amountCents int64, currency, conversionID, uid string) (*stripe.PaymentIntent, error) {
	params := &stripe.PaymentIntentParams{
		Amount:        stripe.Int64(amountCents),
		Currency:      stripe.String(currency),
		Customer:      stripe.String(customerID),
		PaymentMethod: stripe.String(paymentMethodID),
		Confirm:       stripe.Bool(true),
		OffSession:    stripe.Bool(true),
	}
	params.AddMetadata("conversion_id", conversionID)
	params.AddMetadata("user_id", uid)
	params.AddMetadata("env", c.env)
	params.SetIdempotencyKey("charge_" + c.env + "_" + conversionID)
	return paymentintent.New(params)
}

// ConfirmSavedCharge retries an existing charge PaymentIntent (decline or
// 3DS follow-up) against the customer's CURRENT default payment method —
// one PI per conversion, however many attempts it takes.
func (c *Client) ConfirmSavedCharge(paymentIntentID, paymentMethodID string) (*stripe.PaymentIntent, error) {
	params := &stripe.PaymentIntentConfirmParams{OffSession: stripe.Bool(true)}
	if paymentMethodID != "" {
		params.PaymentMethod = stripe.String(paymentMethodID)
	}
	pi, err := paymentintent.Confirm(paymentIntentID, params)
	if err != nil && stripeErrCode(err) == "payment_intent_unexpected_state" {
		// Already settled (webhook or a concurrent sweep won the race).
		if got, gerr := paymentintent.Get(paymentIntentID, nil); gerr == nil && got.Status == stripe.PaymentIntentStatusSucceeded {
			return got, nil
		}
	}
	return pi, err
}

// GetPaymentIntent fetches a PI (client_secret for the web 3DS fallback,
// status probes).
func (c *Client) GetPaymentIntent(id string) (*stripe.PaymentIntent, error) {
	return paymentintent.Get(id, nil)
}

// ChargeFailure classifies a failed off-session charge for the settlement
// state machine.
type ChargeFailure struct {
	// PaymentIntentID is set when Stripe minted (or kept) a PI for the
	// attempt — retries must Confirm it rather than create a new one.
	PaymentIntentID string
	Code            string
	// NeedsAction: the bank wants 3DS — the web client can complete it
	// on-session with the saved card (confirmCardPayment fallback).
	NeedsAction bool
	// Transient: infrastructure trouble, not a card decision — safe for the
	// reconciler to retry automatically without involving the user.
	Transient bool
	Message   string
}

// ClassifyChargeError maps a Stripe error from ChargeSaved/ConfirmSavedCharge
// onto the retry policy. Unknown errors default to transient (retry) — a
// user should only be marked delinquent on an explicit card decision.
func ClassifyChargeError(err error) ChargeFailure {
	var serr *stripe.Error
	if !errors.As(err, &serr) {
		return ChargeFailure{Transient: true, Message: err.Error()}
	}
	f := ChargeFailure{Code: string(serr.Code), Message: serr.Msg}
	if serr.PaymentIntent != nil {
		f.PaymentIntentID = serr.PaymentIntent.ID
	}
	switch {
	case serr.Code == stripe.ErrorCodeAuthenticationRequired:
		f.NeedsAction = true
	case serr.Type == stripe.ErrorTypeCard, serr.Type == stripe.ErrorTypeInvalidRequest:
		// decline / unusable payment method — needs the user
	default:
		f.Transient = true
	}
	return f
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
