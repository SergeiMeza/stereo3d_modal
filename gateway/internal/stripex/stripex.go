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
//   - runs above the precharge threshold are charged BEFORE they start
//     (PrechargeSaved) and refunded in full if they fail (RefundOrCancel)
//
// Every PaymentIntent carries {conversion_id, user_id, env, description}
// metadata so the Stripe dashboard links straight back to the job record for
// support, plus a user-facing Description and receipt_email — Stripe emails
// the receipt automatically when the charge settles (live mode only; Stripe
// never sends receipts for test charges).
package stripex

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/stripe/stripe-go/v78"
	portalsession "github.com/stripe/stripe-go/v78/billingportal/session"
	"github.com/stripe/stripe-go/v78/customer"
	"github.com/stripe/stripe-go/v78/ephemeralkey"
	"github.com/stripe/stripe-go/v78/paymentintent"
	"github.com/stripe/stripe-go/v78/paymentmethod"
	"github.com/stripe/stripe-go/v78/refund"
	"github.com/stripe/stripe-go/v78/setupintent"
	"github.com/stripe/stripe-go/v78/webhook"
)

type Client struct {
	env            string
	webhookSecret  string
	PublishableKey string
	// PaymentSheet pins a Stripe API version for the ephemeral key.
	ephemeralAPIVer string
}

