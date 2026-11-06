package stripex

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Reads for Restore Purchases (owner 2026-11-06). Nothing here writes to
// Stripe or moves money.

// PaidInvoice is a paid invoice as Stripe sends it (Raw, the same object
// an invoice.paid event carries) and the fields the restore reads.
type PaidInvoice struct {
	ID      string
	Created int64
	Raw     json.RawMessage
}

// PaidSubscriptionInvoices is a subscription's paid invoices, newest
// first, at most limit.
func (c *Client) PaidSubscriptionInvoices(subscriptionID string, limit int) ([]PaidInvoice, error) {
	q := url.Values{"subscription": {subscriptionID}, "status": {"paid"}, "limit": {strconv.Itoa(limit)}}
	var page struct {
		Data []json.RawMessage `json:"data"`
	}
	if err := webCall(http.MethodGet, "/v1/invoices?"+q.Encode(), nil, "", &page); err != nil {
		return nil, err
	}
	out := make([]PaidInvoice, 0, len(page.Data))
	for _, raw := range page.Data {
		var head struct {
			ID      string `json:"id"`
			Status  string `json:"status"`
			Created int64  `json:"created"`
		}
		if json.Unmarshal(raw, &head) != nil || head.ID == "" || head.Status != "paid" {
			continue
		}
		out = append(out, PaidInvoice{ID: head.ID, Created: head.Created, Raw: raw})
	}
	return out, nil
}

// CustomersOfUID is every Stripe customer of this env made for uid (the
// metadata EnsureCustomer writes), up to 20: the account's own and any
// left behind by an older mapping.
func (c *Client) CustomersOfUID(uid string) ([]string, error) {
	if uid == "" || strings.ContainsAny(uid, `'"\`) {
		return nil, fmt.Errorf("uid not searchable")
	}
	query := fmt.Sprintf("metadata['firebase_uid']:'%s' AND metadata['env']:'%s'", uid, c.env)
	q := url.Values{"query": {query}, "limit": {"20"}}
	var page struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := webCall(http.MethodGet, "/v1/customers/search?"+q.Encode(), nil, "", &page); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(page.Data))
	for _, d := range page.Data {
		if d.ID != "" {
			out = append(out, d.ID)
		}
	}
	return out, nil
}
