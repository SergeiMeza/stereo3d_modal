package api

import (
	"context"
	"log/slog"
	"slices"
	"sort"
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
	// CampaignCents / CampaignLabel: the launch offer's line on this run
	// (0 and absent without one).
	CampaignCents int64  `json:"campaign_cents"`
	CampaignLabel string `json:"campaign_label,omitempty"`
}

type historyRow struct {
	RowID         string            `json:"row_id"`
	Kind          string            `json:"kind"` // charge | refund | outstanding | plan | plan_change | credit
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
	Label         string            `json:"label,omitempty"` // "Balance top-up · $25.00", "Business plan · monthly"
	// Presentment: what the card paid in the customer's currency under
	// Adaptive Pricing, {amount_minor, currency}; null when USD, unknown
	// or not a card payment. amount_cents stays USD.
	Presentment *store.Presentment `json:"presentment"`
	Items       []rowItem          `json:"items"`
	// Plans (kind plan | plan_change | credit, owner bug 2026-11-05).
	Plan   *planRowInfo    `json:"plan,omitempty"`
	Lines  []planLine      `json:"lines,omitempty"`
	Change *planChangeInfo `json:"change,omitempty"`
	Credit *creditInfo     `json:"credit,omitempty"`

	chargeID string // charges_{env} id for the invoice ("" for none)
	pi       string
	convIDs  []string          // filled into Items by enrichRows
	amounts  map[string]int64  // per-run cents within a group or settle
	ownItems map[string]string // conversion → project (a run row)
}

// historyRows builds the rows from the account's records (pure; Stripe
// and project details come in enrichRows).
func historyRows(batches []*store.Batch, settles []*store.Settle, convs []*store.Conversion, topups ...*store.Topup) []historyRow {
	var out []historyRow
	for _, t := range topups { // v7 N3.5: each top-up is a row
		if t.State != store.TopupPaid || t.PaidCents <= 0 {
			continue
		}
		r := historyRow{RowID: store.ChargeID(store.ChargeTopup, t.ID), Kind: "charge", Currency: "usd", AmountCents: t.PaidCents,
			Status: "paid", pi: t.PaymentIntentID, Label: "Balance top-up · " + money(t.PaidCents), amounts: map[string]int64{}, Presentment: t.Presentment,
			CreatedAt: firstTime(t.PaidAt, &t.UpdatedAt)}
		r.chargeID = r.RowID
		out = append(out, r)
	}
	settlePI := map[string]string{}
	for _, st := range settles {
		if st.State != store.SettlePaid || st.PaidCents <= 0 {
			continue
		}
		settlePI[st.ID] = st.PaymentIntentID
		r := historyRow{RowID: store.ChargeID(store.ChargeSettle, st.ID), Kind: "charge", Currency: orUSD(st.Currency),
			AmountCents: st.PaidCents, Status: "paid", pi: st.PaymentIntentID, amounts: map[string]int64{}, Presentment: st.Presentment,
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
			amounts: map[string]int64{}, CreatedAt: firstTime(c.Stripe.CapturedAt, &c.CreatedAt), Presentment: c.Stripe.Presentment}
		if c.Stripe.PIStatus == store.PIProcessing {
			r.Presentment = nil // not paid yet: no amount to show
		}
		var refund *historyRow
		switch c.Stripe.PIStatus {
		case store.PISucceeded:
			if c.State == store.StateSucceeded {
				r.chargeID = r.RowID
			}
			r.Status = "paid"
		case store.PIProcessing:
			r.Status, r.AmountCents = "processing", runCardCents(c)
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
	return sortRows(out)
}

// sortRows: newest first, then by row id.
func sortRows(out []historyRow) []historyRow {
	slices.SortFunc(out, func(a, b historyRow) int {
		if c := b.CreatedAt.Compare(a.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(b.RowID, a.RowID)
	})
	return out
}

// filterRows keeps one kind of row: filter=plan (plan, plan_change,
// credit) or runs (charge, refund, outstanding); "" or all = every row.
func filterRows(all []historyRow, filter string) []historyRow {
	var kinds []string
	switch filter {
	case "plan", "plans":
		kinds = []string{"plan", "plan_change", "credit"}
	case "runs":
		kinds = []string{"charge", "refund", "outstanding"}
	default:
		return all
	}
	return slices.DeleteFunc(all, func(r historyRow) bool { return !slices.Contains(kinds, r.Kind) })
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
				it.CampaignCents, it.CampaignLabel = campaignLine(c)
				if it.AmountCents == 0 {
					it.AmountCents = runCardCents(c)
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
			r.amounts[c.ID] = runCardCents(c)
		}
	}
	return r
}

// applyCases folds the refund ledger and cases into the rows (spec F,
// C13 customer view): each ledger refund is its own row (replacing the
// run-derived one), charges read refunded / partially_refunded, a
// customer-visible open case reads refund_requested (with case_id), an
// open dispute disputed, an open refund_failed case refund_failed.
func (s *Service) applyCases(ctx context.Context, uid string, rows []historyRow) []historyRow {
	if s.Store == nil {
		return rows
	}
	ledger, _ := s.Store.ListUserRefundRows(ctx, uid, 500)
	cases, _ := s.Store.ListUserCases(ctx, uid, 300)
	byPI := map[string][]*store.RefundRow{}
	for _, r := range ledger {
		if r.Counts() {
			byPI[r.PI] = append(byPI[r.PI], r)
		}
	}
	var out []historyRow
	for _, r := range rows {
		if r.Kind == "refund" && len(byPI[r.pi]) > 0 {
			continue // the ledger rows below replace it
		}
		out = append(out, r)
	}
	for i := range out {
		r := &out[i]
		if r.Kind != "charge" || r.pi == "" {
			continue
		}
		var back int64
		for _, lr := range byPI[r.pi] {
			back += lr.TotalCents
			st := "refunded"
			if lr.Status == store.RefundPending {
				st = "processing"
			}
			ref := historyRow{RowID: "refund_" + lr.ID, Kind: "refund", CreatedAt: lr.CreatedAt, AmountCents: -lr.TotalCents,
				Currency: r.Currency, Status: st, pi: r.pi, chargeID: r.chargeID, CaseID: caseIDIfVisible(cases, lr.CaseID),
				amounts: map[string]int64{}}
			for id, c := range lr.Items {
				if id != store.UnassignedRefund && !strings.HasPrefix(id, "topup_") && id != "payment" {
					ref.convIDs = append(ref.convIDs, id)
					ref.amounts[id] = c
				}
			}
			ref.Label = r.Label
			out = append(out, ref)
		}
		switch {
		case back >= r.AmountCents && back > 0:
			r.Status = "refunded"
		case back > 0:
			r.Status = "partially_refunded"
		}
		for _, c := range cases {
			if !c.Open || !contains(c.Related.PIIDs, r.pi) {
				continue
			}
			switch {
			case c.Type == store.CaseDispute:
				r.Status = "disputed"
			case c.Reason == ReasonRefundFailed:
				r.Status, r.CaseID = "refund_failed", c.ID
			case c.CustomerVisible && r.Status != "disputed":
				r.Status, r.CaseID = "refund_requested", c.ID
			}
		}
	}
	sort.SliceStable(out, func(a, b int) bool {
		if !out[a].CreatedAt.Equal(out[b].CreatedAt) {
			return out[a].CreatedAt.After(out[b].CreatedAt) // newest first
		}
		return out[a].RowID > out[b].RowID
	})
	return out
}

func caseIDIfVisible(cases []*store.Case, id string) string {
	for _, c := range cases {
		if c.ID == id && c.CustomerVisible {
			return id
		}
	}
	return ""
}
