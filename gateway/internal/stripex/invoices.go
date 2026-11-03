package stripex

import (
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"time"
)

// Invoices after the money (spec v6 C6): an invoice is made for a
// PaymentIntent that already succeeded — items, finalize without
// collecting, then attach_payment — and credit notes for its refunds.
// Raw calls at WebAPIVersion (attach_payment and credit-note refunds are
// newer than the pinned SDK).

// InvoiceFooter is the C6 footer (C3: the withdrawal line).
const InvoiceFooter = "Spatial Video Studio on the web. It starts right away. " +
	"You agreed that you lose your right to cancel once it's done."

// TopupInvoiceFooter replaces the withdrawal line on a top-up's invoice
// (v7 N12).
const TopupInvoiceFooter = "Prepaid balance for Spatial Video Studio on the web. Unspent balance can be refunded within 14 days of this " +
	"top-up. The balance expires 12 months after your last top-up."

// Invoice is the part of a Stripe invoice the job reads.
type Invoice struct {
	ID               string            `json:"id"`
	Status           string            `json:"status"` // draft | open | paid | uncollectible | void
	Number           string            `json:"number"`
	Total            int64             `json:"total"`
	AmountPaid       int64             `json:"amount_paid"`
	Currency         string            `json:"currency"`
	Created          int64             `json:"created"`
	HostedInvoiceURL string            `json:"hosted_invoice_url"`
	InvoicePDF       string            `json:"invoice_pdf"`
	Metadata         map[string]string `json:"metadata"`
	AutomaticTax     struct {
		Enabled bool   `json:"enabled"`
		Status  string `json:"status"`
	} `json:"automatic_tax"`
}

// InvoiceSpec is one invoice to create.
type InvoiceSpec struct {
	CustomerID string
	ChargeID   string
	// Currency must be set: an invoice otherwise takes the account's
	// default (GBP on this UK account) and refuses USD items.
	Currency    string
	EffectiveAt time.Time
	Tax         bool   // tax_mode inclusive: automatic_tax
	Footer      string // "" = InvoiceFooter
}

// CreateInvoice creates the draft under key (C6 step 1).
func (c *Client) CreateInvoice(spec InvoiceSpec, key string) (*Invoice, error) {
	form := url.Values{
		"customer":                       {spec.CustomerID},
		"currency":                       {spec.Currency},
		"collection_method":              {"charge_automatically"},
		"auto_advance":                   {"false"},
		"pending_invoice_items_behavior": {"exclude"},
		"footer":                         {orFooter(spec.Footer)},
		"metadata[env]":                  {c.env},
		"metadata[product]":              {"svs-web"},
		"metadata[charge_id]":            {spec.ChargeID},
	}
	if !spec.EffectiveAt.IsZero() {
		form.Set("effective_at", strconv.FormatInt(spec.EffectiveAt.Unix(), 10))
	}
	if spec.Tax {
		form.Set("automatic_tax[enabled]", "true")
	}
	var inv Invoice
	if err := webCall(http.MethodPost, "/v1/invoices", form, key, &inv); err != nil {
		return nil, err
	}
	return &inv, nil
}

// GetInvoice reads an invoice.
func (c *Client) GetInvoice(id string) (*Invoice, error) {
	var inv Invoice
	if err := webCall(http.MethodGet, "/v1/invoices/"+url.PathEscape(id), nil, "", &inv); err != nil {
		return nil, err
	}
	return &inv, nil
}

// InvoiceLineRuns lists the conversion ids already on a draft's lines.
func (c *Client) InvoiceLineRuns(id string) (map[string]bool, error) {
	var page struct {
		Data []struct {
			Metadata map[string]string `json:"metadata"`
		} `json:"data"`
	}
	if err := webCall(http.MethodGet, "/v1/invoices/"+url.PathEscape(id)+"/lines?limit=100", nil, "", &page); err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, l := range page.Data {
		if id := l.Metadata["conversion_id"]; id != "" {
			out[id] = true
		}
	}
	return out, nil
}

// InvoiceItem is one run's line (C6 step 2).
type InvoiceItem struct {
	CustomerID   string
	InvoiceID    string
	AmountCents  int64
	Currency     string
	Description  string
	ConversionID string
	Tax          bool
}