func New(secretKey, webhookSecret, publishableKey, env string) *Client {
	stripe.Key = secretKey
	// 15 s per call (stripe-go's own default is 80 s, plus retries): calls on
	// an app request must finish inside its 50 s budget, and a hung Stripe
	// call must not hold a reconcile sweep.
	stripe.SetBackend(stripe.APIBackend, stripe.GetBackendWithConfig(stripe.APIBackend, &stripe.BackendConfig{
		HTTPClient:        &http.Client{Timeout: 15 * time.Second},
		MaxNetworkRetries: stripe.Int64(1),
	}))
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

// Job ties a PaymentIntent to the conversion it pays for and to what the
// user sees for it.
type Job struct {
	// ConversionID stamps metadata.conversion_id (the webhook's routing
	// key). Empty for a batch charge, which routes on BatchID instead.
	ConversionID string
	BatchID      string
	UID          string
	// Description is user-facing: the Stripe dashboard payment row, the
	// emailed receipt, and the customer portal all show it. Also copied
	// into metadata so support sees the job type next to conversion_id.
	Description string
	// ReceiptEmail makes Stripe email a receipt when the charge settles.
	// Empty → no receipt email.
	ReceiptEmail string
	// Metadata: extra support-facing facts (configuration, source video,
	// reused stages — api.jobMetadata). Reserved keys (conversion_id,
	// user_id, env, description) are stamped separately and skipped here.
	Metadata map[string]string
}

// stamp applies the job's metadata, description, and receipt email to
// PaymentIntent create params.
func (c *Client) stamp(params *stripe.PaymentIntentParams, job Job) {
	if job.ConversionID != "" {
		params.AddMetadata("conversion_id", job.ConversionID)
	}
	if job.BatchID != "" {
		params.AddMetadata("batch_id", job.BatchID)
	}
	params.AddMetadata("user_id", job.UID)
	params.AddMetadata("env", c.env)
	if job.Description != "" {
		params.Description = stripe.String(job.Description)
		params.AddMetadata("description", job.Description)
	}
	if job.ReceiptEmail != "" {
		params.ReceiptEmail = stripe.String(job.ReceiptEmail)
	}
	for k, v := range job.Metadata {
		switch k {
		case "conversion_id", "batch_id", "user_id", "env", "description":
			continue // reserved — never let extras clobber the support keys
		}
		if v != "" {
			params.AddMetadata(k, v)
		}
	}
}

type PaymentSheet struct {
	PaymentIntentID    string `json:"-"`
	ClientSecret       string `json:"payment_intent_client_secret"`
	EphemeralKeySecret string `json:"ephemeral_key_secret"`
	CustomerID         string `json:"customer_id"`
	PublishableKey     string `json:"publishable_key"`
}

// CreateHold creates the manual-capture PaymentIntent plus the ephemeral key
// the mobile PaymentSheet needs.
func (c *Client) CreateHold(customerID string, amountCents int64, currency string, job Job) (*PaymentSheet, error) {
	params := &stripe.PaymentIntentParams{
		Amount:        stripe.Int64(amountCents),
		Currency:      stripe.String(currency),
		Customer:      stripe.String(customerID),
		CaptureMethod: stripe.String(string(stripe.PaymentIntentCaptureMethodManual)),
		AutomaticPaymentMethods: &stripe.PaymentIntentAutomaticPaymentMethodsParams{
			Enabled: stripe.Bool(true),
		},
	}
	c.stamp(params, job)
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
func (c *Client) CreateOffSessionHold(customerID, paymentMethodID string, amountCents int64, currency string, job Job) (*stripe.PaymentIntent, error) {
	params := &stripe.PaymentIntentParams{
		Amount:        stripe.Int64(amountCents),
		Currency:      stripe.String(currency),
		Customer:      stripe.String(customerID),
		PaymentMethod: stripe.String(paymentMethodID),
		Confirm:       stripe.Bool(true),
		OffSession:    stripe.Bool(true),
		CaptureMethod: stripe.String(string(stripe.PaymentIntentCaptureMethodManual)),
	}
	c.stamp(params, job)
	params.SetIdempotencyKey("hold_" + c.env + "_" + job.ConversionID)
	return paymentintent.New(params)
}

// ChargeSaved charges the saved payment method off-session (automatic
// capture) for a succeeded conversion. The deterministic idempotency key
// makes the create safe to retry after a crash — the same conversion can
// never mint two PaymentIntents.
func (c *Client) ChargeSaved(customerID, paymentMethodID string, amountCents int64, currency string, job Job) (*stripe.PaymentIntent, error) {
	params := &stripe.PaymentIntentParams{
		Amount:        stripe.Int64(amountCents),
		Currency:      stripe.String(currency),
		Customer:      stripe.String(customerID),
		PaymentMethod: stripe.String(paymentMethodID),
		Confirm:       stripe.Bool(true),
		OffSession:    stripe.Bool(true),
	}
	c.stamp(params, job)
	switch {
	case job.BatchID != "":
		params.SetIdempotencyKey("batch_" + c.env + "_" + job.BatchID)
	default:
		params.SetIdempotencyKey("charge_" + c.env + "_" + job.ConversionID)
	}
	return paymentintent.New(params)
}

// PrechargeSaved charges the saved payment method off-session (automatic
// capture) BEFORE an expensive run is submitted. Same shape as ChargeSaved
// with its own idempotency key: one up-front charge per conversion, ever,
// and never confused with a post-success charge.
func (c *Client) PrechargeSaved(customerID, paymentMethodID string, amountCents int64, currency string, job Job) (*stripe.PaymentIntent, error) {
	params := &stripe.PaymentIntentParams{
		Amount:        stripe.Int64(amountCents),
		Currency:      stripe.String(currency),
		Customer:      stripe.String(customerID),
		PaymentMethod: stripe.String(paymentMethodID),
		Confirm:       stripe.Bool(true),
		OffSession:    stripe.Bool(true),
	}
	c.stamp(params, job)
	params.SetIdempotencyKey("precharge_" + c.env + "_" + job.ConversionID)
	return paymentintent.New(params)
}

// RefundOrCancel gives a pre-charged run's money back: a settled
// PaymentIntent is refunded in full (refunded = the amount), one never
// confirmed (3DS abandoned) is canceled (refunded = 0). Idempotent: the
// refund carries a key per PaymentIntent, and an already-refunded or
// canceled intent is success. refused reports a Stripe decision a retry
// can't change (a disputed charge, say) — the caller flags it for a manual
// refund instead of retrying forever.
func (c *Client) RefundOrCancel(paymentIntentID string) (refunded int64, refused bool, err error) {
	pi, err := paymentintent.Get(paymentIntentID, nil)
	if err != nil {
		return 0, false, fmt.Errorf("get payment intent: %w", err)
	}
	switch pi.Status {
	case stripe.PaymentIntentStatusCanceled:
		return 0, false, nil
	case stripe.PaymentIntentStatusSucceeded:
		if pi.LatestCharge != nil && pi.LatestCharge.Refunded {
			return pi.AmountReceived, false, nil
		}
		params := &stripe.RefundParams{PaymentIntent: stripe.String(paymentIntentID)}
		params.AddMetadata("env", c.env)
		params.SetIdempotencyKey("refund_" + c.env + "_" + paymentIntentID)
		r, rerr := refund.New(params)
		if rerr != nil {
			if stripeErrCode(rerr) == "charge_already_refunded" {
				return pi.AmountReceived, false, nil
			}
			var serr *stripe.Error
			refused = errors.As(rerr, &serr) && serr.Type == stripe.ErrorTypeInvalidRequest
			return 0, refused, fmt.Errorf("refund: %w", rerr)
		}
		return r.Amount, false, nil
	case stripe.PaymentIntentStatusProcessing:
		// Can't be refunded until it settles; the sweep retries.
		return 0, false, errors.New("payment intent still processing")
	}
	if cerr := c.CancelHold(paymentIntentID); cerr != nil {
		return 0, false, cerr
	}
	return 0, false, nil
}

// ConfirmSavedCharge retries an existing charge PaymentIntent (decline or
// 3DS follow-up) against the customer's CURRENT default payment method —
// one PI per conversion, however many attempts it takes. receiptEmail
// backfills the receipt recipient on PIs created before receipts existed.
func (c *Client) ConfirmSavedCharge(paymentIntentID, paymentMethodID, receiptEmail string) (*stripe.PaymentIntent, error) {
	params := &stripe.PaymentIntentConfirmParams{OffSession: stripe.Bool(true)}
	if paymentMethodID != "" {
		params.PaymentMethod = stripe.String(paymentMethodID)
	}
	if receiptEmail != "" {
		params.ReceiptEmail = stripe.String(receiptEmail)
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

// ChargeInfo is what a statement line shows for a PaymentIntent's charge
// (the billing history, S3D-57).
type ChargeInfo struct {
	ReceiptURL     string
	CardBrand      string
	CardLast4      string
	AmountRefunded int64
}

// ChargeDetails reads the PaymentIntent's latest charge: receipt link and
// the card it went on. Empty info (no error) when the PI has no charge.
func (c *Client) ChargeDetails(paymentIntentID string) (*ChargeInfo, error) {
	params := &stripe.PaymentIntentParams{}
	params.AddExpand("latest_charge")
	pi, err := paymentintent.Get(paymentIntentID, params)
	if err != nil {
		return nil, err
	}
	info := &ChargeInfo{}
	ch := pi.LatestCharge
	if ch == nil {
		return info, nil
	}
	info.ReceiptURL = ch.ReceiptURL
	info.AmountRefunded = ch.AmountRefunded
	if d := ch.PaymentMethodDetails; d != nil && d.Card != nil {
		info.CardBrand = string(d.Card.Brand)
		info.CardLast4 = d.Card.Last4
	}
	return info, nil
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
