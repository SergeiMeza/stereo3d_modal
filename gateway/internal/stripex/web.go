package stripex

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/stripe/stripe-go/v78"
)

// SessionSpec describes a Checkout Session for the web (spec v6 D2).
type SessionSpec struct {
	CustomerID  string
	PMC         string // the dedicated payment-method configuration (pmc_web)
	UI          string // elements | hosted_page
	AmountCents int64
	Currency    string
	Label       string // the line item, e.g. "Kyoto walk · 3D video · 4K"
	// ReturnURL: elements mode's return for redirect methods; hosted
	// pages succeed and cancel back to it (cancel adds &canceled=1).
	ReturnURL string
	// NoWeChat hides WeChat Pay (phones and headsets, B16); NoKlarna hides
	// Klarna outside klarna_markets (v6.2 BL-10, empty at launch).
	NoWeChat bool
	NoKlarna bool
	// SaveMethod forces saving card / Link / PayPal for later runs (C3).
	SaveMethod   bool
	ReceiptEmail string
	Description  string
	Metadata     map[string]string // session and PaymentIntent metadata
	IdemKey      string
	ExpiresIn    time.Duration // ≥ 30 min (Stripe's minimum)
}

// CreateWebSession creates a payment-mode Checkout Session per D2.
func (c *Client) CreateWebSession(spec SessionSpec) (*Session, error) {
	f := url.Values{}
	f.Set("mode", "payment")
	f.Set("ui_mode", spec.UI)
	f.Set("customer", spec.CustomerID)
	f.Set("line_items[0][quantity]", "1")
	f.Set("line_items[0][price_data][currency]", spec.Currency)
	f.Set("line_items[0][price_data][unit_amount]", strconv.FormatInt(spec.AmountCents, 10))
	f.Set("line_items[0][price_data][product_data][name]", spec.Label)
	if spec.PMC != "" {
		f.Set("payment_method_configuration", spec.PMC)
	}
	if spec.NoWeChat {
		f.Add("excluded_payment_method_types[]", "wechat_pay")
	}
	if spec.NoKlarna {
		f.Add("excluded_payment_method_types[]", "klarna")
	}
	if spec.SaveMethod {
		for _, m := range []string{"card", "link", "paypal"} {
			f.Set("payment_method_options["+m+"][setup_future_usage]", "off_session")
		}
		f.Set("consent_collection[payment_method_reuse_agreement][position]", "auto")
	}
	f.Add("saved_payment_method_options[allow_redisplay_filters][]", "always")
	f.Add("saved_payment_method_options[allow_redisplay_filters][]", "unspecified")
	f.Set("saved_payment_method_options[payment_method_remove]", "disabled")
	// No tax ID in the payment form (owner 2026-11-05: added or edited
	// later in Business details); the address is still saved on the
	// customer, which is what tax is reckoned from.
	f.Set("customer_update[address]", "auto")
	f.Set("billing_address_collection", "auto")
	exp := spec.ExpiresIn
	if exp < 30*time.Minute {
		exp = 30 * time.Minute
	}
	f.Set("expires_at", strconv.FormatInt(time.Now().Add(exp+time.Minute).Unix(), 10))
	switch spec.UI {
	case "hosted_page":
		f.Set("success_url", spec.ReturnURL)
		sep := "?"
		if strings.Contains(spec.ReturnURL, "?") {
			sep = "&"
		}
		f.Set("cancel_url", spec.ReturnURL+sep+"canceled=1")
	default:
		f.Set("return_url", spec.ReturnURL)
	}
	f.Set("payment_intent_data[statement_descriptor_suffix]", DescriptorSuffixWeb)
	if spec.ReceiptEmail != "" {
		f.Set("payment_intent_data[receipt_email]", spec.ReceiptEmail)
	}
	if spec.Description != "" {
		f.Set("payment_intent_data[description]", spec.Description)
	}
	md := map[string]string{"env": c.env, "product": "svs-web"}
	for k, v := range spec.Metadata {
		if v != "" {
			md[k] = v
		}
	}
	for k, v := range md {
		f.Set("metadata["+k+"]", v)
		f.Set("payment_intent_data[metadata]["+k+"]", v)
	}
	return c.CreateCheckoutSession(f, spec.IdemKey)
}

