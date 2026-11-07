package api

import (
	"context"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// offReload records an auto-reload ready to charge (auto-reload on).
func offReload(t *testing.T, s *Service, uid string, cents int64) string {
	t.Helper()
	ctx := context.Background()
	if _, _, err := s.Store.BalanceTx(ctx, uid, func(b *store.Balance) ([]store.BalanceOp, error) {
		b.AutoReload = store.AutoReload{Enabled: true, BelowCents: 500, AddCents: cents}
		return []store.BalanceOp{{Kind: store.EntryAdjustment, Cents: 0, Note: "settings"}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	id := "r" + store.NewID()
	now := time.Now().UTC()
	if err := s.Store.CreateTopup(ctx, &store.Topup{ID: id, UID: uid, Cents: cents, Currency: "usd", State: store.TopupCharging,
		Auto: true, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	return id
}

// A bank check on the default (authentication_required, card 3184) goes
// on to the backups like a decline does; the backup pays and the balance
// is credited once.
func TestReloadAuthRequiredUsesBackup(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_3ds", "auth"}, [2]string{"pm_backup", ""})
	id := offReload(t, s, uid, 2000)
	s.runReload(ctx, id)
	tp, _ := s.Store.GetTopup(ctx, id)
	b, _ := s.Store.GetBalance(ctx, uid)
	if tp.State != store.TopupPaid || tp.PaidWith != "pm_backup" || tp.PaymentIntentID != "pi_off_1" || b.BalanceCents != 2000 {
		t.Fatalf("topup %+v balance %d", tp, b.BalanceCents)
	}
	if len(f.confirms) != 1 || f.confirms[0]["pm"] != "pm_backup" || f.confirms[0]["key"] != "confirm_pi_off_1_pm_backup_1" {
		t.Fatalf("confirms %v", f.confirms)
	}
}

// With no backup that pays, the bank check ends the reload as before:
// failed, the PaymentIntent cancelled, auto-reload paused, no credit.
func TestReloadAuthRequiredNoBackupFails(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_3ds", "auth"}, [2]string{"pm_backup", "decline:insufficient_funds"})
	id := offReload(t, s, uid, 2000)
	s.runReload(ctx, id)
	tp, _ := s.Store.GetTopup(ctx, id)
	b, _ := s.Store.GetBalance(ctx, uid)
	if tp.State != store.TopupFailed || b.BalanceCents != 0 || b.AutoReload.PausedReason != "declined" {
		t.Fatalf("topup %+v balance %+v", tp, b)
	}
	if len(f.confirms) != 1 || len(f.cancels) != 1 || f.pis["pi_off_1"]["status"] != "canceled" {
		t.Fatalf("confirms %v cancels %v", f.confirms, f.cancels)
	}
}

// A stop code still ends everything at once: no backup is tried.
func TestReloadStopCodeSkipsBackups(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_stolen", "decline:stolen_card"}, [2]string{"pm_backup", ""})
	id := offReload(t, s, uid, 2000)
	s.runReload(ctx, id)
	if tp, _ := s.Store.GetTopup(ctx, id); tp.State != store.TopupFailed || len(f.confirms) != 0 {
		t.Fatalf("topup %+v confirms %v", tp, f.confirms)
	}
}
