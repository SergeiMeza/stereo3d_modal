package api

import (
	"context"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func dueNow(t *testing.T, s *Service, id string) {
	t.Helper()
	if _, err := s.Store.UpdateTopup(context.Background(), id, func(x *store.Topup) error {
		past := time.Now().Add(-time.Second)
		x.Retry.NextAttemptAt = &past
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func mailed(s *Service, key string) bool {
	fresh, _ := s.Store.ClaimMail(context.Background(), key, "t", "t")
	return !fresh
}

// D2/D3: a soft decline pauses auto-reload with no credit and is charged
// again at +24 h and +72 h (each try its own key), then stops with the
// final mail; Billing shows the state, the mapped message and the pay link.
func TestReloadSoftDeclineRetriesTwiceThenStops(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_1", "decline:insufficient_funds"})
	id := offReload(t, s, uid, 2000)
	before := time.Now()
	s.runReload(ctx, id)
	tp, _ := s.Store.GetTopup(ctx, id)
	b, _ := s.Store.GetBalance(ctx, uid)
	r := tp.Retry
	if tp.State != store.TopupFailed || b.BalanceCents != 0 || b.AutoReload.PausedReason != "declined" || r == nil ||
		r.State != store.RetryPending || r.Attempts != 1 || r.MaxAttempts != 3 || r.Reason != retrySoft ||
		r.NextAttemptAt.Sub(before) < 24*time.Hour-time.Minute || r.NextAttemptAt.Sub(before) > 24*time.Hour+time.Minute {
		t.Fatalf("after the first failure: %+v %+v %+v", tp, b.AutoReload, r)
	}
	if !mailed(s, "E15_"+id) {
		t.Fatal("no E15")
	}
	sum := s.balanceSummary(ctx, uid, nil)["auto_reload"].(map[string]any)["retry"].(map[string]any)
	if sum["state"] != "pending" || sum["last_error_message"] != "Your bank declined the payment: not enough funds." ||
		sum["last_decline_code"] != "insufficient_funds" || sum["pay_url"] == nil || sum["amount_cents"] != int64(2000) {
		t.Fatalf("billing %v", sum)
	}
	s.reloadRetrySweep(ctx, time.Now()) // not due yet: nothing
	if len(f.creates) != 1 {
		t.Fatalf("charged before its time: %d", len(f.creates))
	}
	dueNow(t, s, id)
	s.reloadRetrySweep(ctx, time.Now())
	tp, _ = s.Store.GetTopup(ctx, id)
	if len(f.creates) != 2 || f.creates[1]["key"] != "topup_test_"+id+"_r2" || tp.Retry.Attempts != 2 || tp.Retry.State != store.RetryPending ||
		!tp.Retry.NextAttemptAt.Equal(tp.Retry.FirstFailedAt.Add(72*time.Hour)) {
		t.Fatalf("second try: creates %v retry %+v", f.creates, tp.Retry)
	}
	dueNow(t, s, id)
	s.reloadRetrySweep(ctx, time.Now())
	tp, _ = s.Store.GetTopup(ctx, id)
	if len(f.creates) != 3 || f.creates[2]["key"] != "topup_test_"+id+"_r3" || tp.Retry.State != store.RetryFinal || tp.Retry.FinalAt == nil {
		t.Fatalf("third try: %+v", tp.Retry)
	}
	if !mailed(s, "E15_"+id+"_final") {
		t.Fatal("no final mail")
	}
	s.reloadRetrySweep(ctx, time.Now().Add(100*time.Hour))
	if len(f.creates) != 3 {
		t.Fatal("charged after the last try")
	}
	for _, pi := range f.pis {
		if pi["status"] != "canceled" {
			t.Fatalf("a PaymentIntent left %v", pi["status"])
		}
	}
}

// The retry pays: the balance is credited once, the pause lifts, the
// retry reads paid and the pay link closes.
func TestReloadRetryPays(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_1", "decline:generic_decline"})
	id := offReload(t, s, uid, 2000)
	s.runReload(ctx, id)
	tp, _ := s.Store.GetTopup(ctx, id)
	token := tp.Retry.PayRequestID
	f.outcome["pm_1"] = ""
	dueNow(t, s, id)
	s.reloadRetrySweep(ctx, time.Now())
	tp, _ = s.Store.GetTopup(ctx, id)
	b, _ := s.Store.GetBalance(ctx, uid)
	if tp.State != store.TopupPaid || tp.Retry.State != store.RetryPaid || b.BalanceCents != 2000 || b.AutoReload.PausedReason != "" {
		t.Fatalf("topup %+v retry %+v balance %+v", tp, tp.Retry, b.AutoReload)
	}
	if pr, _ := s.Store.GetPayRequest(ctx, token); pr.State == store.PayOpen {
		t.Fatal("the pay link stayed open")
	}
	if s.reloadRetryJSON(ctx, uid) != nil {
		t.Fatal("billing still shows a retry")
	}
}

// What never retries: do_not_honor once, hard declines, the bank's check
// (the pay link: "Confirm and pay"), stop codes; configuration errors
// don't mail (B2).
func TestReloadRetryPolicy(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	for _, tc := range []struct {
		outcome, reason string
		max             int
		mail            bool
	}{
		{"decline:do_not_honor", retrySoft, 2, true},
		{"decline:expired_card", retryHard, 1, true},
		{"auth", retryAuth, 1, true},
		{"decline:stolen_card", retryStop, 1, true},
		{"config", retryConfig, 1, false},
	} {
		uid, _ := offCustomer(t, s, f, [2]string{"pm_" + store.NewID(), tc.outcome})
		id := offReload(t, s, uid, 2000)
		s.runReload(ctx, id)
		tp, _ := s.Store.GetTopup(ctx, id)
		wantState := store.RetryFinal
		if tc.max > 1 {
			wantState = store.RetryPending
		}
		if tp.Retry == nil || tp.Retry.Reason != tc.reason || tp.Retry.MaxAttempts != tc.max || tp.Retry.State != wantState {
			t.Fatalf("%s: %+v", tc.outcome, tp.Retry)
		}
		if mailed(s, "E15_"+id) != tc.mail {
			t.Fatalf("%s: mailed %v", tc.outcome, !tc.mail)
		}
	}
}

// Turning auto-reload back on cancels a pending retry: no charge on top.
func TestReloadRetryCancelledWhenTurnedBackOn(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_1", "decline:insufficient_funds"})
	id := offReload(t, s, uid, 2000)
	s.runReload(ctx, id)
	s.cancelReloadRetries(ctx, uid, "auto-reload turned on")
	dueNow(t, s, id)
	s.reloadRetrySweep(ctx, time.Now())
	tp, _ := s.Store.GetTopup(ctx, id)
	if tp.Retry.State != store.RetryCanceled || len(f.creates) != 1 {
		t.Fatalf("%+v creates %d", tp.Retry, len(f.creates))
	}
}

// REV-03: a retry checks the account's own rule first — a balance lifted
// above the threshold some other way (plan credit, a grant) closes it
// with no charge — and charges today's reload amount.
func TestReloadRetryFollowsTodaysRule(t *testing.T) {
	ctx := context.Background()
	t.Run("balance recovered", func(t *testing.T) {
		s, f := offService(t)
		uid, _ := offCustomer(t, s, f, [2]string{"pm_1", "decline:generic_decline"})
		id := offReload(t, s, uid, 2000)
		s.runReload(ctx, id)
		s.Store.BalanceTx(ctx, uid, func(*store.Balance) ([]store.BalanceOp, error) { // the plan's month credit: not a top-up
			exp := time.Now().Add(30 * 24 * time.Hour)
			return []store.BalanceOp{{Kind: store.EntryPlanCredit, Cents: 1500, Ref: "in_month", EntryID: "plan_credit_1", ExpiresAt: &exp}}, nil
		})
		f.outcome["pm_1"] = ""
		creates := len(f.creates)
		dueNow(t, s, id)
		s.reloadRetrySweep(ctx, time.Now())
		tp, _ := s.Store.GetTopup(ctx, id)
		if len(f.creates) != creates || tp.Retry.State != store.RetryCanceled || tp.Retry.CloseReason != "balance recovered" {
			t.Fatalf("charged a reload the rule wouldn't make: %d creates, %+v", len(f.creates)-creates, tp.Retry)
		}
	})
	t.Run("amount changed", func(t *testing.T) {
		s, f := offService(t)
		uid, _ := offCustomer(t, s, f, [2]string{"pm_1", "decline:generic_decline"})
		id := offReload(t, s, uid, 5000)
		s.runReload(ctx, id)
		s.Store.BalanceTx(ctx, uid, func(b *store.Balance) ([]store.BalanceOp, error) {
			b.AutoReload.AddCents = 2000 // lowered while paused
			return []store.BalanceOp{{Kind: store.EntryAdjustment, Cents: 0, Note: "settings"}}, nil
		})
		f.outcome["pm_1"] = ""
		dueNow(t, s, id)
		s.reloadRetrySweep(ctx, time.Now())
		tp, _ := s.Store.GetTopup(ctx, id)
		last := f.creates[len(f.creates)-1]
		b, _ := s.Store.GetBalance(ctx, uid)
		if last["amount"] != "2000" || tp.State != store.TopupPaid || b.BalanceCents != 2000 || tp.Retry.AmountCents != 2000 {
			t.Fatalf("retry charged %s, topup %+v balance %d", last["amount"], tp.Retry, b.BalanceCents)
		}
	})
}