// AddInvoiceItem adds a line under key.
func (c *Client) AddInvoiceItem(it InvoiceItem, key string) error {
	form := url.Values{
		"customer":                {it.CustomerID},
		"invoice":                 {it.InvoiceID},
		"amount":                  {strconv.FormatInt(it.AmountCents, 10)},
		"currency":                {it.Currency},
		"description":             {it.Description},
		"metadata[conversion_id]": {it.ConversionID},
		"metadata[env]":           {c.env},
	}
	if it.Tax {
		form.Set("tax_behavior", "inclusive")
		form.Set("tax_code", "txcd_10000000") // electronically supplied services
	}
	var out map[string]any
	return webCall(http.MethodPost, "/v1/invoiceitems", form, key, &out)
}

// FinalizeInvoice finalizes without collecting (auto_advance=false).
func (c *Client) FinalizeInvoice(id string) (*Invoice, error) {
	var inv Invoice
	if err := webCall(http.MethodPost, "/v1/invoices/"+url.PathEscape(id)+"/finalize",
		url.Values{"auto_advance": {"false"}}, "", &inv); err != nil {
		return nil, err
	}
	return &inv, nil
}

// DisableInvoiceTax turns automatic tax off on a draft (C6 guard: a tax
// location failure finalizes without it).
func (c *Client) DisableInvoiceTax(id string) error {
	var out map[string]any
	return webCall(http.MethodPost, "/v1/invoices/"+url.PathEscape(id), url.Values{"automatic_tax[enabled]": {"false"}}, "", &out)
}

// AttachPayment marks the invoice paid by a PaymentIntent that already
// succeeded (C6 step 4).
func (c *Client) AttachPayment(invoiceID, paymentIntentID string) (*Invoice, error) {
	var inv Invoice
	if err := webCall(http.MethodPost, "/v1/invoices/"+url.PathEscape(invoiceID)+"/attach_payment",
		url.Values{"payment_intent": {paymentIntentID}}, "", &inv); err != nil {
		return nil, err
	}
	return &inv, nil
}

// VoidInvoice voids an open invoice.
func (c *Client) VoidInvoice(id string) error {
	var out map[string]any
	return webCall(http.MethodPost, "/v1/invoices/"+url.PathEscape(id)+"/void", url.Values{}, "", &out)
}

// Refund is a refund on a PaymentIntent.
type Refund struct {
	ID       string            `json:"id"`
	Amount   int64             `json:"amount"`
	Status   string            `json:"status"`
	Created  int64             `json:"created"`
	Metadata map[string]string `json:"metadata"`
}

// ListRefunds lists a PaymentIntent's refunds (C6 step 5).
func (c *Client) ListRefunds(paymentIntentID string) ([]Refund, error) {
	var page struct {
		Data []Refund `json:"data"`
	}
	if err := webCall(http.MethodGet, "/v1/refunds?limit=100&payment_intent="+url.QueryEscape(paymentIntentID), nil, "", &page); err != nil {
		return nil, err
	}
	return page.Data, nil
}

// PaymentAmounts reads what a PaymentIntent collected and what was given
// back.
func (c *Client) PaymentAmounts(paymentIntentID string) (received, refunded int64, err error) {
	var pi struct {
		AmountReceived int64 `json:"amount_received"`
		LatestCharge   struct {
			AmountRefunded int64 `json:"amount_refunded"`
		} `json:"latest_charge"`
	}
	if err := webCall(http.MethodGet, "/v1/payment_intents/"+url.PathEscape(paymentIntentID)+"?expand[]=latest_charge", nil, "", &pi); err != nil {
		return 0, 0, err
	}
	return pi.AmountReceived, pi.LatestCharge.AmountRefunded, nil
}

// CreditNote is the part of a credit note we keep.
type CreditNote struct {
	ID      string `json:"id"`
	Number  string `json:"number"`
	Invoice string `json:"invoice"`
	Total   int64  `json:"total"`
	Created int64  `json:"created"`
	PDF     string `json:"pdf"`
	Status  string `json:"status"`
}

// InvoiceLineIDs maps an invoice's lines by their conversion_id metadata
// (a run, or "topup_{id}") to the line id and amount (C8 step 4).
func (c *Client) InvoiceLineIDs(invoiceID string) (map[string]InvoiceLineRef, error) {
	var page struct {
		Data []struct {
			ID       string            `json:"id"`
			Amount   int64             `json:"amount"`
			Metadata map[string]string `json:"metadata"`
		} `json:"data"`
	}
	if err := webCall(http.MethodGet, "/v1/invoices/"+url.PathEscape(invoiceID)+"/lines?limit=100", nil, "", &page); err != nil {
		return nil, err
	}
	out := map[string]InvoiceLineRef{}
	for _, l := range page.Data {
		if id := l.Metadata["conversion_id"]; id != "" {
			out[id] = InvoiceLineRef{ID: l.ID, Amount: l.Amount}
		}
	}
	return out, nil
}

