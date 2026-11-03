package store

import (
	"context"
	"errors"
	"sync"
	"testing"
)

// v6.1 W2: refunds on one charge serialize — two cases racing for more
// than the charge holds can't both pass; pending rows count; a covered
// run is ErrNothingRefundable.
func TestReserveRefundSerializes(t *testing.T) {
	s := settleStore(t)
	ctx := context.Background()
	ch := &Charge{UID: "u1", Kind: ChargeGroup, SourceID: NewID(), PaymentIntentID: "pi_g" + NewID(), AmountCents: 1000, Currency: "usd",
		Lines: []ChargeLine{{ConversionID: "a", AmountCents: 600}, {ConversionID: "b", AmountCents: 400}}}
	if err := s.RecordCharge(ctx, ch); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	got := make([]int64, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			row, err := s.ReserveRefund(ctx, ReserveSpec{ChargeID: ch.ID, PI: ch.PaymentIntentID, CaseID: []string{"CASE-1", "CASE-2"}[i],
				Items: map[string]int64{"a": 600}, StripeRemainder: -1, Source: "gateway"})
			if err == nil {
				got[i] = row.TotalCents
			} else if !errors.Is(err, ErrNothingRefundable) {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if got[0]+got[1] != 600 {
		t.Fatalf("run a refunded %d+%d, want 600 once", got[0], got[1])
	}
	// b's 400 is still there; asking 500 caps at 400.
	row, err := s.ReserveRefund(ctx, ReserveSpec{ChargeID: ch.ID, PI: ch.PaymentIntentID, CaseID: "CASE-3", Items: map[string]int64{"b": 500}, StripeRemainder: -1})
	if err != nil || row.TotalCents != 400 || row.Items["b"] != 400 {
		t.Fatalf("cap: %+v %v", row, err)
	}
	if _, err := s.ReserveRefund(ctx, ReserveSpec{ChargeID: ch.ID, PI: ch.PaymentIntentID, CaseID: "CASE-4", Items: map[string]int64{"b": 1}, StripeRemainder: -1}); !errors.Is(err, ErrNothingRefundable) {
		t.Fatalf("covered: %v", err)
	}
	// A failed row stops counting.
	s.UpdateRefundRow(ctx, row.ID, func(r *RefundRow) error { r.Status = RefundFailed; return nil })
	_, live, _ := s.Refundable(ctx, ch.ID, ch.PaymentIntentID, -1)
	if live.Refundable["b"] != 400 || live.Refundable["a"] != 0 {
		t.Fatalf("live: %+v", live)
	}
	// Stripe's own remainder caps too: it saw 300 refunded elsewhere and
	// not yet our pending 600 (no re_id), so 100 is left.
	if row, err := s.ReserveRefund(ctx, ReserveSpec{ChargeID: ch.ID, PI: ch.PaymentIntentID, CaseID: "CASE-5", Items: map[string]int64{"b": 400}, StripeRemainder: 700}); err != nil || row.TotalCents != 100 {
		t.Fatalf("stripe remainder: %+v %v", row, err)
	}
}

// C13: a case number per case, dedupe on an open case, closed is final.
func TestCasesDedupeAndFinal(t *testing.T) {
	s := settleStore(t)
	ctx := context.Background()
	c1, created, err := s.CreateCase(ctx, &Case{UID: "u1", Type: CaseRefund, Reason: "quality_complaint", Mode: "manual", Status: CaseOpen, DedupeKey: "pi_x:a"}, "support", "first")
	if err != nil || !created {
		t.Fatal(err)
	}
	c2, created, err := s.CreateCase(ctx, &Case{UID: "u1", Type: CaseRefund, Reason: "delivered_run", Mode: "manual", Status: CaseOpen, DedupeKey: "pi_x:a"}, "support", "again")
	if err != nil || created || c2.ID != c1.ID {
		t.Fatalf("dedupe: %v %v %s %s", err, created, c1.ID, c2.ID)
	}
	if _, err := s.UpdateCase(ctx, c1.ID, "owner", func(c *Case) error { c.Status = CaseClosed; return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateCase(ctx, c1.ID, "owner", func(c *Case) error { c.Status = CaseOpen; return nil }); !errors.Is(err, ErrStateConflict) {
		t.Fatalf("closed is final: %v", err)
	}
	c3, created, _ := s.CreateCase(ctx, &Case{UID: "u1", Type: CaseRefund, Status: CaseOpen, DedupeKey: "pi_x:a"}, "support", "after close")
	if !created || c3.ID == c1.ID {
		t.Fatal("a closed case doesn't absorb new requests")
	}
	events, _ := s.ListCaseEvents(ctx, c1.ID, 10)
	if len(events) < 3 {
		t.Fatalf("timeline: %d", len(events))
	}
}
