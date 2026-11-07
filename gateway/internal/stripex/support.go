package stripex

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Reads for refund requests and support lookups (owner 2026-11-06).
// Nothing here writes to Stripe.

// InvoicePaidAt is when an invoice was paid (zero when it isn't).
func (c *Client) InvoicePaidAt(invoiceID string) (time.Time, error) {
	var inv struct {
		Status            string `json:"status"`
		StatusTransitions struct {
			PaidAt int64 `json:"paid_at"`
		} `json:"status_transitions"`
	}
	if err := webCall(http.MethodGet, "/v1/invoices/"+url.PathEscape(invoiceID), nil, "", &inv); err != nil {
		return time.Time{}, err
	}
	if inv.Status != "paid" || inv.StatusTransitions.PaidAt == 0 {
		return time.Time{}, nil
	}
	return time.Unix(inv.StatusTransitions.PaidAt, 0).UTC(), nil
}

// EmailCustomer is a Stripe customer found by email: the account it was
// made for (metadata firebase_uid, this env only) and its email.
type EmailCustomer struct {
	ID    string
	UID   string
	Email string
}

// CustomersByEmail is this env's Stripe customers whose email is exactly
// email, up to 20 (support's lookup for an account the console can't
// find by its own records).
func (c *Client) CustomersByEmail(email string) ([]EmailCustomer, error) {
	email = strings.TrimSpace(email)
	if email == "" || strings.ContainsAny(email, `'"\`) {
		return nil, fmt.Errorf("email not searchable")
	}
	q := url.Values{"query": {fmt.Sprintf("email:'%s'", email)}, "limit": {"20"}}
	var page struct {
		Data []struct {
			ID       string            `json:"id"`
			Email    string            `json:"email"`
			Metadata map[string]string `json:"metadata"`
		} `json:"data"`
	}
	if err := webCall(http.MethodGet, "/v1/customers/search?"+q.Encode(), nil, "", &page); err != nil {
		return nil, err
	}
	out := []EmailCustomer{}
	for _, d := range page.Data {
		if d.Metadata["env"] != c.env || d.Metadata["firebase_uid"] == "" {
			continue
		}
		out = append(out, EmailCustomer{ID: d.ID, UID: d.Metadata["firebase_uid"], Email: d.Email})
	}
	return out, nil
}
