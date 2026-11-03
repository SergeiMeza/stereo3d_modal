package store

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func settleStore(t *testing.T) *Store {
	t.Helper()
	if os.Getenv("FIRESTORE_EMULATOR_HOST") == "" {
		t.Skip("needs FIRESTORE_EMULATOR_HOST")
	}
	st, err := New(context.Background(), "demo-settle", "st"+NewID())
	if err != nil {
		t.Fatal(err)
	}
	return st
}

// owedAccount: one failed group (2 runs) and one run whose own charge
// failed — 1000 + 2000 + 500 owed.
func owedAccount(t *testing.T, s *Store, uid string) (groupID, runID string) {
	t.Helper()
	ctx := context.Background()
	if err := s.PutCustomer(ctx, uid, &Customer{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	g := &Batch{ID: NewID(), UID: uid, State: BatchFailed, Currency: "usd", TotalCents: 3000, OpenedAt: now, DueAt: now}
	for _, amt := range []int64{1000, 2000} {
		c := &Conversion{ID: NewID(), UID: uid, State: StateSucceeded, Kind: "video", Quote: Quote{AmountCents: amt, Currency: "usd"}}
		c.Stripe.BatchID, c.Stripe.PIStatus = g.ID, PIChargeFailed
		if err := s.CreateConversion(ctx, c); err != nil {
			t.Fatal(err)
		}
		g.Items = append(g.Items, BatchItem{ConversionID: c.ID, Kind: "video", AmountCents: amt})
	}
	if _, err := s.batchDoc(g.ID).Set(ctx, g); err != nil {
		t.Fatal(err)
	}
	r := &Conversion{ID: NewID(), UID: uid, State: StateSucceeded, Kind: "video", Quote: Quote{AmountCents: 500, Currency: "usd"}}
	r.Stripe.PIStatus, r.Stripe.PaymentIntentID = PIChargeFailed, "pi_old"
	if err := s.CreateConversion(ctx, r); err != nil {
		t.Fatal(err)
	}
	return g.ID, r.ID
}

func TestSettleScopesPaysAndFreezes(t *testing.T) {
	s := settleStore(t)
	ctx := context.Background()
	uid := "u" + NewID()
	groupID, runID := owedAccount(t, s, uid)
	lease := Lease{Owner: "t", Until: time.Now().Add(time.Minute)}

	st, err := s.OpenSettle(ctx, uid, "sheet", lease)
	if err != nil {
		t.Fatal(err)
	}
	if st.AmountCents != 3500 || st.Runs() != 3 || st.ID != uid+"_1" {
		t.Fatalf("scope: amount %d runs %d id %s", st.AmountCents, st.Runs(), st.ID)
	}
	// One live settle per account: a second open returns the live one.
	again, err := s.OpenSettle(ctx, uid, "sheet", lease)
	if !errors.Is(err, ErrSettleLive) || again == nil || again.ID != st.ID {
		t.Fatalf("second open: %v %+v", err, again)
	}
	if b, _ := s.GetBatch(ctx, groupID); b.State != BatchSettling || b.SettleID != st.ID {
		t.Fatalf("group not frozen: %s %s", b.State, b.SettleID)
	}
	if c, _ := s.GetConversion(ctx, runID); c.Stripe.PIStatus != PISettling {
		t.Fatalf("run not frozen: %s", c.Stripe.PIStatus)
	}

	done, err := s.FinishSettle(ctx, st.ID, SettleOutcome{Paid: true, PaymentIntentID: "pi_settle", PaidCents: 3500, PaidWith: "pm_9"}, nil)
	if err != nil || done.State != SettlePaid {
		t.Fatalf("finish: %v %+v", err, done)
	}
	if b, _ := s.GetBatch(ctx, groupID); b.State != BatchPaid || b.PaidWith != "pm_9" {
		t.Fatalf("group not paid: %s", b.State)
	}
	for _, it := range done.Items {
		ids := it.ConversionIDs
		if it.Kind == "run" {
			ids = []string{it.ID}
		}
		for _, id := range ids {
			if c, _ := s.GetConversion(ctx, id); c.Stripe.PIStatus != PISucceeded || c.Stripe.PaymentIntentID != "pi_settle" {
				t.Fatalf("run %s: %s %s", id, c.Stripe.PIStatus, c.Stripe.PaymentIntentID)
			}
		}
	}
	cust, _ := s.GetCustomer(ctx, uid)
	if cust.LiveSettleID != "" || cust.LifetimePaidCents != 3500 || cust.LastGoodMethod != "pm_9" {
		t.Fatalf("account: %+v", cust)
	}
	// Paid twice is a conflict, never a second application.
	if _, err := s.FinishSettle(ctx, st.ID, SettleOutcome{Paid: true, PaymentIntentID: "pi_other", PaidCents: 3500}, nil); !errors.Is(err, ErrStateConflict) {
		t.Fatalf("second finish: %v", err)
	}
	if _, err := s.OpenSettle(ctx, uid, "sheet", lease); !errors.Is(err, ErrNothingOwed) {
		t.Fatalf("after paying: %v", err)
	}
}

func TestSettleClosedGivesItemsBack(t *testing.T) {
	s := settleStore(t)
	ctx := context.Background()
	uid := "u" + NewID()
	groupID, runID := owedAccount(t, s, uid)
	st, err := s.OpenSettle(ctx, uid, "sheet", Lease{Owner: "t", Until: time.Now().Add(time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.FinishSettle(ctx, st.ID, SettleOutcome{}, nil); err != nil {
		t.Fatal(err)
	}
	if b, _ := s.GetBatch(ctx, groupID); b.State != BatchFailed {
		t.Fatalf("group: %s", b.State)
	}
	if c, _ := s.GetConversion(ctx, runID); c.Stripe.PIStatus != PIChargeFailed {
		t.Fatalf("run: %s", c.Stripe.PIStatus)
	}
	next, err := s.OpenSettle(ctx, uid, "sheet", Lease{Owner: "t", Until: time.Now().Add(time.Minute)})
	if err != nil || next.ID != uid+"_2" || next.AmountCents != 3500 {
		t.Fatalf("reopen: %v %+v", err, next)
	}
}
