package stripex

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/stripe/stripe-go/v78"
)

// Checkout Sessions (spec v6 D1) need API 2026-03-25.dahlia or later for
// ui_mode=elements / hosted_page, which the pinned SDK (2024-04-10) can't
// express. These calls go out as plain form requests pinned to WebAPIVersion
// and decode only the fields the gateway uses. The iOS ephemeral key and the
// webhook endpoint keep their own versions (I.6).
const WebAPIVersion = "2026-10-28.endive"

// Session is the part of a Checkout Session the gateway reads.
type Session struct {
	ID            string            `json:"id"`
	Status        string            `json:"status"`         // open | complete | expired
	PaymentStatus string            `json:"payment_status"` // paid | unpaid | no_payment_required
	PaymentIntent string            `json:"payment_intent"` // expanded below when an object
	ClientSecret  string            `json:"client_secret"`
	URL           string            `json:"url"`
	ExpiresAt     int64             `json:"expires_at"`
	AmountTotal   int64             `json:"amount_total"`
	Customer      string            `json:"customer"`
	Metadata      map[string]string `json:"metadata"`
	UIMode        string            `json:"ui_mode"`
	Currency      string            `json:"currency"`
	// PresentmentDetails: the customer's currency and amount when
	// Adaptive Pricing presented it (filled once the client rendered).
	PresentmentDetails *presentmentDetails `json:"presentment_details"`
}

// Expires is the session's expiry as a time.
func (s *Session) Expires() time.Time { return time.Unix(s.ExpiresAt, 0).UTC() }

// Paid: the session's payment is in.
func (s *Session) Paid() bool { return s.Status == "complete" && s.PaymentStatus == "paid" }

var checkoutHTTP = &http.Client{Timeout: 15 * time.Second}

// apiBase is Stripe's API origin (tests point it elsewhere).
var apiBase = "https://api.stripe.com"

// webCall sends one form request at WebAPIVersion. A Stripe error comes
// back as *stripe.Error so ClassifyChargeError and stripeErrCode work.
func webCall(method, path string, form url.Values, idemKey string, out any) error {
	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequest(method, apiBase+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+stripe.Key)
	req.Header.Set("Stripe-Version", WebAPIVersion)
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}
	resp, err := checkoutHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		var wrapped struct {
			Error *stripe.Error `json:"error"`
		}
		if json.Unmarshal(raw, &wrapped) == nil && wrapped.Error != nil {
			wrapped.Error.HTTPStatusCode = resp.StatusCode
			return wrapped.Error
		}
		return fmt.Errorf("stripe %s %s: status %d", method, path, resp.StatusCode)
	}
	return json.Unmarshal(raw, out)
}

