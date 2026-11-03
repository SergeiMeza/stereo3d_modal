package api

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func TestHistoryRowsFoldSettlesAndGroups(t *testing.T) {
	t0 := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	at := func(m int) *time.Time { x := t0.Add(time.Duration(m) * time.Minute); return &x }

	// A group paid on its own, a group a settle paid, a run the settle
	// paid, a pre-charged run, a refunded run, a failed group (owed).
	g1 := &store.Batch{ID: "g1", State: store.BatchPaid, Currency: "usd", TotalCents: 300, ChargedCents: 300, PaymentIntentID: "pi_g1", ChargedAt: at(1),
		Items: []store.BatchItem{{ConversionID: "a", AmountCents: 100}, {ConversionID: "b", AmountCents: 200}}}
	g2 := &store.Batch{ID: "g2", State: store.BatchPaid, SettleID: "u_1", TotalCents: 500, PaymentIntentID: "pi_st",
		Items: []store.BatchItem{{ConversionID: "c", AmountCents: 500}}}
	g3 := &store.Batch{ID: "g3", State: store.BatchFailed, TotalCents: 700, Items: []store.BatchItem{{ConversionID: "f", AmountCents: 700}}}
	st := &store.Settle{ID: "u_1", State: store.SettlePaid, PaidCents: 750, PaymentIntentID: "pi_st", PaidAt: at(5),
		Items: []store.SettleItem{{Kind: "group", ID: "g2", AmountCents: 500, ConversionIDs: []string{"c"}}, {Kind: "run", ID: "d", AmountCents: 250}}}
	d := &store.Conversion{ID: "d", State: store.StateSucceeded, Quote: store.Quote{AmountCents: 250, Currency: "usd"}}
	d.Stripe = store.Stripe{PIStatus: store.PISucceeded, PaymentIntentID: "pi_st", SettleID: "u_1", CapturedCents: 250, CapturedAt: at(5)}
	e := &store.Conversion{ID: "e", State: store.StateSucceeded, Quote: store.Quote{AmountCents: 999, Currency: "usd"}}
	e.Stripe = store.Stripe{PIStatus: store.PISucceeded, PaymentIntentID: "pi_e", CapturedCents: 999, CapturedAt: at(3)}
	r := &store.Conversion{ID: "r", State: store.StateFailed, Quote: store.Quote{AmountCents: 400, Currency: "usd"}}
	r.Stripe = store.Stripe{PIStatus: store.PIRefunded, PaymentIntentID: "pi_r", CapturedCents: 400, RefundedCents: 400, CapturedAt: at(2), RefundedAt: at(4)}

	rows := historyRows([]*store.Batch{g1, g2, g3}, []*store.Settle{st}, []*store.Conversion{d, e, r})
	var ids []string
	for _, x := range rows {
		ids = append(ids, x.RowID+":"+x.Status)
	}
	want := []string{"settle_u_1:paid", "refund_r:refunded", "run_e:paid", "run_r:refunded", "group_g1:paid"}
	if len(ids) != len(want) {
		t.Fatalf("rows %v, want %v", ids, want)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("rows %v, want %v", ids, want)
		}
	}
	if rows[0].AmountCents != 750 || len(rows[0].convIDs) != 2 || rows[0].chargeID != "settle_u_1" {
		t.Fatalf("settle row %+v", rows[0])
	}
	if rows[1].AmountCents != -400 || rows[1].Kind != "refund" {
		t.Fatalf("refund row %+v", rows[1])
	}
	page, more := pageRows(rows, "", 2)
	if len(page) != 2 || page[0].RowID != "settle_u_1" || !more {
		t.Fatalf("first page: %v more=%v", page, more)
	}
	if page, more = pageRows(rows, "run_e", 2); len(page) != 2 || page[0].RowID != "run_r" || more {
		t.Fatalf("last page: %d more=%v", len(page), more)
	}
}

func TestFrameSpanAndInvoiceKeys(t *testing.T) {
	c := &store.Conversion{Source: store.Source{FPS: 30}, Params: store.Params{FromFrame: 0, ToFrame: 3240}}
	if got := frameSpan(c); got != "0:00–1:48" {
		t.Fatalf("span %q", got)
	}
	if frameSpan(&store.Conversion{}) != "" {
		t.Fatal("no fps: no span")
	}
	if store.ChargeID(store.ChargeGroup, "b1") != "group_b1" {
		t.Fatal("charge id")
	}
}

// lifelike_stabilize: passed through on the run's request, never shown to
// clients.
func TestLifelikeStabilizePassThrough(t *testing.T) {
	c := &store.Conversion{Method: store.MethodLifelike, Params: store.Params{Preset: "4k", Stabilize: true}}
	if lifelikeBody(c, 4)["stabilize"] != true {
		t.Fatal("stabilize not passed")
	}
	c.Params.Stabilize = false
	if _, ok := lifelikeBody(c, 4)["stabilize"]; ok {
		t.Fatal("stabilize sent while off")
	}
	b, _ := json.Marshal(store.Params{Stabilize: true})
	if strings.Contains(string(b), "stabilize") {
		t.Fatalf("exposed to clients: %s", b)
	}
	if pricing.DefaultsFor("test").LifelikeStabilize || pricing.DefaultsFor("prod").LifelikeStabilize {
		t.Fatal("off by default on test and prod")
	}
}