// InvoiceLineRef is one invoice line a credit note can name.
type InvoiceLineRef struct {
	ID     string
	Amount int64
}

// CreditSpec is one credit note (C8 step 4): Lines (invoice line id →
// cents) when the runs are known, else an amount-only note [V11].
// RefundID links a Stripe refund; OutOfBand credits money returned
// outside Stripe (out_of_band_amount, V10).
type CreditSpec struct {
	InvoiceID string
	Amount    int64
	Lines     map[string]int64
	RefundID  string
	OutOfBand bool
	Memo      string
}

// CreateCreditNote creates it under key, with no mail (the refund mail
// is ours). Never uses refund_amount.
func (c *Client) CreateCreditNote(spec CreditSpec, key string) (*CreditNote, error) {
	form := url.Values{"invoice": {spec.InvoiceID}, "email_type": {"none"}, "metadata[env]": {c.env}}
	if len(spec.Lines) > 0 {
		ids := make([]string, 0, len(spec.Lines))
		for id := range spec.Lines {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for i, id := range ids {
			p := fmt.Sprintf("lines[%d]", i)
			form.Set(p+"[type]", "invoice_line_item")
			form.Set(p+"[invoice_line_item]", id)
			form.Set(p+"[amount]", strconv.FormatInt(spec.Lines[id], 10))
		}
	} else {
		form.Set("amount", strconv.FormatInt(spec.Amount, 10))
	}
	switch {
	case spec.OutOfBand:
		form.Set("out_of_band_amount", strconv.FormatInt(spec.Amount, 10))
	case spec.RefundID != "":
		form.Set("refunds[0][refund]", spec.RefundID)
		form.Set("refunds[0][amount_refunded]", strconv.FormatInt(spec.Amount, 10))
	}
	if spec.Memo != "" {
		form.Set("memo", spec.Memo)
	}
	var cn CreditNote
	if err := webCall(http.MethodPost, "/v1/credit_notes", form, key, &cn); err != nil {
		return nil, err
	}
	return &cn, nil
}

// CreditRefund makes an amount-only credit note for a refund on a paid
// invoice (no mail: the refund mail is ours).
func (c *Client) CreditRefund(invoiceID, refundID string, amount int64, key string) (*CreditNote, error) {
	return c.CreateCreditNote(CreditSpec{InvoiceID: invoiceID, Amount: amount, RefundID: refundID}, key)
}

// ListInvoices pages a customer's invoices, newest first.
func (c *Client) ListInvoices(customerID string, limit int, startingAfter string) ([]Invoice, bool, error) {
	q := url.Values{"customer": {customerID}, "limit": {strconv.Itoa(limit)}}
	if startingAfter != "" {
		q.Set("starting_after", startingAfter)
	}
	var page struct {
		Data    []Invoice `json:"data"`
		HasMore bool      `json:"has_more"`
	}
	if err := webCall(http.MethodGet, "/v1/invoices?"+q.Encode(), nil, "", &page); err != nil {
		return nil, false, err
	}
	return page.Data, page.HasMore, nil
}

// ListOpenInvoices pages the account's open invoices created before
// before (the void sweep filters ours by metadata).
func (c *Client) ListOpenInvoices(before time.Time, limit int) ([]Invoice, error) {
	q := url.Values{"status": {"open"}, "limit": {strconv.Itoa(limit)}, "created[lt]": {strconv.FormatInt(before.Unix(), 10)}}
	var page struct {
		Data []Invoice `json:"data"`
	}
	if err := webCall(http.MethodGet, "/v1/invoices?"+q.Encode(), nil, "", &page); err != nil {
		return nil, err
	}
	return page.Data, nil
}

// ListCreditNotes lists a customer's credit notes (newest 100).
func (c *Client) ListCreditNotes(customerID string) ([]CreditNote, error) {
	var page struct {
		Data []CreditNote `json:"data"`
	}
	if err := webCall(http.MethodGet, "/v1/credit_notes?limit=100&customer="+url.QueryEscape(customerID), nil, "", &page); err != nil {
		return nil, err
	}
	return page.Data, nil
}

func orFooter(f string) string {
	if f == "" {
		return InvoiceFooter
	}
	return f
}