// CreateSetupSession creates a setup-mode session to save a method in
// Billing (owner 2026-11-03: our own Billing, no Stripe portal).
func (c *Client) CreateSetupSession(customerID, pmc, returnURL string, metadata map[string]string, idemKey string) (*Session, error) {
	f := url.Values{}
	f.Set("mode", "setup")
	f.Set("ui_mode", "elements")
	f.Set("customer", customerID)
	f.Set("currency", "usd")
	if pmc != "" {
		f.Set("payment_method_configuration", pmc)
	}
	f.Set("return_url", returnURL)
	f.Set("setup_intent_data[metadata][env]", c.env)
	f.Set("metadata[env]", c.env)
	f.Set("metadata[product]", "svs-web")
	for k, v := range metadata {
		f.Set("metadata["+k+"]", v)
		f.Set("setup_intent_data[metadata]["+k+"]", v)
	}
	return c.CreateCheckoutSession(f, idemKey)
}

// SetupSessionMethod reads the payment method a completed setup session
// saved ("" when none).
func (c *Client) SetupSessionMethod(sessionID string) (string, error) {
	var s struct {
		SetupIntent string `json:"setup_intent"`
	}
	if err := webCall(http.MethodGet, "/v1/checkout/sessions/"+url.PathEscape(sessionID), nil, "", &s); err != nil {
		return "", err
	}
	if s.SetupIntent == "" {
		return "", nil
	}
	var si struct {
		PaymentMethod string `json:"payment_method"`
	}
	if err := webCall(http.MethodGet, "/v1/setup_intents/"+url.PathEscape(s.SetupIntent), nil, "", &si); err != nil {
		return "", err
	}
	return si.PaymentMethod, nil
}

// ------------------------------------------------------- customer helpers

// MethodOwner returns the customer a payment method is attached to.
func (c *Client) MethodOwner(pmID string) (customerID, pmType string, err error) {
	var pm struct {
		Customer string `json:"customer"`
		Type     string `json:"type"`
	}
	if err := webCall(http.MethodGet, "/v1/payment_methods/"+url.PathEscape(pmID), nil, "", &pm); err != nil {
		return "", "", err
	}
	return pm.Customer, pm.Type, nil
}

// SetAllowRedisplay marks a saved method redisplayable (C3: after consent).
func (c *Client) SetAllowRedisplay(pmID string) error {
	var out map[string]any
	return webCall(http.MethodPost, "/v1/payment_methods/"+url.PathEscape(pmID), url.Values{"allow_redisplay": {"always"}}, "", &out)
}

// SetDefaultMethod makes pmID the customer's default.
func (c *Client) SetDefaultMethod(customerID, pmID string) error {
	var out map[string]any
	return webCall(http.MethodPost, "/v1/customers/"+url.PathEscape(customerID),
		url.Values{"invoice_settings[default_payment_method]": {pmID}}, "", &out)
}

// DetachMethod removes a saved method.
func (c *Client) DetachMethod(pmID string) error {
	var out map[string]any
	return webCall(http.MethodPost, "/v1/payment_methods/"+url.PathEscape(pmID)+"/detach", url.Values{}, "", &out)
}

// SetTaxIP records the customer's IP as tax location evidence (C6).
func (c *Client) SetTaxIP(customerID, ip string) error {
	if ip == "" {
		return nil
	}
	var out map[string]any
	return webCall(http.MethodPost, "/v1/customers/"+url.PathEscape(customerID), url.Values{"tax[ip_address]": {ip}}, "", &out)
}

// Company is the customer's name, billing address and tax IDs (B15).
type Company struct {
	Name    string            `json:"name"`
	Address map[string]string `json:"address,omitempty"` // line1, line2, city, state, postal_code, country
	TaxIDs  []TaxID           `json:"tax_ids"`
}

