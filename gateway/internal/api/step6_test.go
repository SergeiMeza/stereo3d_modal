package api

import (
	"context"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func TestRefundPolicyRules(t *testing.T) {
	p := defaultRefundPolicy()
	if p.modeFor(ReasonRunFailed, 90000) != "auto" {
		t.Fatal("undelivered reasons are auto at any amount")
	}
	if p.modeFor(ReasonQuality, 100) != "manual" || p.modeFor("something_new", 100) != "manual" {
		t.Fatal("judgement reasons and unknown ones are manual")
	}
	p.Reasons[ReasonQuality] = "auto"
	if p.modeFor(ReasonQuality, 4000) != "auto" || p.modeFor(ReasonQuality, 6000) != "manual" {
		t.Fatal("auto over the $50 cap turns manual unless exempt")
	}
	// Friday 10:00 JST + 2 business days → Tuesday 18:00 JST.
	fri := time.Date(2026, 11, 6, 1, 0, 0, 0, time.UTC)
	if d := defaultRefundPolicy().deadline(ReasonQuality, fri); d.Weekday() != time.Tuesday {
		t.Fatalf("deadline %s", d)
	}
	runs := []runMoney{{Conv: &store.Conversion{State: store.StateFailed}}}
	if classifyDelivered(runs, ReasonQuality) != ReasonRunFailed {
		t.Fatal("nothing delivered: by cause")
	}
	runs[0].Conv.State = store.StateSucceeded
	if classifyDelivered(runs, "") != ReasonDelivered || classifyDelivered(runs, ReasonPartial) != ReasonPartial {
		t.Fatal("delivered: the hint or delivered_run")
	}
}

// C12/C8 end to end: a delivered pre-charged run → a manual case; the
// owner approves → refund(), the ledger row succeeds, the case closes;
// asking again finds nothing left. An owed run → a waive case; waived,
// the account owes nothing.
func TestRefundCaseFlow(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	now := time.Now().UTC()
	run := &store.Conversion{ID: store.NewID(), UID: uid, State: store.StateSucceeded, Kind: "video", ProjectID: "p1",
		Quote: store.Quote{AmountCents: 1500, Currency: "usd"}}
	run.Stripe = store.Stripe{Mode: store.BillingModeAutoPrecharge, PaymentIntentID: "pi_run", PIStatus: store.PISucceeded, CapturedCents: 1500, CapturedAt: &now}
	s.Store.CreateConversion(ctx, run)
	fake.pis["pi_run"] = map[string]any{"status": "succeeded", "amount_received": 1500}

	cases, err := s.requestRefund(ctx, RefundRequest{UID: uid, ConversionIDs: []string{run.ID}, Reason: ReasonQuality, Source: "support", Who: "owner@x"})
	if err != nil || len(cases) != 1 || cases[0].Mode != "manual" || cases[0].Status != store.CaseOpen || !cases[0].CustomerVisible {
		t.Fatalf("case: %v %+v", err, cases)
	}
	cs := cases[0]
	if _, max := s.perRun(ctx, cs); max != 1500 {
		t.Fatalf("max %d", max)
	}
	stale := int64(999)
	if err := s.applyCaseAction(ctx, cs, caseActionReq{Action: "approve", ExpectedMaxCents: &stale}, "owner@x"); err == nil {
		t.Fatal("a changed maximum must ask again")
	}
	if err := s.applyCaseAction(ctx, cs, caseActionReq{Action: "partial", Items: map[string]int64{run.ID: 500}}, "owner@x"); err != nil {
		t.Fatal(err)
	}
	done, _ := s.Store.GetCase(ctx, cs.ID)
	if done.Status != store.CaseClosed || done.Result != store.CaseRefunded || done.DecidedCents != 500 {
		t.Fatalf("after partial: %+v", done)
	}
	if len(fake.refunds) != 1 {
		t.Fatalf("stripe refunds %v", fake.refunds)
	}
	// A second request: 1000 left; approve takes exactly that.
	again, _ := s.requestRefund(ctx, RefundRequest{UID: uid, ConversionIDs: []string{run.ID}, Reason: ReasonSupport, Source: "support", Who: "owner@x"})
	if _, max := s.perRun(ctx, again[0]); max != 1000 {
		t.Fatalf("left %d", max)
	}
	if err := s.applyCaseAction(ctx, again[0], caseActionReq{Action: "approve"}, "owner@x"); err != nil {
		t.Fatal(err)
	}
	if rows, _ := s.Store.ListRefundRows(ctx, "pi_run"); len(rows) != 2 || rows[0].Status != store.RefundSucceeded {
		t.Fatalf("ledger %+v", rows)
	}

	owed := &store.Conversion{ID: store.NewID(), UID: uid, State: store.StateSucceeded, Kind: "video", Quote: store.Quote{AmountCents: 700, Currency: "usd"}}
	owed.Stripe.PIStatus = store.PIChargeFailed
	s.Store.CreateConversion(ctx, owed)
	wc, err := s.requestRefund(ctx, RefundRequest{UID: uid, ConversionIDs: []string{owed.ID}, Source: "support", Who: "owner@x"})
	if err != nil || len(wc) != 1 || wc[0].Type != store.CaseWaive {
		t.Fatalf("waive case: %v %+v", err, wc)
	}
	if err := s.applyCaseAction(ctx, wc[0], caseActionReq{Action: "waive"}, "owner@x"); err != nil {
		t.Fatal(err)
	}
	if s.owedCents(ctx, uid) != 0 {
		t.Fatal("waived run still owed")
	}
}

// N8/T11a: within 14 days a top-up's unspent part goes back to the card,
// what holds keep waiting until they end (R7); plan credit never pays out.
func TestTopupWithdrawal(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	tp := paidTopup(t, s, uid, 2500)
	held := &store.Conversion{ID: store.NewID(), UID: uid, State: store.StatePaid, Kind: "video", PaymentFlow: store.FlowBalance,
		Quote: store.Quote{AmountCents: 1000, Currency: "usd"}, RunBalance: &store.RunBalance{HoldCents: 1000, State: store.HoldHeld}}
	held.Stripe.Mode = store.BillingModeBalance
	if _, err := s.Store.CreateConversionWithHold(ctx, held, 0); err != nil {
		t.Fatal(err)
	}
	cs, err := s.requestBalanceRefund(ctx, uid, ReasonTopupWithdraw, tp.ID, "support", "owner@x", "changed my mind")
	if err != nil || cs.Mode != "auto" || cs.RequestedCents != 2500 {
		t.Fatalf("case: %v %+v", err, cs)
	}
	b, _ := s.Store.GetBalance(ctx, uid)
	if b.BalanceCents != 1000 || b.HeldCents != 1000 || len(fake.refunds) != 1 {
		t.Fatalf("after the available part: balance %d held %d refunds %v", b.BalanceCents, b.HeldCents, fake.refunds)
	}
	if fresh, _ := s.Store.GetCase(ctx, cs.ID); fresh.Status != store.CaseWaitingForRun || fresh.DecidedCents != 1500 {
		t.Fatalf("waiting for the hold: %+v", fresh)
	}
	// The run fails: its hold returns; the sweep pays the rest.
	s.Store.Transition(ctx, held.ID, []string{store.StatePaid}, func(c *store.Conversion) error { c.State = store.StateFailed; return nil })
	s.casesSweep(ctx)
	fresh, _ := s.Store.GetCase(ctx, cs.ID)
	if b, _ = s.Store.GetBalance(ctx, uid); b.BalanceCents != 0 || fresh.DecidedCents != 2500 || fresh.Status != store.CaseClosed {
		t.Fatalf("finished: balance %d case %+v", b.BalanceCents, fresh)
	}
}

// V2/B11: a dispute opens a case that supersedes the open refund case on
// the charge, locks the run's files and puts the account on sheet-only;
// won, the lock and sheet-only lift and the case closes dispute_won.
func TestDisputeLifecycle(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	now := time.Now().UTC()
	run := &store.Conversion{ID: store.NewID(), UID: uid, State: store.StateSucceeded, Kind: "video",
		Quote: store.Quote{AmountCents: 1500, Currency: "usd"}}
	pi := "pi_d" + run.ID
	run.Stripe = store.Stripe{Mode: store.BillingModeAutoPrecharge, PaymentIntentID: pi, PIStatus: store.PISucceeded, CapturedCents: 1500, CapturedAt: &now}
	s.Store.CreateConversion(ctx, run)
	fake.pis[pi] = map[string]any{"status": "succeeded", "amount_received": 1500,
		"metadata": map[string]string{"env": s.Cfg.Env, "product": "svs-web", "user_id": uid, "conversion_id": run.ID}}
	refundCases, err := s.requestRefund(ctx, RefundRequest{UID: uid, ConversionIDs: []string{run.ID}, Reason: ReasonQuality, Source: "support", Who: "owner@x"})
	if err != nil || len(refundCases) != 1 {
		t.Fatalf("refund case: %v", err)
	}
	dp := "du_" + run.ID
	raw := []byte(`{"id":"` + dp + `","amount":1500,"reason":"fraudulent","status":"needs_response","payment_intent":"` + pi + `","evidence_details":{"due_by":1900000000}}`)
	if err := s.handleDisputeEvent(ctx, "charge.dispute.created", raw); err != nil {
		t.Fatal(err)
	}
	if old, _ := s.Store.GetCase(ctx, refundCases[0].ID); old.Open || old.Result != store.CaseSuperseded {
		t.Fatalf("refund case not superseded: %+v", old)
	}
	conv, _ := s.Store.GetConversion(ctx, run.ID)
	cust, _ := s.Store.GetCustomer(ctx, uid)
	if conv.DisputeID != dp || !cust.SheetOnly {
		t.Fatalf("lock %q sheet-only %v", conv.DisputeID, cust.SheetOnly)
	}
	// A new refund request on the disputed charge merges into nothing new.
	if _, err := s.requestRefund(ctx, RefundRequest{UID: uid, ConversionIDs: []string{run.ID}, Reason: ReasonQuality, Source: "support", Who: "owner@x"}); err == nil {
		if rows, _ := s.Store.ListRefundRows(ctx, pi); len(rows) != 0 {
			t.Fatal("no refund while disputed")
		}
	}
	won := []byte(`{"id":"` + dp + `","amount":1500,"reason":"fraudulent","status":"won","payment_intent":"` + pi + `"}`)
	if err := s.handleDisputeEvent(ctx, "charge.dispute.closed", won); err != nil {
		t.Fatal(err)
	}
	conv, _ = s.Store.GetConversion(ctx, run.ID)
	cust, _ = s.Store.GetCustomer(ctx, uid)
	dc := s.disputeCase(ctx, pi, dp)
	if conv.DisputeID != "" || cust.SheetOnly || dc == nil || dc.Open || dc.Result != "dispute_won" {
		t.Fatalf("after won: lock %q sheet-only %v case %+v", conv.DisputeID, cust.SheetOnly, dc)
	}
}
