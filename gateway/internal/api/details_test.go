package api

import (
	"context"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The Files "Details" panel: started_at, free_preview_units, quick_look,
// intro on every run; the invoice (and a cached receipt) on charged runs.
func TestRunDetailsFields(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	start := time.Date(2026, 11, 7, 1, 2, 3, 0, time.UTC)
	five := 5
	c := &store.Conversion{ID: store.NewID(), UID: "u" + store.NewID(), Kind: "video", State: store.StateSucceeded,
		Params: store.Params{QuickLook: true, IntroS: &five}, FreePreview: &store.FreePreview{Units: 3}}
	c.Modal.StartedAt = &start
	c.Stripe.PIStatus, c.Stripe.PaymentIntentID = store.PISucceeded, "pi_details"
	out := s.conversionResponse(c, nil)
	if out["started_at"] != "2026-11-07T01:02:03Z" || out["free_preview_units"] != 3 || out["quick_look"] != true || out["intro"] != true {
		t.Fatalf("details %v", out)
	}
	plain := s.conversionResponse(&store.Conversion{ID: "r2"}, nil)
	if plain["started_at"] != nil || plain["free_preview_units"] != nil || plain["quick_look"] != false || plain["intro"] != false {
		t.Fatalf("plain %v", plain)
	}
	c.FreePreview.Returned = true
	if s.conversionResponse(c, nil)["free_preview_units"] != nil {
		t.Fatal("returned previews still shown")
	}
	if err := s.Store.RecordCharge(ctx, &store.Charge{UID: c.UID, Kind: store.ChargeRun, SourceID: c.ID, PaymentIntentID: "pi_details",
		AmountCents: 300, Currency: "usd", PaidAt: start}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.UpdateCharge(ctx, store.ChargeID(store.ChargeRun, c.ID), func(ch *store.Charge) error {
		ch.InvoiceID, ch.InvoiceNumber, ch.HostedInvoiceURL = "in_1", "SVS-0001", "https://invoice.stripe.com/i/x"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	receiptURLs.Store("pi_details", "https://pay.stripe.com/receipts/x")
	t.Cleanup(func() { receiptURLs.Delete("pi_details") })
	rows := []map[string]any{s.conversionResponse(c, nil), s.conversionResponse(&store.Conversion{ID: "r3"}, nil)}
	s.addPaymentDocs(ctx, rows, []*store.Conversion{c, {ID: "r3"}}, false)
	inv, _ := rows[0]["invoice"].(map[string]any)
	if inv["id"] != "in_1" || inv["number"] != "SVS-0001" || inv["hosted_url"] != "https://invoice.stripe.com/i/x" ||
		rows[0]["receipt_url"] != "https://pay.stripe.com/receipts/x" || rows[1]["invoice"] != nil || rows[1]["receipt_url"] != nil {
		t.Fatalf("papers %v / %v", rows[0], rows[1])
	}
}
