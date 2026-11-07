package api

import (
	"context"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Owner bug 2026-11-07: a debt paid from the balance is recorded with
// payment intent "balance:<settle>", and billing history asked Stripe for
// it (404 in the logs). Such rows come from our ledger: no Stripe read,
// "Balance" as the method, no receipt; card rows still read Stripe.
func TestHistoryBalancePaidRows(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	now := time.Now()
	fake.addSession("cs_card", "complete", "succeeded") // pi_cs_card
	settle := &store.Settle{ID: "s1", State: store.SettlePaid, PaidCents: 1200, PaymentIntentID: "balance:s1", PaidWith: "balance", PaidAt: &now}
	inSettle := &store.Conversion{ID: "c1", State: store.StateSucceeded, Stripe: store.Stripe{SettleID: "s1", PaymentIntentID: "balance:s1",
		PIStatus: store.PISucceeded, CapturedCents: 1200, CapturedAt: &now}}
	// a run carrying the balance id without its settle on the page
	alone := &store.Conversion{ID: "c2", State: store.StateSucceeded, Stripe: store.Stripe{SettleID: "s9", PaymentIntentID: "balance:s9",
		PIStatus: store.PISucceeded, CapturedCents: 700, CapturedAt: &now}}
	card := &store.Conversion{ID: "c3", State: store.StateSucceeded, Stripe: store.Stripe{PaymentIntentID: "pi_cs_card",
		PIStatus: store.PISucceeded, CapturedCents: 3000, CapturedAt: &now}}
	rows := historyRows(nil, []*store.Settle{settle}, []*store.Conversion{inSettle, alone, card})
	s.enrichRows(ctx, rows)
	byID := map[string]historyRow{}
	for _, r := range rows {
		byID[r.RowID] = r
	}
	if len(rows) != 3 || byID[store.ChargeID(store.ChargeRun, "c1")].RowID != "" {
		t.Fatalf("rows %v", byID)
	}
	for _, id := range []string{store.ChargeID(store.ChargeSettle, "s1"), store.ChargeID(store.ChargeRun, "c2")} {
		r := byID[id]
		if r.PaymentMethod["label"] != "Balance" || r.ReceiptURL != "" || r.Presentment != nil || r.Status != "paid" {
			t.Fatalf("%s: %+v", id, r)
		}
	}
	for _, id := range fake.piReads {
		if !strings.HasPrefix(id, "pi_") {
			t.Fatalf("asked Stripe for %q", id)
		}
	}
	if len(fake.piReads) == 0 {
		t.Fatal("the card row wasn't read")
	}
}
