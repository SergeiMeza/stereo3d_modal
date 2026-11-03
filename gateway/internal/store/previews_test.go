package store

import (
	"context"
	"testing"
)

// Free previews: the period allowance and the day cap both bound them; a
// new period starts at zero; a run that delivers nothing gives its
// previews back in its own terminal transition.
func TestFreePreviews(t *testing.T) {
	s := settleStore(t)
	ctx := context.Background()
	uid := "u" + NewID()
	take := func(period string, units int) bool {
		ok, err := s.ConsumeFreePreviews(ctx, uid, period, "2026-11-03", units, 5, 4, false)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	if !take("p1", 2) || !take("p1", 2) {
		t.Fatal("within the allowance")
	}
	if take("p1", 1) {
		t.Fatal("day cap of 4 passed")
	}
	if u, _ := s.GetPreviewUsage(ctx, uid, "p2", "2026-11-04"); u.Used != 0 || u.DayUsed != 0 {
		t.Fatalf("new period/day: %+v", u)
	}
	// A failed preview gives its 2 back.
	c := &Conversion{ID: NewID(), UID: uid, State: StatePaid, Kind: "video",
		FreePreview: &FreePreview{Units: 2, PeriodKey: "p1", DayKey: "2026-11-03"}}
	if err := s.CreateConversion(ctx, c); err != nil {
		t.Fatal(err)
	}
	done, err := s.Transition(ctx, c.ID, []string{StatePaid}, func(c *Conversion) error { c.State = StateFailed; return nil })
	if err != nil || !done.FreePreview.Returned {
		t.Fatalf("return: %v %+v", err, done.FreePreview)
	}
	if u, _ := s.GetPreviewUsage(ctx, uid, "p1", "2026-11-03"); u.Used != 2 || u.DayUsed != 2 {
		t.Fatalf("after return: %+v", u)
	}
	// The intro preview: once.
	if ok, _ := s.ConsumeFreePreviews(ctx, uid, "intro", "2026-11-03", 1, 1, 20, true); !ok {
		t.Fatal("intro")
	}
	if ok, _ := s.ConsumeFreePreviews(ctx, uid, "intro", "2026-11-03", 1, 1, 20, true); ok {
		t.Fatal("intro twice")
	}
}

// Plan credit is spent first and expires at its period's end; a new
// period's grant replaces the leftover.
func TestPlanCredit(t *testing.T) {
	s := settleStore(t)
	ctx := context.Background()
	uid := "u" + NewID()
	topupFor(t, s, uid, 1000, "pi_pc")
	end := mustTime("2026-12-03T00:00:00Z")
	if _, _, err := s.BalanceTx(ctx, uid, func(b *Balance) ([]BalanceOp, error) {
		return []BalanceOp{{Kind: EntryPlanCredit, Cents: 40000, ExpiresAt: &end, EntryID: "plancredit_in1", Ref: "sub_1"}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	run, _, err := balanceRun(t, s, uid, 500, 0)
	if err != nil {
		t.Fatal(err)
	}
	done, _ := s.Transition(ctx, run.ID, []string{StatePaid}, func(c *Conversion) error { c.State = StateSucceeded; return nil })
	if len(done.RunBalance.FifoUsed) != 1 || done.RunBalance.FifoUsed[0].TopupID != "" {
		t.Fatalf("plan credit first: %+v", done.RunBalance.FifoUsed)
	}
	b, _ := s.GetBalance(ctx, uid)
	if b.PlanCreditCents() != 39500 || b.CashCents() != 1000 || !b.HasPlanCredit {
		t.Fatalf("after run: %+v", b)
	}
	// Next period: the leftover expires, the new credit lands.
	end2 := mustTime("2027-01-03T00:00:00Z")
	s.BalanceTx(ctx, uid, func(b *Balance) ([]BalanceOp, error) {
		return []BalanceOp{{Kind: EntryPlanCredit, Cents: 40000, ExpiresAt: &end2, EntryID: "plancredit_in2", Ref: "sub_1"}}, nil
	})
	if b, _ = s.GetBalance(ctx, uid); b.PlanCreditCents() != 40000 || b.BalanceCents != 41000 {
		t.Fatalf("renewal: %d %d", b.PlanCreditCents(), b.BalanceCents)
	}
}
