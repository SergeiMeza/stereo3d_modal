package api

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// addPaymentDocs adds each charged run's papers for the Details panel:
// invoice {id, number, hosted_url, pdf_url} (our Stripe invoice for the
// charge that paid it: the run's own, its after-done group's or its
// settle's) and receipt_url (Stripe's receipt). The invoice comes from
// our charge records in one read; the receipt from Stripe, on the single
// run read only (lists use the cache), and is cached for good (a paid
// charge's receipt link doesn't change). Null when not charged or not
// known yet.
func (s *Service) addPaymentDocs(ctx context.Context, out []map[string]any, convs []*store.Conversion, fetchReceipt bool) {
	if s.Store == nil || len(out) != len(convs) {
		return
	}
	ids := make([]string, 0, len(convs))
	chargeOf := make([]string, len(convs))
	for i, c := range convs {
		out[i]["invoice"], out[i]["receipt_url"] = nil, nil
		if c == nil || c.Sample || c.Stripe.PIStatus != store.PISucceeded {
			continue
		}
		switch {
		case c.Stripe.SettleID != "":
			chargeOf[i] = store.ChargeID(store.ChargeSettle, c.Stripe.SettleID)
		case c.Stripe.BatchID != "":
			chargeOf[i] = store.ChargeID(store.ChargeGroup, c.Stripe.BatchID)
		default:
			chargeOf[i] = store.ChargeID(store.ChargeRun, c.ID)
		}
		ids = append(ids, chargeOf[i])
	}
	if len(ids) == 0 {
		return
	}
	charges, err := s.Store.GetCharges(ctx, ids)
	if err != nil {
		slog.WarnContext(ctx, "run papers unread", "err", err)
		return
	}
	for i := range convs {
		ch := charges[chargeOf[i]]
		if ch == nil {
			continue
		}
		if ch.InvoiceID != "" {
			out[i]["invoice"] = map[string]any{"id": ch.InvoiceID, "number": nilIfEmpty(ch.InvoiceNumber),
				"hosted_url": nilIfEmpty(ch.HostedInvoiceURL), "pdf_url": nilIfEmpty(ch.InvoicePDF)}
		}
		if ch.PaymentIntentID == "" {
			continue
		}
		if u, ok := receiptURLs.Load(ch.PaymentIntentID); ok {
			out[i]["receipt_url"] = u
			continue
		}
		if fetchReceipt && s.Stripe != nil {
			if u := s.receiptURL(ctx, ch.PaymentIntentID); u != "" {
				out[i]["receipt_url"] = u
			}
		}
	}
}

// receiptURLs: payment intent → Stripe receipt link (never changes).
var receiptURLs sync.Map

func (s *Service) receiptURL(ctx context.Context, pi string) string {
	if !stripex.IsPaymentIntentID(pi) {
		return "" // paid from the balance: no Stripe receipt
	}
	done := make(chan string, 1)
	go func() {
		info, err := s.Stripe.ChargeDetails(pi)
		if err != nil || info == nil || info.ReceiptURL == "" {
			done <- ""
			return
		}
		receiptURLs.Store(pi, info.ReceiptURL)
		done <- info.ReceiptURL
	}()
	select {
	case u := <-done:
		return u
	case <-time.After(3 * time.Second): // the read never waits long on Stripe
		return ""
	case <-ctx.Done():
		return ""
	}
}
