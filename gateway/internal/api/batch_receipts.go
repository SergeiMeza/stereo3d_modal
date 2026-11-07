package api

import (
	"context"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Receipts for money taken while the customer wasn't there (deferred-ready
// item 3): a paid web group, or a web group's debt a retry collected,
// gets a receipt mail (E20) listing its runs; the invoice listing every
// run comes from the charge record (C6: recordGroupCharge /
// recordSettleCharge), made after the fact and paid by attaching the
// PaymentIntent that took the money, so it never collects a second time.
// App groups keep their shipped mails (none).

// receiptRunsShown is how many runs the mail names before "and N more".
const receiptRunsShown = 3

// mailGroupReceipt is E20 for a paid web group.
func (s *Service) mailGroupReceipt(ctx context.Context, b *store.Batch) {
	if b == nil || b.State != store.BatchPaid || b.ChargedCents <= 0 || b.SettleID != "" || !webBatch(b) {
		return // a settle that paid it sends its own
	}
	runs := make([]receiptRun, 0, len(b.Items))
	for _, it := range b.Items {
		runs = append(runs, receiptRun{ID: it.ConversionID, Cents: it.AmountCents, Fallback: it.Description})
	}
	s.mailReceipt(ctx, "E20_"+b.ID, b.UID, b.ChargedCents, runs)
}

// mailSettleReceipt is E20 for a debt a web retry collected.
func (s *Service) mailSettleReceipt(ctx context.Context, st *store.Settle) {
	if st == nil || st.State != store.SettlePaid || st.PaidCents <= 0 || st.PaidWith == "balance" {
		return
	}
	var runs []receiptRun
	for _, it := range st.Items {
		if it.Kind == "run" {
			runs = append(runs, receiptRun{ID: it.ID, Cents: it.AmountCents})
			continue
		}
		amounts := map[string]int64{}
		if b, err := s.Store.GetBatch(ctx, it.ID); err == nil {
			for _, bi := range b.Items {
				amounts[bi.ConversionID] = bi.AmountCents
			}
		}
		for _, cid := range it.ConversionIDs {
			runs = append(runs, receiptRun{ID: cid, Cents: amounts[cid]})
		}
	}
	s.mailReceipt(ctx, "E20_"+st.ID, st.UID, st.PaidCents, runs)
}

type receiptRun struct {
	ID       string
	Cents    int64
	Fallback string
}

func (s *Service) mailReceipt(ctx context.Context, key, uid string, cents int64, runs []receiptRun) {
	if len(runs) == 0 {
		return
	}
	s.mailCustomer(ctx, key, uid, s.accountEmail(ctx, uid), receiptMail(money(cents), s.receiptLines(ctx, runs), s.Cfg.SiteURL+"/billing"))
}

// receiptLines: each paid 3D video (name, Lifelike or Classic) and its
// amount.
func (s *Service) receiptLines(ctx context.Context, runs []receiptRun) []receiptLine {
	out := make([]receiptLine, 0, len(runs))
	for _, r := range runs {
		line := receiptLine{Run: runInfo{Name: r.Fallback}}
		cents := r.Cents
		if c, err := s.Store.GetConversion(ctx, r.ID); err == nil {
			line.Run = s.runMailInfo(ctx, c)
			if cents == 0 {
				cents = runCardCents(c)
			}
		}
		line.Amount = money(cents)
		out = append(out, line)
	}
	return out
}
