package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
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

func TestRunSpecAndInvoiceKeys(t *testing.T) {
	// 1:48 of 60 fps 4K production: the billable minutes, not the length
	c := &store.Conversion{Step: store.StepProduction, Method: store.MethodLifelike, ProjectID: "p1",
		Source: store.Source{FPS: 60}, Params: store.Params{Preset: "4k", FromFrame: 0, ToFrame: 6480},
		Quote: store.Quote{Breakdown: map[string]any{"billable_minutes": int64(2), "billable_seconds": 108.0}}}
	if got := runSpec(c); got != "4K · 60 fps · 2 min" {
		t.Fatalf("spec %q", got)
	}
	if got := piDescription(c); got != "Lifelike 3D render · 4K · 60 fps · 2 min" {
		t.Fatalf("description %q", got)
	}
	c.Params.TargetFPS, c.Quote.Breakdown = 29.97, nil // older record: minutes from the range
	if got := runSpec(c); got != "4K · 29.97 fps · 2 min" {
		t.Fatalf("spec %q", got)
	}
	prev := &store.Conversion{Step: store.StepLifelikePreview, Source: store.Source{FPS: 30},
		Params: store.Params{Preset: "1080p", FromFrame: 30, ToFrame: 180}}
	if got := runSpec(prev); got != "1080p · 30 fps · 5 s" {
		t.Fatalf("preview %q", got)
	}
	if got := piDescription(&store.Conversion{Kind: "video", Source: store.Source{FPS: 30}, Params: store.Params{Preset: "1080p"}}); got != "3D video conversion" {
		t.Fatalf("mobile %q", got)
	}
	if store.ChargeID(store.ChargeGroup, "b1") != "group_b1" {
		t.Fatal("charge id")
	}
}

// The Lifelike pipeline handles temporal smoothing itself: the request
// carries no such key, whatever the run.
func TestLifelikeBodyHasNoSmoothingKey(t *testing.T) {
	c := &store.Conversion{Method: store.MethodLifelike, Params: store.Params{Preset: "4k", Express: true}}
	raw, _ := json.Marshal(lifelikeBody(c, 4))
	if strings.Contains(string(raw), "stabil") {
		t.Fatalf("body %s", raw)
	}
}

// Express: "priority": "express" only on Express runs, standard runs omit
// the key (the service defaults to standard; anything else is a 400);
// Express asks for 8 GPUs (submitToModal passes ExpressGPUWorkers); the
// job's echo is recorded on the run.
func TestLifelikePriorityContract(t *testing.T) {
	c := &store.Conversion{Method: store.MethodLifelike, Params: store.Params{Preset: "4k"}}
	rates := pricing.DefaultsFor("test")
	std := lifelikeBody(c, rates.GPUWorkersFor(store.MethodLifelike))
	if _, ok := std["priority"]; ok || std["max_gpu_workers"] != 4 {
		t.Fatalf("standard run: %v %v", std["priority"], std["max_gpu_workers"])
	}
	c.Params.Express = true
	exp := lifelikeBody(c, rates.ExpressGPUWorkers())
	if exp["priority"] != "express" || exp["max_gpu_workers"] != 8 {
		t.Fatalf("express: %v %v", exp["priority"], exp["max_gpu_workers"])
	}
	if rates.ExpressCostFactor() != 1.12 || rates.ExpressMaxWaitS() != 420 {
		t.Fatal("express defaults")
	}
	job := &modalapi.Job{Metadata: json.RawMessage(`{"priority":"express","max_gpu_workers":8}`)}
	noteScheduling(c, job)
	if c.Modal.Priority != "express" || c.Modal.GPUWorkers != 8 {
		t.Fatalf("echo %+v", c.Modal)
	}
	// ETA: render shrinks with 8 GPUs, planning and encode don't.
	s := &Service{Pricing: pricing.NewStatic(nil)}
	in := pricing.LifelikeInputs{Step: store.StepProduction, Preset: "4k", OutputSeconds: 60}
	in.GPUs = 4
	e4 := s.Pricing.EstimateLifelikeETA(context.Background(), in)
	in.GPUs = 8
	e8 := s.Pricing.EstimateLifelikeETA(context.Background(), in)
	if saved := e4 - e8; saved < 40 || saved > 90 {
		t.Fatalf("60 s clip: %d → %d", e4, e8)
	}
}
