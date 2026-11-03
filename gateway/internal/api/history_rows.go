package api

import (
	"context"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Purchase history rows (spec v6 F, P10): one row per statement charge —
// a run paid on its own, an after-done group, a settle — newest first,
// plus one "Payment needed" row on top while the account owes. Refunds
// are their own rows. A row's id is its charge id (run_…, group_…,
// settle_…), so its invoice comes from charges_{env}. Paging:
// ?limit=25&starting_after={row_id} → has_more.

type rowItem struct {
	ConversionID string `json:"conversion_id"`
	ProjectID    string `json:"project_id"`
	ProjectName  string `json:"project_name,omitempty"`
	Step         string `json:"step,omitempty"`
	Preset       string `json:"preset,omitempty"`
	FromFrame    int    `json:"from_frame,omitempty"`
	ToFrame      int    `json:"to_frame,omitempty"`
	AmountCents  int64  `json:"amount_cents"`
}

type historyRow struct {
	RowID         string            `json:"row_id"`
	Kind          string            `json:"kind"` // charge | refund | outstanding
	CreatedAt     time.Time         `json:"created_at"`
	AmountCents   int64             `json:"amount_cents"` // negative for refunds
	Currency      string            `json:"currency"`
	Status        string            `json:"status"`
	PaymentMethod map[string]string `json:"payment_method,omitempty"`
	Invoice       map[string]string `json:"invoice,omitempty"`
	ReceiptURL    string            `json:"receipt_url,omitempty"`
	CreditNoteURL string            `json:"credit_note_url,omitempty"`
	HelpRef       string            `json:"help_ref"`
	CaseID        string            `json:"case_id,omitempty"`
	Items         []rowItem         `json:"items"`

	chargeID string // charges_{env} id for the invoice ("" for none)
	pi       string
	convIDs  []string          // filled into Items by enrichRows
	amounts  map[string]int64  // per-run cents within a group or settle
	ownItems map[string]string // conversion → project (a run row)
}

// historyRows builds the rows from the account's records (pure; Stripe
// and project details come in enrichRows).
func historyRows(batches []*store.Batch, settles []*store.Settle, convs []*store.Conversion) []historyRow {
	var out []historyRow
	settlePI := map[string]string{}
	for _, st := range settles {
		if st.State != store.SettlePaid || st.PaidCents <= 0 {
			continue
		}
		settlePI[st.ID] = st.PaymentIntentID
		r := historyRow{RowID: store.ChargeID(store.ChargeSettle, st.ID), Kind: "charge", Currency: orUSD(st.Currency),
			AmountCents: st.PaidCents, Status: "paid", pi: st.PaymentIntentID, amounts: map[string]int64{},
			CreatedAt: firstTime(st.PaidAt, &st.UpdatedAt)}
		r.chargeID = r.RowID
		for _, it := range st.Items {
			if it.Kind == "run" {
				r.convIDs = append(r.convIDs, it.ID)
				r.amounts[it.ID] = it.AmountCents
			} else {
				r.convIDs = append(r.convIDs, it.ConversionIDs...)
			}
		}
		out = append(out, r)
	}
	for _, b := range batches {
		if b.SettleID != "" && b.State == store.BatchPaid {
			continue // its settle's row lists it
		}
		r := historyRow{RowID: store.ChargeID(store.ChargeGroup, b.ID), Kind: "charge", Currency: orUSD(b.Currency),
			AmountCents: b.TotalCents, pi: b.PaymentIntentID, amounts: map[string]int64{}}
		switch {
		case b.State == store.BatchPaid:
			r.Status, r.chargeID = "paid", r.RowID
			if b.ChargedCents > 0 {
				r.AmountCents = b.ChargedCents
			}
		case b.State == store.BatchCharging && b.PIStatus == store.PIProcessing:
			r.Status = "processing"
		default:
			continue // open, charging, failed (the outstanding row), closed
		}
		for _, it := range b.Items {
			r.convIDs = append(r.convIDs, it.ConversionID)
			r.amounts[it.ConversionID] = it.AmountCents
		}
		r.CreatedAt = firstTime(b.ChargedAt, b.ClosedAt, &b.UpdatedAt)
		out = append(out, r)
	}
	for _, c := range convs {
		if c.Stripe.BatchID != "" || c.Stripe.PaymentIntentID == "" {
			continue
		}
		if pi, ok := settlePI[c.Stripe.SettleID]; ok && pi == c.Stripe.PaymentIntentID {
			continue // paid by its settle
		}
		r := historyRow{RowID: store.ChargeID(store.ChargeRun, c.ID), Kind: "charge", Currency: orUSD(c.Quote.Currency),
			AmountCents: c.Stripe.CapturedCents, pi: c.Stripe.PaymentIntentID, convIDs: []string{c.ID},
			amounts: map[string]int64{}, CreatedAt: firstTime(c.Stripe.CapturedAt, &c.CreatedAt)}
		var refund *historyRow
		switch c.Stripe.PIStatus {
		case store.PISucceeded:
			if c.State == store.StateSucceeded {
				r.chargeID = r.RowID
			}
			r.Status = "paid"
		case store.PIProcessing:
			r.Status, r.AmountCents = "processing", c.Quote.AmountCents
		case store.PIRefunded:
			r.Status, r.chargeID = "refunded", r.RowID
			if c.Stripe.RefundedCents < c.Stripe.CapturedCents {
				r.Status = "partially_refunded"
			}
			refund = &historyRow{Status: "refunded", AmountCents: -c.Stripe.RefundedCents,
				CreatedAt: firstTime(c.Stripe.RefundedAt, &c.UpdatedAt)}
		case store.PIRefundFailed, store.PICancelPending:
			if c.Stripe.CapturedCents <= 0 {
				continue
			}
			r.Status = "paid"
			refund = &historyRow{Status: "processing", AmountCents: -c.Stripe.CapturedCents, CreatedAt: c.UpdatedAt}
		default:
			continue
		}
		if r.AmountCents <= 0 {
			continue
		}
		r.amounts[c.ID] = r.AmountCents
		out = append(out, r)
		if refund != nil {
			refund.RowID, refund.Kind, refund.Currency, refund.pi = "refund_"+c.ID, "refund", r.Currency, r.pi
			refund.chargeID, refund.convIDs = r.chargeID, r.convIDs
			refund.amounts = map[string]int64{c.ID: -refund.AmountCents}
			out = append(out, *refund)
		}
	}
	slices.SortFunc(out, func(a, b historyRow) int {
		if c := b.CreatedAt.Compare(a.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(b.RowID, a.RowID)
	})
	return out
}

// pageRows returns the rows after startingAfter ("" = the first page).
func pageRows(all []historyRow, startingAfter string, limit int) ([]historyRow, bool) {
	start := 0
	if startingAfter != "" {
		start = len(all)
		for i, r := range all {
			if r.RowID == startingAfter {
				start = i + 1
				break
			}
		}
	}
	end := min(start+limit, len(all))
	return all[start:end], end < len(all)
}

// enrichRows fills a page: runs and project names, invoices and credit
// notes from the charge records, receipt and payment method from Stripe
// (bounded fan-out; a failed lookup leaves those empty).
func (s *Service) enrichRows(ctx context.Context, page []historyRow) {
	convs := map[string]*store.Conversion{}
	names := map[string]string{}
	var chargeIDs []string
	for i := range page {
		r := &page[i]
		r.HelpRef = strings.ToUpper(r.RowID)
		if r.chargeID != "" {
			chargeIDs = append(chargeIDs, r.chargeID)
		}
		r.Items = make([]rowItem, 0, len(r.convIDs))
		for _, id := range r.convIDs {
			c, ok := convs[id]
			if !ok {
				c, _ = s.Store.GetConversion(ctx, id)
				convs[id] = c
			}
			it := rowItem{ConversionID: id, AmountCents: r.amounts[id]}
			if c != nil {
				it.ProjectID, it.Step, it.FromFrame, it.ToFrame = c.ProjectID, c.Step, c.Params.FromFrame, c.Params.ToFrame
				it.Preset = c.Params.Preset
				if it.AmountCents == 0 {
					it.AmountCents = c.Quote.AmountCents
				}
				if it.Step == "" {
					it.Step = store.StepProduction
				}
			}
			if it.ProjectID != "" {
				n, ok := names[it.ProjectID]
				if !ok {
					if p, err := s.Store.GetProject(ctx, it.ProjectID); err == nil && !p.Deleted {
						n = p.Name
					}
					names[it.ProjectID] = n
				}
				it.ProjectName = n
			}
			r.Items = append(r.Items, it)
		}
	}
	if charges, err := s.Store.GetCharges(ctx, chargeIDs); err == nil {
		for i := range page {
			ch := charges[page[i].chargeID]
			if ch == nil {
				continue
			}
			if page[i].Kind == "charge" && ch.InvoiceState == store.InvoiceDone && ch.HostedInvoiceURL != "" {
				page[i].Invoice = map[string]string{"hosted_invoice_url": ch.HostedInvoiceURL, "invoice_pdf": ch.InvoicePDF}
			}
			if page[i].Kind == "refund" && len(ch.CreditNotes) > 0 {
				page[i].CreditNoteURL = ch.CreditNotes[len(ch.CreditNotes)-1].PDF
			}
		}
	}
	var mu sync.Mutex
	details := map[string]*stripex.ChargeInfo{}
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i := range page {
		pi := page[i].pi
		if pi == "" || page[i].Kind == "outstanding" {
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
			details[pi] = info
			mu.Unlock()
		}(pi)
	}
	wg.Wait()
	for i := range page {
		d := details[page[i].pi]
		if d == nil {
			continue
		}
		page[i].ReceiptURL = d.ReceiptURL
		if l := methodLabel(&d.Method); l != "" && d.Method.Type != "" {
			page[i].PaymentMethod = map[string]string{"label": l}
		}
	}
}

// outstandingRow is the "Payment needed" row while the account owes: the
// live settle's frozen amount when one is open.
func (s *Service) outstandingRow(ctx context.Context, uid string, batches []*store.Batch, convs []*store.Conversion) *historyRow {
	owed := s.owedCents(ctx, uid)
	if owed <= 0 {
		return nil
	}
	r := &historyRow{RowID: "outstanding", Kind: "outstanding", Status: "payment_needed", AmountCents: owed, Currency: "usd",
		CreatedAt: time.Now().UTC(), amounts: map[string]int64{}}
	if live, err := s.Store.LiveSettle(ctx, uid); err == nil && live != nil {
		r.AmountCents = live.AmountCents
	}
	for _, b := range batches {
		if b.State == store.BatchFailed || b.State == store.BatchSettling {
			for _, it := range b.Items {
				r.convIDs = append(r.convIDs, it.ConversionID)
				r.amounts[it.ConversionID] = it.AmountCents
			}
		}
	}
	for _, c := range convs {
		if c.Stripe.BatchID == "" && (c.Stripe.PIStatus == store.PIChargeFailed || c.Stripe.PIStatus == store.PISettling) {
			r.convIDs = append(r.convIDs, c.ID)
			r.amounts[c.ID] = c.Quote.AmountCents
		}
	}
	return r
}