// TaxID is one of the customer's tax IDs.
type TaxID struct {
	ID           string `json:"id"`
	Type         string `json:"type"`
	Value        string `json:"value"`
	Verification *struct {
		Status string `json:"status"` // pending | verified | unverified | unavailable
	} `json:"verification,omitempty"`
}

// VerificationStatus is Stripe's verification status ("" when none).
func (t TaxID) VerificationStatus() string {
	if t.Verification == nil {
		return ""
	}
	return t.Verification.Status
}

// GetCompany reads the customer's company details.
func (c *Client) GetCompany(customerID string) (*Company, error) {
	var cust struct {
		Name    string            `json:"name"`
		Address map[string]string `json:"address"`
	}
	if err := webCall(http.MethodGet, "/v1/customers/"+url.PathEscape(customerID), nil, "", &cust); err != nil {
		return nil, err
	}
	var ids struct {
		Data []TaxID `json:"data"`
	}
	if err := webCall(http.MethodGet, "/v1/customers/"+url.PathEscape(customerID)+"/tax_ids?limit=20", nil, "", &ids); err != nil {
		return nil, err
	}
	out := &Company{Name: cust.Name, TaxIDs: ids.Data}
	if out.TaxIDs == nil {
		out.TaxIDs = []TaxID{}
	}
	if len(cust.Address) > 0 {
		out.Address = map[string]string{}
		for k, v := range cust.Address {
			if v != "" {
				out.Address[k] = v
			}
		}
	}
	return out, nil
}

// UpdateCompany sets name and address (nil leaves either unchanged).
func (c *Client) UpdateCompany(customerID string, name *string, address map[string]string) error {
	f := url.Values{}
	if name != nil {
		f.Set("name", *name)
	}
	for k, v := range address {
		f.Set("address["+k+"]", v)
	}
	if len(f) == 0 {
		return nil
	}
	var out map[string]any
	return webCall(http.MethodPost, "/v1/customers/"+url.PathEscape(customerID), f, "", &out)
}

// SetInvoicePO sets the customer's invoice custom field "PO" (shown on
// every invoice finalized from now on); "" removes it.
func (c *Client) SetInvoicePO(customerID, po string) error {
	f := url.Values{}
	if po == "" {
		f.Set("invoice_settings[custom_fields]", "")
	} else {
		f.Set("invoice_settings[custom_fields][0][name]", "PO")
		f.Set("invoice_settings[custom_fields][0][value]", po)
	}
	var out map[string]any
	return webCall(http.MethodPost, "/v1/customers/"+url.PathEscape(customerID), f, "", &out)
}

// AddTaxID adds a tax ID; Stripe validates the type and format.
func (c *Client) AddTaxID(customerID, typ, value string) (*TaxID, error) {
	var out TaxID
	err := webCall(http.MethodPost, "/v1/customers/"+url.PathEscape(customerID)+"/tax_ids",
		url.Values{"type": {typ}, "value": {value}}, "", &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteTaxID removes one of the customer's tax IDs.
func (c *Client) DeleteTaxID(customerID, id string) error {
	var out map[string]any
	return webCall(http.MethodDelete, "/v1/customers/"+url.PathEscape(customerID)+"/tax_ids/"+url.PathEscape(id), nil, "", &out)
}

// ErrMessage is a Stripe error's message for the client (validation).
func ErrMessage(err error) string {
	var serr *stripe.Error
	if errors.As(err, &serr) && serr.Msg != "" {
		return serr.Msg
	}
	return fmt.Sprint(err)
}

// CustomerUID reads which account (and environment) a Stripe customer
// belongs to, from the metadata set when it was created.
func (c *Client) CustomerUID(customerID string) (uid, env string, err error) {
	var cu struct {
		Metadata map[string]string `json:"metadata"`
	}
	if err := webCall(http.MethodGet, "/v1/customers/"+url.PathEscape(customerID), nil, "", &cu); err != nil {
		return "", "", err
	}
	return cu.Metadata["firebase_uid"], cu.Metadata["env"], nil
}
