package store

import (
	"context"
	"testing"
	"time"
)

// B9: a settle collects, and records as captured, only the card's part of
// a run a partial balance hold paid some of; a run without one is
// unchanged (the full quote).
func TestSettleCardShareOfPartialRuns(t *testing.T) {
	s := settleStore(t)
	ctx := context.Background()
	uid := "u" + NewID()
	if err := s.PutCustomer(ctx, uid, &Customer{StripeCustomerID: "cus_x"}); err != nil {
		t.Fatal(err)
	}
	mk := func(quote int64, rb *RunBalance) string {
		c := &Conversion{ID: NewID(), UID: uid, State: StateSucceeded, Kind: "video", Quote: Quote{AmountCents: quote, Currency: "usd"}, RunBalance: rb}
		c.Stripe.Mode, c.Stripe.PIStatus = BillingModeAuto, PIChargeFailed
		if err := s.CreateConversion(ctx, c); err != nil {
			t.Fatal(err)
		}
		return c.ID
	}
	split := mk(3000, &RunBalance{HoldCents: 1200, Partial: true, State: HoldSettled})
	whole := mk(800, nil)
	st, err := s.OpenSettle(ctx, uid, "delete", Lease{Owner: "t", Until: time.Now().Add(time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	if st.AmountCents != 1800+800 {
		t.Fatalf("settle amount %d, want the card's 2600", st.AmountCents)
	}
	if _, err := s.FinishSettle(ctx, st.ID, SettleOutcome{Paid: true, PaymentIntentID: "pi_1", PaidCents: 2600, PaidWith: "pm_1"}, nil); err != nil {
		t.Fatal(err)
	}
	a, _ := s.GetConversion(ctx, split)
	b, _ := s.GetConversion(ctx, whole)
	if a.Stripe.CapturedCents != 1800 || b.Stripe.CapturedCents != 800 {
		t.Fatalf("captured %d / %d", a.Stripe.CapturedCents, b.Stripe.CapturedCents)
	}
}
