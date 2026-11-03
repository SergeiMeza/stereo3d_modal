package stripex

import (
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Refunds, disputes and early fraud warnings for the refund layer (spec
// C8, C13, A4). Raw calls at WebAPIVersion.

// RefundResult is a created or read refund.
type RefundResult struct {
	ID            string            `json:"id"`
	Status        string            `json:"status"` // pending | succeeded | failed | canceled | requires_action
	Amount        int64             `json:"amount"`
	PaymentIntent string            `json:"payment_intent"`
	Charge        string            `json:"charge"`
	FailureReason string            `json:"failure_reason"`
	Metadata      map[string]string `json:"metadata"`
	Created       int64             `json:"created"`
}

// RefundAmount refunds amount of a PaymentIntent under key (C8 step 3:
// an explicit amount, metadata {source: gateway, case_id, items}).
func (c *Client) RefundAmount(pi string, amount int64, key string, metadata map[string]string) (*RefundResult, error) {
	f := url.Values{"payment_intent": {pi}, "amount": {strconv.FormatInt(amount, 10)}, "metadata[env]": {c.env}}
	for k, v := range metadata {
		f.Set("metadata["+k+"]", v)
	}
	var r RefundResult
	if err := webCall(http.MethodPost, "/v1/refunds", f, key, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// PaymentFacts is what the refund layer reads from a PaymentIntent.
type PaymentFacts struct {
	ID             string
	Received       int64
	Refunded       int64
	Metadata       map[string]string
	MethodType     string
	Created        time.Time
	Country        string
	Brand          string
	Wallet         string
	CustomerID     string
	ChargeID       string
	ChargeDisputed bool
	// Fingerprint: the card's fingerprint (cards and card wallets), for
	// the block list (H).
	Fingerprint string
	Status      string
}

// PaymentFactsOf reads a PaymentIntent with its latest charge.
func (c *Client) PaymentFactsOf(pi string) (*PaymentFacts, error) {
	var raw struct {
		ID             string            `json:"id"`
		Status         string            `json:"status"`
		AmountReceived int64             `json:"amount_received"`
		Metadata       map[string]string `json:"metadata"`
		Created        int64             `json:"created"`
		Customer       string            `json:"customer"`
		LatestCharge   struct {
			ID                   string `json:"id"`
			AmountRefunded       int64  `json:"amount_refunded"`
			Disputed             bool   `json:"disputed"`
			PaymentMethodDetails struct {
				Type string `json:"type"`
				Card struct {
					Brand       string `json:"brand"`
					Country     string `json:"country"`
					Fingerprint string `json:"fingerprint"`
					Wallet      *struct {
						Type string `json:"type"`
					} `json:"wallet"`
				} `json:"card"`
			} `json:"payment_method_details"`
		} `json:"latest_charge"`
	}
	if err := webCall(http.MethodGet, "/v1/payment_intents/"+url.PathEscape(pi)+"?expand[]=latest_charge", nil, "", &raw); err != nil {
		return nil, err
	}
	f := &PaymentFacts{ID: raw.ID, Received: raw.AmountReceived, Refunded: raw.LatestCharge.AmountRefunded, Metadata: raw.Metadata,
		MethodType: raw.LatestCharge.PaymentMethodDetails.Type, Created: time.Unix(raw.Created, 0).UTC(),
		Country: raw.LatestCharge.PaymentMethodDetails.Card.Country, Brand: raw.LatestCharge.PaymentMethodDetails.Card.Brand,
		CustomerID: raw.Customer, ChargeID: raw.LatestCharge.ID, ChargeDisputed: raw.LatestCharge.Disputed,
		Fingerprint: raw.LatestCharge.PaymentMethodDetails.Card.Fingerprint, Status: raw.Status}
	if w := raw.LatestCharge.PaymentMethodDetails.Card.Wallet; w != nil {
		f.Wallet = w.Type
	}
	return f, nil
}

// Dispute is the part of a Stripe dispute the cases and A4 read.
type Dispute struct {
	ID              string `json:"id"`
	Amount          int64  `json:"amount"`
	Charge          string `json:"charge"`
	PaymentIntent   string `json:"payment_intent"`
	Reason          string `json:"reason"`
	Status          string `json:"status"` // warning_needs_response | needs_response | under_review | won | lost | …
	Created         int64  `json:"created"`
	EvidenceDetails struct {
		DueBy int64 `json:"due_by"`
	} `json:"evidence_details"`
	BalanceTransactions []struct {
		Amount int64 `json:"amount"`
		Fee    int64 `json:"fee"`
	} `json:"balance_transactions"`
}

// EFW is an early fraud warning.
type EFW struct {
	ID            string `json:"id"`
	Charge        string `json:"charge"`
	PaymentIntent string `json:"payment_intent"`
	FraudType     string `json:"fraud_type"`
	Actionable    bool   `json:"actionable"`
	Created       int64  `json:"created"`
}

// ListDisputesSince pages the account's disputes created since t.
func (c *Client) ListDisputesSince(t time.Time, max int) ([]Dispute, error) {
	var out []Dispute
	after := ""
	for len(out) < max {
		q := url.Values{"limit": {"100"}, "created[gte]": {strconv.FormatInt(t.Unix(), 10)}}
		if after != "" {
			q.Set("starting_after", after)
		}
		var page struct {
			Data    []Dispute `json:"data"`
			HasMore bool      `json:"has_more"`
		}
		if err := webCall(http.MethodGet, "/v1/disputes?"+q.Encode(), nil, "", &page); err != nil {
			return out, err
		}
		out = append(out, page.Data...)
		if !page.HasMore || len(page.Data) == 0 {
			break
		}
		after = page.Data[len(page.Data)-1].ID
	}
	return out, nil
}

// ListEFWsSince pages the account's early fraud warnings since t.
func (c *Client) ListEFWsSince(t time.Time, max int) ([]EFW, error) {
	var out []EFW
	after := ""
	for len(out) < max {
		q := url.Values{"limit": {"100"}, "created[gte]": {strconv.FormatInt(t.Unix(), 10)}}
		if after != "" {
			q.Set("starting_after", after)
		}
		var page struct {
			Data    []EFW `json:"data"`
			HasMore bool  `json:"has_more"`
		}
		if err := webCall(http.MethodGet, "/v1/radar/early_fraud_warnings?"+q.Encode(), nil, "", &page); err != nil {
			return out, err
		}
		out = append(out, page.Data...)
		if !page.HasMore || len(page.Data) == 0 {
			break
		}
		after = page.Data[len(page.Data)-1].ID
	}
	return out, nil
}

// ChargePI reads a charge's PaymentIntent id (EFWs and disputes name a
// charge; newer API versions also carry payment_intent).
func (c *Client) ChargePI(chargeID string) (string, error) {
	var ch struct {
		PaymentIntent string `json:"payment_intent"`
	}
	if err := webCall(http.MethodGet, "/v1/charges/"+url.PathEscape(chargeID), nil, "", &ch); err != nil {
		return "", err
	}
	return ch.PaymentIntent, nil
}

// SearchedPI is one PaymentIntent from the Search API (M3).
type SearchedPI struct {
	ID             string            `json:"id"`
	Status         string            `json:"status"`
	Amount         int64             `json:"amount"`
	AmountReceived int64             `json:"amount_received"`
	Created        int64             `json:"created"`
	Metadata       map[string]string `json:"metadata"`
	Customer       string            `json:"customer"`
}

// SearchOurPIs pages the Search API for this env's svs-web PaymentIntents
// created since t (M3). Search data runs about a minute behind and allows
// 20 reads a second, so pages are spaced by pause.
func (c *Client) SearchOurPIs(t time.Time, max int, pause time.Duration) ([]SearchedPI, error) {
	query := fmt.Sprintf("metadata['product']:'svs-web' AND metadata['env']:'%s' AND created>%d", c.env, t.Unix())
	var out []SearchedPI
	page := ""
	for len(out) < max {
		q := url.Values{"query": {query}, "limit": {"100"}}
		if page != "" {
			q.Set("page", page)
		}
		var res struct {
			Data     []SearchedPI `json:"data"`
			HasMore  bool         `json:"has_more"`
			NextPage string       `json:"next_page"`
		}
		if err := webCall(http.MethodGet, "/v1/payment_intents/search?"+q.Encode(), nil, "", &res); err != nil {
			return out, err
		}
		out = append(out, res.Data...)
		if !res.HasMore || res.NextPage == "" {
			break
		}
		page = res.NextPage
		time.Sleep(pause)
	}
	return out, nil
}

// EventRef is the part of an event M3 reads.
type EventRef struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Created int64  `json:"created"`
	Data    struct {
		Object struct {
			ID       string            `json:"id"`
			Metadata map[string]string `json:"metadata"`
			Total    int64             `json:"total"`
			Paid     int64             `json:"amount_paid"`
		} `json:"object"`
	} `json:"data"`
}

// ListEventsSince lists events of one type since t (Stripe keeps 30 days).
func (c *Client) ListEventsSince(typ string, t time.Time, max int) ([]EventRef, error) {
	var out []EventRef
	after := ""
	for len(out) < max {
		q := url.Values{"type": {typ}, "limit": {"100"}, "created[gte]": {strconv.FormatInt(t.Unix(), 10)}}
		if after != "" {
			q.Set("starting_after", after)
		}
		var page struct {
			Data    []EventRef `json:"data"`
			HasMore bool       `json:"has_more"`
		}
		if err := webCall(http.MethodGet, "/v1/events?"+q.Encode(), nil, "", &page); err != nil {
			return out, err
		}
		out = append(out, page.Data...)
		if !page.HasMore || len(page.Data) == 0 {
			break
		}
		after = page.Data[len(page.Data)-1].ID
	}
	return out, nil
}

// PaymentMethodFingerprint reads a saved card's fingerprint ("" for
// methods that aren't cards).
func (c *Client) PaymentMethodFingerprint(pm string) (string, error) {
	var out struct {
		Card *struct {
			Fingerprint string `json:"fingerprint"`
		} `json:"card"`
	}
	if err := webCall(http.MethodGet, "/v1/payment_methods/"+url.PathEscape(pm), nil, "", &out); err != nil {
		return "", err
	}
	if out.Card == nil {
		return "", nil
	}
	return out.Card.Fingerprint, nil
}

// CloseDispute accepts a dispute (Stripe marks it lost; the
// charge.dispute.closed webhook closes the case).
func (c *Client) CloseDispute(id string) (*Dispute, error) {
	var d Dispute
	if err := webCall(http.MethodPost, "/v1/disputes/"+url.PathEscape(id)+"/close", url.Values{}, "close_"+id, &d); err != nil {
		return nil, err
	}
	return &d, nil
}
