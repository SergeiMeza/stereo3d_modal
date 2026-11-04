package stripex

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/stripe/stripe-go/v78"
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
	// PlanID (pro_weekly | pro_monthly | pro_yearly; "" = the tier) and
	// Coupon (a Pro intro, on the first invoice).
	PlanID string
	Coupon string
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
	if spec.PlanID != "" {
		md["plan_id"] = spec.PlanID
	}
	if spec.Coupon != "" {
		f.Set("discounts[0][coupon]", spec.Coupon)
	}
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
			ID                 string `json:"id"`
			CurrentPeriodStart int64  `json:"current_period_start"`
			CurrentPeriodEnd   int64  `json:"current_period_end"`
			Price              struct {
				ID        string `json:"id"`
				LookupKey string `json:"lookup_key"`
				Recurring struct {
					Interval string `json:"interval"`
				} `json:"recurring"`
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

// InvoicePayment is the PaymentIntent that paid an invoice and how much.
func (c *Client) InvoicePayment(invoiceID string) (pi string, paid int64, err error) {
	var page struct {
		Data []struct {
			AmountPaid int64  `json:"amount_paid"`
			Status     string `json:"status"`
			Payment    struct {
				PaymentIntent string `json:"payment_intent"`
			} `json:"payment"`
		} `json:"data"`
	}
	if err := webCall(http.MethodGet, "/v1/invoice_payments?invoice="+url.QueryEscape(invoiceID)+"&limit=10", nil, "", &page); err != nil {
		return "", 0, err
	}
	for _, p := range page.Data {
		if p.Status == "paid" && p.Payment.PaymentIntent != "" {
			return p.Payment.PaymentIntent, p.AmountPaid, nil
		}
	}
	return "", 0, fmt.Errorf("invoice %s has no paid payment", invoiceID)
}

// CancelSubscriptionNow ends a subscription at once (no proration, no
// final invoice): a plan refunded early.
func (c *Client) CancelSubscriptionNow(id string) error {
	var out map[string]any
	return webCall(http.MethodDelete, "/v1/subscriptions/"+url.PathEscape(id), nil, "", &out)
}

// Interval is the subscription's billing interval (month | year).
func (s *Subscription) Interval() string {
	if len(s.Items.Data) > 0 && s.Items.Data[0].Price.Recurring.Interval != "" {
		return s.Items.Data[0].Price.Recurring.Interval
	}
	return "month"
}

// ItemID is the subscription's (only) item.
func (s *Subscription) ItemID() string {
	if len(s.Items.Data) > 0 {
		return s.Items.Data[0].ID
	}
	return ""
}

// PlanChange swaps a subscription's price now (owner 2026-11-04): a full
// new period from today (billing_cycle_anchor=now), no Stripe proration
// (the old plan's credit is ours, a pending invoice item made first), paid
// at once; a payment that fails leaves the subscription as it was
// (payment_behavior=error_if_incomplete, 402).
type PlanChange struct {
	SubscriptionID string
	ItemID         string
	PriceID        string
	Metadata       map[string]string // plan, plan_id, changed_from
}

// ChangePlan applies it (key: one change per caller's key).
func (c *Client) ChangePlan(pc PlanChange, key string) (*Subscription, error) {
	f := url.Values{}
	f.Set("items[0][id]", pc.ItemID)
	f.Set("items[0][price]", pc.PriceID)
	f.Set("proration_behavior", "none")
	f.Set("billing_cycle_anchor", "now")
	f.Set("payment_behavior", "error_if_incomplete")
	for k, v := range pc.Metadata {
		f.Set("metadata["+k+"]", v)
	}
	var sub Subscription
	if err := webCall(http.MethodPost, "/v1/subscriptions/"+url.PathEscape(pc.SubscriptionID), f, key, &sub); err != nil {
		return nil, err
	}
	return &sub, nil
}

// AddPendingCredit puts a negative invoice item on the subscription's next
// invoice (the change's), returning its id.
func (c *Client) AddPendingCredit(customerID, subscriptionID string, cents int64, desc, key string) (string, error) {
	f := url.Values{"customer": {customerID}, "subscription": {subscriptionID}, "currency": {"usd"},
		"amount": {strconv.FormatInt(-cents, 10)}, "description": {desc}}
	var out struct {
		ID string `json:"id"`
	}
	if err := webCall(http.MethodPost, "/v1/invoiceitems", f, key, &out); err != nil {
		return "", err
	}
	return out.ID, nil
}

// RemovePendingCredit takes back a pending credit a failed change left.
func (c *Client) RemovePendingCredit(itemID string) error {
	var out map[string]any
	return webCall(http.MethodDelete, "/v1/invoiceitems/"+url.PathEscape(itemID), nil, "", &out)
}

// AddInvoiceCoupon puts a coupon on a draft invoice (a Pro intro's later
// cycles).
func (c *Client) AddInvoiceCoupon(invoiceID, coupon string) error {
	var out map[string]any
	return webCall(http.MethodPost, "/v1/invoices/"+url.PathEscape(invoiceID), url.Values{"discounts[0][coupon]": {coupon}}, "", &out)
}

// ScheduleStepDown switches a subscription to newPrice at the end of its
// current period (owner 2026-11-04): a subscription schedule made from the
// subscription, its current phase kept to the period's end, then the new
// price with metadata (set on the subscription when that phase starts);
// no proration, released after the switch. Returns the schedule id.
func (c *Client) ScheduleStepDown(subscriptionID, newPrice string, metadata map[string]string, key string) (string, error) {
	var sch struct {
		ID     string `json:"id"`
		Phases []struct {
			StartDate int64 `json:"start_date"`
			EndDate   int64 `json:"end_date"`
			Items     []struct {
				Price any `json:"price"`
			} `json:"items"`
		} `json:"phases"`
	}
	if err := webCall(http.MethodPost, "/v1/subscription_schedules", url.Values{"from_subscription": {subscriptionID}}, key+"_create", &sch); err != nil {
		return "", err
	}
	if len(sch.Phases) == 0 || len(sch.Phases[0].Items) == 0 {
		return sch.ID, fmt.Errorf("schedule %s has no current phase", sch.ID)
	}
	cur := ""
	switch p := sch.Phases[0].Items[0].Price.(type) {
	case string:
		cur = p
	case map[string]any:
		cur, _ = p["id"].(string)
	}
	f := url.Values{}
	f.Set("end_behavior", "release")
	f.Set("proration_behavior", "none")
	f.Set("phases[0][items][0][price]", cur)
	f.Set("phases[0][start_date]", strconv.FormatInt(sch.Phases[0].StartDate, 10))
	f.Set("phases[0][end_date]", strconv.FormatInt(sch.Phases[0].EndDate, 10))
	f.Set("phases[1][items][0][price]", newPrice)
	f.Set("phases[1][proration_behavior]", "none")
	for k, v := range metadata {
		f.Set("phases[1][metadata]["+k+"]", v)
	}
	var out map[string]any
	if err := webCall(http.MethodPost, "/v1/subscription_schedules/"+url.PathEscape(sch.ID), f, key+"_phases", &out); err != nil {
		return sch.ID, err
	}
	return sch.ID, nil
}

// ReleaseSchedule ends a schedule, leaving the subscription as it is
// ("Keep Studio").
func (c *Client) ReleaseSchedule(id string) error {
	var out map[string]any
	return webCall(http.MethodPost, "/v1/subscription_schedules/"+url.PathEscape(id)+"/release", url.Values{}, "", &out)
}

// PaymentRequired: Stripe answered 402 (a payment that didn't go through).
func PaymentRequired(err error) bool {
	var se *stripe.Error
	return errors.As(err, &se) && se.HTTPStatusCode == http.StatusPaymentRequired
}
