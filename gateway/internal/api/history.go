package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// GET /v1/billing/history — the Billing page's purchase history (S3D-57):
// one entry per card charge as it shows on the statement, newest first.
//
//   - A grouped (batch) charge lists every run it covered; a pre-charge or
//     a single per-run charge lists its run. Failed and still-running
//     charges are listed too (status failed / pending); an open batch that
//     hasn't been charged yet is not.
//   - A refund is its own entry: type "refund", a NEGATIVE amount_cents,
//     refund_of naming the charge entry, status refunded (or pending while
//     it is on its way). The charge entry itself then reads refunded (or
//     partially_refunded).
//
// Query: limit (default 20, max 100) and cursor (the previous page's
// next_cursor). Receipt links and the card come from Stripe, page by page.

const (
	historyScanLimit   = 500 // per source query; ample for one account
	historyDefaultPage = 25
	historyMaxPage     = 100
)

type historyItem struct {
	ProjectID    string `json:"project_id,omitempty"`
	ProjectName  string `json:"project_name,omitempty"`
	Step         string `json:"step"` // preview | production | photo (mobile stills)
	Method       string `json:"method"`
	Quality      string `json:"quality,omitempty"`
	AmountCents  int64  `json:"amount_cents"`
	ConversionID string `json:"conversion_id"`
}

type historyEntry struct {
	ID          string        `json:"id"`
	Type        string        `json:"type"` // charge | refund
	RefundOf    string        `json:"refund_of,omitempty"`
	CreatedAt   time.Time     `json:"created_at"`
	AmountCents int64         `json:"amount_cents"` // negative for refunds
	Currency    string        `json:"currency"`
	CardBrand   string        `json:"card_brand,omitempty"`
	CardLast4   string        `json:"card_last4,omitempty"`
	Status      string        `json:"status"` // paid | refunded | partially_refunded | failed | pending
	ReceiptURL  string        `json:"receipt_url,omitempty"`
	Items       []historyItem `json:"items"`

	paymentIntentID string
	batchItems      []store.BatchItem // filled into Items for the page only
}

func (s *Service) HandleBillingHistory(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	limit := historyDefaultPage
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 {
		limit = min(v, historyMaxPage)
	}
	var batches []*store.Batch
	for _, state := range []string{store.BatchPaid, store.BatchFailed, store.BatchCharging, store.BatchSettling} {
		bs, err := s.Store.ListUserBatchesByState(ctx, user.UID, state, historyScanLimit)
		if err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
		batches = append(batches, bs...)
	}
	var convs []*store.Conversion
	for _, pi := range []string{store.PISucceeded, store.PIRefunded, store.PIRefundFailed,
		store.PIChargeFailed, store.PICancelPending, store.PIProcessing, store.PISettling} {
		cs, err := s.Store.ListUserByPIStatus(ctx, user.UID, pi, historyScanLimit)
		if err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
		convs = append(convs, cs...)
	}
	// Older clients: entries + next_cursor (statement entries as before;
	// runs a settle is collecting aren't listed there).
	var legacy []*store.Conversion
	for _, c := range convs {
		if c.Stripe.PIStatus != store.PIProcessing && c.Stripe.PIStatus != store.PISettling {
			legacy = append(legacy, c)
		}
	}
	var legacyBatches []*store.Batch
	for _, b := range batches {
		if b.State != store.BatchSettling {
			legacyBatches = append(legacyBatches, b)
		}
	}
	page, next := paginateHistory(historyEntries(legacyBatches, legacy), r.URL.Query().Get("cursor"), limit)
	s.enrichHistory(ctx, page)
	resp := map[string]any{"entries": page}
	if next != "" {
		resp["next_cursor"] = next
	}
	// spec v6 F: rows (+ has_more), paged by starting_after.
	settles, err := s.Store.ListUserSettles(ctx, user.UID, store.SettlePaid, historyScanLimit)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	topups, err := s.Store.ListUserTopups(ctx, user.UID, historyScanLimit)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	all := s.applyCases(ctx, user.UID, historyRows(batches, settles, convs, topups...))
	after := r.URL.Query().Get("starting_after")
	if after == "" {
		if out := s.outstandingRow(ctx, user.UID, batches, convs); out != nil {
			all = append([]historyRow{*out}, all...)
		}
	}
	rows, more := pageRows(all, after, limit)
	s.enrichRows(ctx, rows)
	if rows == nil {
		rows = []historyRow{}
	}
	resp["rows"], resp["has_more"] = rows, more
	resp["tax"] = "off"
	if s.rates(ctx).TaxInclusive() {
		resp["tax"] = "inclusive"
	}
	httpx.WriteOK(w, resp)
}