// CreateCheckoutSession creates a session from form parameters. The
// idempotency key is the caller's base key plus a hash of the exact
// parameters (owner bug 2026-11-07: closing and reopening the Pro sheet
// within a minute sent the same plan key with a new expires_at, and Stripe
// refused it with idempotency_error). An identical retry still dedupes;
// any change, expires_at included, opens a fresh session. If Stripe still
// answers idempotency_error, it retries once under a fresh key.
func (c *Client) CreateCheckoutSession(form url.Values, idemKey string) (*Session, error) {
	key := sessionKey(idemKey, form)
	var s Session
	err := webCall(http.MethodPost, "/v1/checkout/sessions", form, key, &s)
	var serr *stripe.Error
	if errors.As(err, &serr) && serr.Type == stripe.ErrorTypeIdempotency && key != "" {
		s = Session{}
		err = webCall(http.MethodPost, "/v1/checkout/sessions", form, key+"_r"+strconv.FormatInt(time.Now().UnixNano(), 36), &s)
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// sessionKey is base_<16 hex of sha256(the encoded form)>; "" stays "".
func sessionKey(base string, form url.Values) string {
	if base == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(form.Encode()))
	return base + "_" + hex.EncodeToString(sum[:8])
}

// GetCheckoutSession retrieves a session.
func (c *Client) GetCheckoutSession(id string) (*Session, error) {
	var s Session
	if err := webCall(http.MethodGet, "/v1/checkout/sessions/"+url.PathEscape(id), nil, "", &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// ExpireCheckoutSession closes an open session so nobody can pay it, and
// returns it as it ended: a session already complete comes back complete
// (it was paid — the caller adopts or refunds that money, E0-1/E0-2), an
// expired one as expired.
func (c *Client) ExpireCheckoutSession(id string) (*Session, error) {
	var s Session
	err := webCall(http.MethodPost, "/v1/checkout/sessions/"+url.PathEscape(id)+"/expire", url.Values{}, "", &s)
	if err == nil {
		return &s, nil
	}
	// Not open any more (complete or already expired): read what it is.
	got, gerr := c.GetCheckoutSession(id)
	if gerr != nil {
		return nil, err
	}
	if got.Status == "open" {
		return nil, err // a real failure to expire: the caller retries
	}
	return got, nil
}

// Outcome is how a payment object ended when it was closed or read.
type Outcome struct {
	Paid            bool
	Processing      bool // accepted, not settled (P2)
	PaymentIntentID string
	AmountReceived  int64
	PaymentMethod   string
	// Presentment: what the customer paid in their currency, from a paid
	// Checkout Session under Adaptive Pricing (nil otherwise: USD, or an
	// outcome read from a PaymentIntent).
	Presentment *Presentment
}

// ClosePaymentIntent cancels a PaymentIntent so it can't be paid any more,
// unless it already succeeded (then Paid) or is processing (then
// Processing: it can't be canceled and must be waited for).
func (c *Client) ClosePaymentIntent(id string) (Outcome, error) {
	pi, err := c.GetPaymentIntent(id)
	if err != nil {
		return Outcome{}, err
	}
	out := Outcome{PaymentIntentID: pi.ID, AmountReceived: pi.AmountReceived}
	if pi.PaymentMethod != nil {
		out.PaymentMethod = pi.PaymentMethod.ID
	}
	switch pi.Status {
	case stripe.PaymentIntentStatusSucceeded:
		out.Paid = true
		return out, nil
	case stripe.PaymentIntentStatusProcessing:
		out.Processing = true
		return out, nil
	case stripe.PaymentIntentStatusCanceled:
		return out, nil
	}
	if err := c.CancelHold(id); err != nil {
		// a cancel that lost a race with a success
		if got, gerr := c.GetPaymentIntent(id); gerr == nil && got.Status == stripe.PaymentIntentStatusSucceeded {
			out.Paid, out.AmountReceived = true, got.AmountReceived
			return out, nil
		}
		return Outcome{}, err
	}
	return out, nil
}

// CloseCheckoutSession expires a session unless it was paid, returning
// how it ended (with its PaymentIntent's facts when paid).
func (c *Client) CloseCheckoutSession(id string) (Outcome, error) {
	s, err := c.ExpireCheckoutSession(id)
	if err != nil {
		return Outcome{}, err
	}
	return c.sessionOutcome(s)
}

// SessionOutcome reads a session's outcome without changing it.
func (c *Client) SessionOutcome(id string) (Outcome, *Session, error) {
	s, err := c.GetCheckoutSession(id)
	if err != nil {
		return Outcome{}, nil, err
	}
	out, err := c.sessionOutcome(s)
	return out, s, err
}

func (c *Client) sessionOutcome(s *Session) (Outcome, error) {
	out := Outcome{PaymentIntentID: s.PaymentIntent}
	if s.PaymentIntent == "" || s.Status != "complete" {
		return out, nil
	}
	pi, err := c.GetPaymentIntent(s.PaymentIntent)
	if err != nil {
		return Outcome{}, err
	}
	out.AmountReceived = pi.AmountReceived
	if pi.PaymentMethod != nil {
		out.PaymentMethod = pi.PaymentMethod.ID
	}
	out.Paid = pi.Status == stripe.PaymentIntentStatusSucceeded
	out.Processing = pi.Status == stripe.PaymentIntentStatusProcessing
	if out.Paid {
		out.Presentment = s.PresentmentDetails.value(s.Currency)
	}
	return out, nil
}

// UseTestServer points every Stripe call (SDK and checkout) at a fake
// server (tests).
func UseTestServer(url string) {
	apiBase = url
	stripe.SetBackend(stripe.APIBackend, stripe.GetBackendWithConfig(stripe.APIBackend, &stripe.BackendConfig{
		URL:               stripe.String(url),
		MaxNetworkRetries: stripe.Int64(0),
	}))
}
