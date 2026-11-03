package store

import (
	"context"
	"errors"
	"testing"
)

func topupFor(t *testing.T, s *Store, uid string, cents int64, pi string) {
	t.Helper()
	ctx := context.Background()
	id := "t" + NewID()
	if err := s.CreateTopup(ctx, &Topup{ID: id, UID: uid, Cents: cents, Currency: "usd", State: TopupOpen}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := s.ApplyTopupPaid(ctx, id, pi, cents, "pm_1"); err != nil {
		t.Fatal(err)
	}
	// Once per PaymentIntent: a second delivery changes nothing.
	if _, _, _, err := s.ApplyTopupPaid(ctx, id, pi, cents, "pm_1"); err != nil {
		t.Fatal(err)
	}
}

func balanceRun(t *testing.T, s *Store, uid string, hold, reload int64) (*Conversion, BalanceEffects, error) {
	t.Helper()
	c := &Conversion{ID: NewID(), UID: uid, State: StatePaid, Kind: "video", PaymentFlow: FlowBalance,
		Quote: Quote{AmountCents: hold, Currency: "usd"}, RunBalance: &RunBalance{HoldCents: hold, State: HoldHeld}}
	c.Stripe.Mode = BillingModeBalance
	fx, err := s.CreateConversionWithHold(context.Background(), c, reload)
	return c, fx, err
}

// E0-8 and R3: holds can't exceed available; a terminal transition
// settles (succeeded, ≥ $1, ≤ hold) or releases (anything else) in the
// same transaction.
func TestBalanceHoldSettleRelease(t *testing.T) {
	s := settleStore(t)
	ctx := context.Background()
	uid := "u" + NewID()
	topupFor(t, s, uid, 2500, "pi_a")
	b, _ := s.GetBalance(ctx, uid)
	if b.BalanceCents != 2500 || b.Available() != 2500 || b.ExpiresAt == nil {
		t.Fatalf("after top-up: %+v", b)
	}
	if _, _, err := balanceRun(t, s, uid, 3000, 0); !errors.Is(err, ErrInsufficientBalance) {
		t.Fatalf("over-hold: %v", err)
	}
	r1, _, err := balanceRun(t, s, uid, 1500, 0)
	if err != nil {
		t.Fatal(err)
	}
	r2, _, err := balanceRun(t, s, uid, 800, 0)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ = s.GetBalance(ctx, uid); b.Available() != 200 || b.HeldCents != 2300 {
		t.Fatalf("held: %+v", b)
	}
	// r1 succeeds having delivered $9.00 of $15.00: settles 900, releases 600.
	done, err := s.Transition(ctx, r1.ID, []string{StatePaid}, func(c *Conversion) error {
		c.State, c.RunBalance.SettleCents = StateSucceeded, 900
		return nil
	})
	if err != nil || done.RunBalance.State != HoldSettled || done.RunBalance.SettledCents != 900 || done.RunBalance.ReleasedCents != 600 {
		t.Fatalf("settle: %v %+v", err, done.RunBalance)
	}
	// r2 fails: released whole.
	failed, err := s.Transition(ctx, r2.ID, []string{StatePaid}, func(c *Conversion) error { c.State = StateFailed; return nil })
	if err != nil || failed.RunBalance.State != HoldReleased {
		t.Fatalf("release: %v %+v", err, failed.RunBalance)
	}
	b, _ = s.GetBalance(ctx, uid)
	if b.BalanceCents != 1600 || b.HeldCents != 0 || len(b.Holds) != 0 || b.MonthSettledFor(b.MonthKey) != 900 {
		t.Fatalf("after: %+v", b)
	}
	entries, _, err := s.ListEntries(ctx, uid, 50, "")
	if err != nil || len(entries) != 6 { // topup, hold, hold, settle, release, release
		t.Fatalf("entries %d %v", len(entries), err)
	}
}

// R1/T8: a run short of funds with auto-reload on waits on a
// pending_reload hold; the reload landing promotes it; a failed reload
// releases it and pauses auto-reload.
func TestBalanceReloadPendingHold(t *testing.T) {
	s := settleStore(t)
	ctx := context.Background()
	uid := "u" + NewID()
	topupFor(t, s, uid, 1000, "pi_b")
	if _, _, err := s.BalanceTx(ctx, uid, func(b *Balance) ([]BalanceOp, error) {
		b.AutoReload = AutoReload{Enabled: true, BelowCents: 500, AddCents: 2000}
		return nil, nil
	}); err != nil {
		t.Fatal(err)
	}
	// BalanceTx with no ops doesn't write; set it with a zero adjustment.
	if _, _, err := s.BalanceTx(ctx, uid, func(b *Balance) ([]BalanceOp, error) {
		b.AutoReload = AutoReload{Enabled: true, BelowCents: 500, AddCents: 2000}
		return []BalanceOp{{Kind: EntryAdjustment, Cents: 0, Note: "settings"}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	run, fx, err := balanceRun(t, s, uid, 2500, 2000)
	if err != nil || fx.ReloadTopupID == "" || run.RunBalance.State != HoldPendingReload {
		t.Fatalf("pending hold: %v %+v %+v", err, fx, run.RunBalance)
	}
	// A second pending run can't ride the same reload past E0-8.
	if _, _, err := balanceRun(t, s, uid, 2500, 2000); !errors.Is(err, ErrInsufficientBalance) {
		t.Fatalf("second rider: %v", err)
	}
	_, promoted, _, err := s.ApplyTopupPaid(ctx, fx.ReloadTopupID, "pi_reload", 2000, "pm_1")
	if err != nil || len(promoted) != 1 || promoted[0] != run.ID {
		t.Fatalf("promote: %v %v", err, promoted)
	}
	b, _ := s.GetBalance(ctx, uid)
	if b.ReloadInFlight != nil || b.BalanceCents != 3000 || b.Holds[run.ID].PendingReload {
		t.Fatalf("after reload: %+v", b)
	}

	run2, fx2, err := balanceRun(t, s, uid, 1000, 2000)
	if err != nil || fx2.ReloadTopupID == "" {
		t.Fatalf("second pending: %v %+v", err, fx2)
	}
	_, released, err := s.FailTopup(ctx, fx2.ReloadTopupID, "declined", "card declined")
	if err != nil || len(released) != 1 || released[0] != run2.ID {
		t.Fatalf("fail: %v %v", err, released)
	}
	if b, _ = s.GetBalance(ctx, uid); b.AutoReload.PausedReason != "declined" || b.ReloadInFlight != nil || b.HeldCents != 2500 {
		t.Fatalf("after failed reload: %+v", b)
	}
}

// R1: a downward crossing of X (holds ignored) starts one reload; no
// second while one is in flight; R5: expiry and money landing after it.
func TestBalanceTriggerAndExpiry(t *testing.T) {
	s := settleStore(t)
	ctx := context.Background()
	uid := "u" + NewID()
	topupFor(t, s, uid, 1500, "pi_c")
	s.BalanceTx(ctx, uid, func(b *Balance) ([]BalanceOp, error) {
		b.AutoReload = AutoReload{Enabled: true, BelowCents: 1000, AddCents: 1000}
		return []BalanceOp{{Kind: EntryAdjustment}}, nil
	})
	run, fx, err := balanceRun(t, s, uid, 1200, 0)
	if err != nil || fx.ReloadTopupID != "" {
		t.Fatalf("a hold never triggers: %v %+v", err, fx)
	}
	done, err := s.Transition(ctx, run.ID, []string{StatePaid}, func(c *Conversion) error { c.State = StateSucceeded; return nil })
	if err != nil || done.RunBalance.Effects.ReloadTopupID == "" {
		t.Fatalf("the settle crossing X must start a reload: %v %+v", err, done.RunBalance)
	}
	b, _ := s.GetBalance(ctx, uid)
	if b.ReloadArmed || b.ReloadInFlight == nil || b.BalanceCents != 300 {
		t.Fatalf("trigger state: %+v", b)
	}
	s.FailTopup(ctx, b.ReloadInFlight.TopupID, "declined", "")

	// Expiry takes what isn't held; a release after it expires too.
	r2, _, err := balanceRun(t, s, uid, 200, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.BalanceTx(ctx, uid, func(b *Balance) ([]BalanceOp, error) {
		return []BalanceOp{{Kind: EntryExpiry}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if b, _ = s.GetBalance(ctx, uid); b.BalanceCents != 200 || !b.Expired {
		t.Fatalf("expired: %+v", b)
	}
	s.Transition(ctx, r2.ID, []string{StatePaid}, func(c *Conversion) error { c.State = StateCanceled; return nil })
	if b, _ = s.GetBalance(ctx, uid); b.BalanceCents != 0 || b.HeldCents != 0 {
		t.Fatalf("release after expiry: %+v", b)
	}
	// A refund to the balance reopens it for 12 months.
	s.BalanceTx(ctx, uid, func(b *Balance) ([]BalanceOp, error) {
		return []BalanceOp{{Kind: EntryRefundToBalance, Cents: 500, ConversionID: run.ID, Restore: done.RunBalance.FifoUsed}}, nil
	})
	if b, _ = s.GetBalance(ctx, uid); b.Expired || b.BalanceCents != 500 {
		t.Fatalf("reopened: %+v", b)
	}
}
