package api

import (
	"context"
	"strings"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// REV-09: an off-session charge whose answer was lost is replayed with
// other parameters (a deploy or a config change between: here the PMC).
// Stripe's idempotency_error is answered from what the key made — the
// money it took is the payment, never a second charge — or, when it took
// nothing, the request goes again under a key of its own.
func TestChargeReplayAfterParamsChanged(t *testing.T) {
	ctx := context.Background()
	t.Run("the key took the money", func(t *testing.T) {
		s, f := offService(t)
		uid, _ := offCustomer(t, s, f, [2]string{"pm_1", ""})
		id := offReload(t, s, uid, 2000)
		f.keptAnswers = 1 // charged, the answer lost
		s.runReload(ctx, id)
		if tp, _ := s.Store.GetTopup(ctx, id); tp.State != store.TopupCharging {
			t.Fatalf("after the lost answer: %s", tp.State)
		}
		s.Store.UpdateTopup(ctx, id, func(x *store.Topup) error { x.Lease = nil; return nil }) // the reconciler's replay, later
		s.Cfg.StripePMCWeb = "pmc_changed"                                                     // the deploy
		creates := len(f.creates)
		s.runReload(ctx, id)
		tp, _ := s.Store.GetTopup(ctx, id)
		b, _ := s.Store.GetBalance(ctx, uid)
		if tp.State != store.TopupPaid || b.BalanceCents != 2000 || len(f.creates) != creates {
			t.Fatalf("replay: topup %s balance %d, %d new charges", tp.State, b.BalanceCents, len(f.creates)-creates)
		}
	})
	t.Run("the key took nothing", func(t *testing.T) {
		s, f := offService(t)
		uid, cus := offCustomer(t, s, f, [2]string{"pm_1", "decline:generic_decline"})
		job := stripex.Job{UID: uid, PMC: "pmc_test"}
		if _, err := s.Stripe.ChargeTopup(cus, "pm_1", 2000, "t_replay", job); err == nil {
			t.Fatal("the decline went through")
		}
		f.outcome["pm_1"] = ""
		job.PMC = "pmc_changed"
		pi, err := s.Stripe.ChargeTopup(cus, "pm_1", 2000, "t_replay", job)
		if err != nil || pi == nil || pi.Status != "succeeded" {
			t.Fatalf("replay with new parameters: %v %v", pi, err)
		}
		last := f.creates[len(f.creates)-1]["key"]
		if !strings.HasPrefix(last, "topup_test_t_replay_p") {
			t.Fatalf("sent again under %q", last)
		}
		// that replay itself replays under the same key: no third charge
		n := len(f.creates)
		if again, err := s.Stripe.ChargeTopup(cus, "pm_1", 2000, "t_replay", job); err != nil || again.ID != pi.ID || len(f.creates) != n {
			t.Fatalf("second replay %v %v creates +%d", again, err, len(f.creates)-n)
		}
	})
}
