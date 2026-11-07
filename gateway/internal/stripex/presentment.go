package stripex

import (
	"net/http"
	"net/url"
	"strings"
)

// Presentment is what a customer saw and paid when Stripe presented one of
// our USD amounts in their own currency (Adaptive Pricing, owner
// 2026-11-07). The PaymentIntent, its charge and our ledger stay USD;
// this is only the customer's side of it. AmountMinor is in the
// currency's smallest unit (yen and won have none below 1).
type Presentment struct {
	AmountMinor int64
	Currency    string // lowercase ISO code, as Stripe sends it
}

// presentmentDetails is Stripe's presentment_details (Checkout Session,
// PaymentIntent, Charge and Refund carry the same shape).
type presentmentDetails struct {
	PresentmentAmount   int64  `json:"presentment_amount"`
	PresentmentCurrency string `json:"presentment_currency"`
}

// value is the presentment, or nil when there is none, it is incomplete,
// or it is the integration currency itself (a USD customer).
func (d *presentmentDetails) value(integration string) *Presentment {
	if d == nil || d.PresentmentAmount <= 0 {
		return nil
	}
	cur := strings.ToLower(strings.TrimSpace(d.PresentmentCurrency))
	if cur == "" || cur == strings.ToLower(USD(integration)) {
		return nil
	}
	return &Presentment{AmountMinor: d.PresentmentAmount, Currency: cur}
}

// PaymentPresentment reads a PaymentIntent's presentment at WebAPIVersion
// (the webhook endpoint's older version doesn't carry it); nil when it was
// charged in USD.
func (c *Client) PaymentPresentment(piID string) (*Presentment, error) {
	var pi struct {
		Currency           string              `json:"currency"`
		PresentmentDetails *presentmentDetails `json:"presentment_details"`
	}
	if err := webCall(http.MethodGet, "/v1/payment_intents/"+url.PathEscape(piID), nil, "", &pi); err != nil {
		return nil, err
	}
	return pi.PresentmentDetails.value(pi.Currency), nil
}