// historyEntries turns the account's charged batches and individually
// charged conversions into statement entries, newest first (pure: the
// Stripe and project details are added for the page by enrichHistory).
func historyEntries(batches []*store.Batch, convs []*store.Conversion) []historyEntry {
	var out []historyEntry
	for _, b := range batches {
		e := historyEntry{
			ID: "batch_" + b.ID, Type: "charge", Currency: b.Currency,
			AmountCents: b.TotalCents, paymentIntentID: b.PaymentIntentID, batchItems: b.Items,
		}
		switch b.State {
		case store.BatchPaid:
			e.Status = "paid"
			if b.ChargedCents > 0 {
				e.AmountCents = b.ChargedCents
			}
		case store.BatchFailed:
			e.Status = "failed"
		case store.BatchCharging:
			e.Status = "pending"
		default:
			continue // open: not charged yet
		}
		e.CreatedAt = firstTime(b.ChargedAt, b.ClosedAt, &b.UpdatedAt)
		out = append(out, e)
	}
	for _, c := range convs {
		if c.Stripe.BatchID != "" {
			continue // its grouped charge lists it
		}
		e := historyEntry{
			ID: "conv_" + c.ID, Type: "charge", Currency: c.Quote.Currency,
			AmountCents: c.Stripe.CapturedCents, paymentIntentID: c.Stripe.PaymentIntentID,
			Items:     []historyItem{itemFor(c, "")},
			CreatedAt: firstTime(c.Stripe.CapturedAt, &c.CreatedAt),
		}
		var refund *historyEntry
		switch c.Stripe.PIStatus {
		case store.PISucceeded:
			if c.Stripe.PaymentIntentID == "" {
				continue // nothing went through the card
			}
			e.Status = "paid"
		case store.PIChargeFailed:
			e.Status, e.AmountCents = "failed", c.Quote.AmountCents
			e.CreatedAt = c.UpdatedAt
		case store.PIRefunded:
			e.Status = "refunded"
			if c.Stripe.RefundedCents < c.Stripe.CapturedCents {
				e.Status = "partially_refunded"
			}
			refund = &historyEntry{Status: "refunded", AmountCents: -c.Stripe.RefundedCents,
				CreatedAt: firstTime(c.Stripe.RefundedAt, &c.UpdatedAt)}
		case store.PIRefundFailed, store.PICancelPending:
			if c.Stripe.CapturedCents <= 0 || c.Stripe.PaymentIntentID == "" {
				continue // a hold released or a run never charged: no statement line
			}
			e.Status = "paid"
			refund = &historyEntry{Status: "pending", AmountCents: -c.Stripe.CapturedCents, CreatedAt: c.UpdatedAt}
		default:
			continue
		}
		if e.AmountCents <= 0 {
			continue
		}
		out = append(out, e)
		if refund != nil {
			refund.ID, refund.Type, refund.RefundOf = "refund_"+c.ID, "refund", e.ID
			refund.Currency, refund.paymentIntentID = e.Currency, e.paymentIntentID
			refund.Items = e.Items
			out = append(out, *refund)
		}
	}
	slices.SortFunc(out, func(a, b historyEntry) int {
		if c := b.CreatedAt.Compare(a.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(b.ID, a.ID)
	})
	return out
}

func firstTime(ts ...*time.Time) time.Time {
	for _, t := range ts {
		if t != nil && !t.IsZero() {
			return *t
		}
	}
	return time.Time{}
}

// historyCursor encodes an entry's place in the order.
func historyCursor(e historyEntry) string {
	return strconv.FormatInt(e.CreatedAt.UnixNano(), 10) + "_" + e.ID
}

// paginateHistory returns the page after cursor ("" = the first) and the
// next page's cursor ("" = this was the last).
func paginateHistory(all []historyEntry, cursor string, limit int) ([]historyEntry, string) {
	start := 0
	if cursor != "" {
		start = len(all)
		for i, e := range all {
			if historyCursor(e) == cursor {
				start = i + 1
				break
			}
		}
	}
	end := min(start+limit, len(all))
	page := all[start:end]
	if end < len(all) && len(page) > 0 {
		return page, historyCursor(page[len(page)-1])
	}
	return page, ""
}

// itemFor is one run on a statement line; amount 0 takes the run's quote.
func itemFor(c *store.Conversion, projectName string) historyItem {
	step := "production"
	switch {
	case c.Step == store.StepDepthPreview || c.Step == store.StepStereoPreview || c.Step == store.StepLifelikePreview:
		step = "preview"
	case c.Step == "" && c.Kind == "image":
		step = "photo"
	}
	quality := c.Params.Quality
	if quality == "" {
		quality = c.Params.Preset
	}
	return historyItem{
		ProjectID: c.ProjectID, ProjectName: projectName, Step: step,
		Method: store.MethodOr(c.Method), Quality: quality,
		AmountCents: c.Quote.AmountCents, ConversionID: c.ID,
	}
}

// enrichHistory fills a page: each grouped charge's runs, project names,
// and the receipt link and card from Stripe (bounded fan-out; a failed
// lookup leaves those fields empty rather than failing the page).
func (s *Service) enrichHistory(ctx context.Context, page []historyEntry) {
	convCache := map[string]*store.Conversion{}
	nameCache := map[string]string{}
	projectName := func(id string) string {
		if id == "" {
			return ""
		}
		if n, ok := nameCache[id]; ok {
			return n
		}
		n := ""
		if p, err := s.Store.GetProject(ctx, id); err == nil && !p.Deleted {
			n = p.Name
		}
		nameCache[id] = n
		return n
	}
	for i := range page {
		e := &page[i]
		if e.batchItems != nil {
			e.Items = make([]historyItem, 0, len(e.batchItems))
			for _, bi := range e.batchItems {
				c, ok := convCache[bi.ConversionID]
				if !ok {
					c, _ = s.Store.GetConversion(ctx, bi.ConversionID)
					convCache[bi.ConversionID] = c
				}
				item := historyItem{ProjectID: bi.ProjectID, Step: "production", Method: store.MethodClassic,
					AmountCents: bi.AmountCents, ConversionID: bi.ConversionID}
				if c != nil {
					item = itemFor(c, "")
					item.AmountCents = bi.AmountCents
				}
				item.ProjectName = projectName(item.ProjectID)
				e.Items = append(e.Items, item)
			}
		} else {
			for j := range e.Items {
				e.Items[j].ProjectName = projectName(e.Items[j].ProjectID)
			}
		}
		if e.Items == nil {
			e.Items = []historyItem{}
		}
	}
	var mu sync.Mutex
	details := map[string]*historyEntry{}
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i := range page {
		pi := page[i].paymentIntentID
		if pi == "" {
			continue
		}
		mu.Lock()
		_, seen := details[pi]
		details[pi] = nil
		mu.Unlock()
		if seen {
			continue
		}
		wg.Add(1)
		go func(pi string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			info, err := s.Stripe.ChargeDetails(pi)
			if err != nil {
				slog.WarnContext(ctx, "billing history: charge lookup failed", "payment_intent", pi, "err", err)
				return
			}
			mu.Lock()
			details[pi] = &historyEntry{ReceiptURL: info.ReceiptURL, CardBrand: info.CardBrand, CardLast4: info.CardLast4}
			mu.Unlock()
		}(pi)
	}
	wg.Wait()
	for i := range page {
		if d := details[page[i].paymentIntentID]; d != nil {
			page[i].ReceiptURL, page[i].CardBrand, page[i].CardLast4 = d.ReceiptURL, d.CardBrand, d.CardLast4
		}
	}
}

// String helps logs and tests.
func (e historyEntry) String() string {
	return fmt.Sprintf("%s %s %d %s", e.ID, e.Type, e.AmountCents, e.Status)
}
