package stripex

import (
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Web plans (Business, Studio; pricing 2026-11): Stripe Billing
// subscriptions on the web's own products, bought through a
// subscription-mode Checkout Session on the web PMC. Prices are found by
// lookup key (svs_web_{tier}_monthly), so test and live each carry their
// own.

// PriceByLookupKey returns the price id for a lookup key ("" if none).
func (c *Client) PriceByLookupKey(key string) (string, error) {
	var page struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := webCall(http.MethodGet, "/v1/prices?lookup_keys[]="+url.QueryEscape(key)+"&active=true", nil, "", &page); err != nil {
		return "", err
	}
	if len(page.Data) == 0 {
		return "", nil
	}
	return page.Data[0].ID, nil
}

// PlanSessionSpec is one plan purchase.
type PlanSessionSpec struct {
	CustomerID string
	PMC        string
	PriceID    string
	UI         string // elements | hosted_page
	ReturnURL  string
	Tier       string
	UID        string
	IdemKey    string
}

// CreatePlanSession opens a subscription-mode Checkout Session.
func (c *Client) CreatePlanSession(spec PlanSessionSpec) (*Session, error) {
	f := url.Values{}
	f.Set("mode", "subscription")
	f.Set("ui_mode", spec.UI)
	f.Set("customer", spec.CustomerID)
	f.Set("line_items[0][price]", spec.PriceID)
	f.Set("line_items[0][quantity]", "1")
	if spec.PMC != "" {
		f.Set("payment_method_configuration", spec.PMC)
	}
	f.Set("tax_id_collection[enabled]", "true")
	f.Set("customer_update[name]", "auto")
	f.Set("customer_update[address]", "auto")
	f.Set("billing_address_collection", "auto")
	f.Set("expires_at", strconv.FormatInt(time.Now().Add(31*time.Minute).Unix(), 10))
	if spec.UI == "hosted_page" {
		f.Set("success_url", spec.ReturnURL)
		f.Set("cancel_url", spec.ReturnURL+"&canceled=1")
	} else {
		f.Set("return_url", spec.ReturnURL)
	}
	md := map[string]string{"env": c.env, "product": "svs-web", "kind": "plan", "plan": spec.Tier, "user_id": spec.UID}
	for k, v := range md {
		f.Set("metadata["+k+"]", v)
		f.Set("subscription_data[metadata]["+k+"]", v)
	}
	return c.CreateCheckoutSession(f, spec.IdemKey)
}

// Subscription is the part of a subscription the gateway mirrors.
type Subscription struct {
	ID                 string            `json:"id"`
	Status             string            `json:"status"`
	Customer           string            `json:"customer"`
	CancelAtPeriodEnd  bool              `json:"cancel_at_period_end"`
	Metadata           map[string]string `json:"metadata"`
	CurrentPeriodStart int64             `json:"current_period_start"`
	CurrentPeriodEnd   int64             `json:"current_period_end"`
	Items              struct {
		Data []struct {
			CurrentPeriodStart int64 `json:"current_period_start"`
			CurrentPeriodEnd   int64 `json:"current_period_end"`
			Price              struct {
				ID        string `json:"id"`
				LookupKey string `json:"lookup_key"`
			} `json:"price"`
		} `json:"data"`
	} `json:"items"`
}

// Period is the subscription's current period (newer API versions carry
// it on the item).
func (s *Subscription) Period() (start, end time.Time) {
	a, b := s.CurrentPeriodStart, s.CurrentPeriodEnd
	if (a == 0 || b == 0) && len(s.Items.Data) > 0 {
		a, b = s.Items.Data[0].CurrentPeriodStart, s.Items.Data[0].CurrentPeriodEnd
	}
	return time.Unix(a, 0).UTC(), time.Unix(b, 0).UTC()
}

// GetSubscription reads a subscription.
func (c *Client) GetSubscription(id string) (*Subscription, error) {
	var sub Subscription
	if err := webCall(http.MethodGet, "/v1/subscriptions/"+url.PathEscape(id), nil, "", &sub); err != nil {
		return nil, err
	}
	return &sub, nil
}

// SetCancelAtPeriodEnd cancels (or resumes) a subscription at its period
// end.
func (c *Client) SetCancelAtPeriodEnd(id string, cancel bool) (*Subscription, error) {
	var sub Subscription
	if err := webCall(http.MethodPost, "/v1/subscriptions/"+url.PathEscape(id),
		url.Values{"cancel_at_period_end": {strconv.FormatBool(cancel)}}, "", &sub); err != nil {
		return nil, err
	}
	return &sub, nil
}

// PlanPayment is the plan invoice a PaymentIntent paid (refunds,
// disputes and fraud warnings name a PaymentIntent, and subscription
// PaymentIntents carry no metadata of their own).
type PlanPayment struct {
	InvoiceID      string
	SubscriptionID string
	AmountPaid     int64
}

// PlanPaymentOf finds the subscription invoice pi paid, through the
// invoice payments list; nil, nil when pi paid no subscription invoice.
func (c *Client) PlanPaymentOf(pi string) (*PlanPayment, error) {
	q := url.Values{"payment[type]": {"payment_intent"}, "payment[payment_intent]": {pi}, "limit": {"1"}}
	var page struct {
		Data []struct {
			Invoice string `json:"invoice"`
		} `json:"data"`
	}
	if err := webCall(http.MethodGet, "/v1/invoice_payments?"+q.Encode(), nil, "", &page); err != nil {
		return nil, err
	}
	if len(page.Data) == 0 || page.Data[0].Invoice == "" {
		return nil, nil
	}
	var inv struct {
		ID         string `json:"id"`
		AmountPaid int64  `json:"amount_paid"`
		Parent     struct {
			SubscriptionDetails *struct {
				Subscription string `json:"subscription"`
			} `json:"subscription_details"`
		} `json:"parent"`
	}
	if err := webCall(http.MethodGet, "/v1/invoices/"+url.PathEscape(page.Data[0].Invoice), nil, "", &inv); err != nil {
		return nil, err
	}
	if inv.Parent.SubscriptionDetails == nil || inv.Parent.SubscriptionDetails.Subscription == "" {
		return nil, nil
	}
	return &PlanPayment{InvoiceID: inv.ID, SubscriptionID: inv.Parent.SubscriptionDetails.Subscription, AmountPaid: inv.AmountPaid}, nil
}
