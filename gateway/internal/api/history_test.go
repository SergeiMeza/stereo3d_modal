package api

import (
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// S3D-57: one entry per card charge, newest first; refunds are their own
// negative entries; an open batch is not a charge yet.
func TestHistoryEntries(t *testing.T) {
	t0 := time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC)
	at := func(h int) *time.Time { v := t0.Add(time.Duration(h) * time.Hour); return &v }
	batches := []*store.Batch{
		{ID: "b1", State: store.BatchPaid, Currency: "usd", TotalCents: 1500, ChargedCents: 1500, ChargedAt: at(1),
			PaymentIntentID: "pi_b1", Items: []store.BatchItem{{ConversionID: "c1", AmountCents: 1000}, {ConversionID: "c2", AmountCents: 500}}},
		{ID: "b2", State: store.BatchFailed, Currency: "usd", TotalCents: 900, ClosedAt: at(2)},
		{ID: "b3", State: store.BatchCharging, Currency: "usd", TotalCents: 300, ClosedAt: at(3)},
		{ID: "b4", State: store.BatchOpen, Currency: "usd", TotalCents: 200, UpdatedAt: *at(9)},
	}
	pre := func(id, pi string, captured, refunded int64, h int) *store.Conversion {
		return &store.Conversion{ID: id, Step: store.StepProduction, Method: store.MethodLifelike,
			Quote:  store.Quote{AmountCents: captured, Currency: "usd"},
			Params: store.Params{Preset: "4k", Quality: "4k"},
			Stripe: store.Stripe{Mode: store.BillingModeAutoPrecharge, PaymentIntentID: "pi_" + id, PIStatus: pi,
				CapturedCents: captured, CapturedAt: at(h), RefundedCents: refunded, RefundedAt: at(h + 1)},
			UpdatedAt: *at(h + 1)}
	}
	convs := []*store.Conversion{
		pre("p1", store.PISucceeded, 4000, 0, 4),
		pre("p2", store.PIRefunded, 3000, 3000, 5),
		pre("p3", store.PICancelPending, 2600, 0, 7),
		{ID: "batched", Stripe: store.Stripe{BatchID: "b1", PIStatus: store.PISucceeded, PaymentIntentID: "pi_b1"}}, // listed by b1
		{ID: "free", Stripe: store.Stripe{PIStatus: store.PISucceeded}},                                             // no card charge
		{ID: "released", Stripe: store.Stripe{PIStatus: store.PICancelPending, Mode: store.BillingModeAuto}},        // never charged
	}
	got := historyEntries(batches, convs)
	var ids []string
	for _, e := range got {
		ids = append(ids, e.String())
	}
	want := []string{
		"refund_p3 refund -2600 pending",
		"conv_p3 charge 2600 paid",
		"refund_p2 refund -3000 refunded",
		"conv_p2 charge 3000 refunded",
		"conv_p1 charge 4000 paid",
		"batch_b3 charge 300 pending",
		"batch_b2 charge 900 failed",
		"batch_b1 charge 1500 paid",
	}
	if strings.Join(ids, "|") != strings.Join(want, "|") {
		t.Errorf("entries:\n got %v\nwant %v", ids, want)
	}
	if got[2].RefundOf != "conv_p2" || got[4].Items[0].Step != "production" || got[4].Items[0].Method != "lifelike" || got[4].Items[0].Quality != "4k" {
		t.Errorf("details: %+v / %+v", got[2], got[4])
	}
	partial := pre("p4", store.PIRefunded, 3000, 1000, 8)
	if e := historyEntries(nil, []*store.Conversion{partial}); e[1].Status != "partially_refunded" || e[0].AmountCents != -1000 {
		t.Errorf("partial refund: %v", e)
	}
}

func TestHistoryPagination(t *testing.T) {
	t0 := time.Now()
	var all []historyEntry
	for i := range 5 {
		all = append(all, historyEntry{ID: "e" + string(rune('a'+i)), CreatedAt: t0.Add(-time.Duration(i) * time.Minute)})
	}
	p1, c1 := paginateHistory(all, "", 2)
	p2, c2 := paginateHistory(all, c1, 2)
	p3, c3 := paginateHistory(all, c2, 2)
	if len(p1) != 2 || len(p2) != 2 || len(p3) != 1 || c3 != "" || p2[0].ID != "ec" || p3[0].ID != "ee" {
		t.Errorf("pages: %v %v %v (%q)", p1, p2, p3, c3)
	}
	if p, _ := paginateHistory(all, "bogus", 2); len(p) != 0 {
		t.Error("an unknown cursor reads as past the end")
	}
}

func TestHistoryItemSteps(t *testing.T) {
	for step, want := range map[string]string{
		store.StepDepthPreview: "preview", store.StepStereoPreview: "preview",
		store.StepLifelikePreview: "preview", store.StepProduction: "production",
	} {
		if got := itemFor(&store.Conversion{Step: step}, "").Step; got != want {
			t.Errorf("%s: %s", step, got)
		}
	}
	if itemFor(&store.Conversion{Kind: "image"}, "").Step != "photo" {
		t.Error("mobile stills read as photo")
	}
}
