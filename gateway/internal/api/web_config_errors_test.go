package api

import (
	"context"
	"strings"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// B2/B3: Stripe refuses the default's charge itself (a Link the
// configuration doesn't allow: no PaymentIntent is made). The backups are
// still tried, each charged under its own key.
func TestReloadConfigErrorTriesBackups(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_link", "config"}, [2]string{"pm_card", ""})
	id := offReload(t, s, uid, 2000)
	s.runReload(ctx, id)
	tp, _ := s.Store.GetTopup(ctx, id)
	if tp.State != store.TopupPaid || tp.PaidWith != "pm_card" {
		t.Fatalf("topup %+v", tp)
	}
	if len(f.creates) != 2 || f.creates[1]["key"] != "topup_test_"+id+"_pm_card" || f.creates[1]["metadata[topup_id]"] != id ||
		f.creates[1]["payment_method_configuration"] != "pmc_test" || len(f.confirms) != 0 {
		t.Fatalf("creates %v confirms %v", f.creates, f.confirms)
	}
}

// Only configuration errors: the reload fails paused ("config") without
// the "auto-reload didn't go through" mail — the customer did nothing
// wrong; the owner is alerted instead.
func TestReloadConfigErrorOnlyNoMail(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_link", "config"}, [2]string{"pm_paypal", "config"})
	id := offReload(t, s, uid, 2000)
	s.runReload(ctx, id)
	tp, _ := s.Store.GetTopup(ctx, id)
	b, _ := s.Store.GetBalance(ctx, uid)
	if tp.State != store.TopupFailed || b.BalanceCents != 0 || b.AutoReload.PausedReason != "config" {
		t.Fatalf("topup %+v balance %+v", tp, b)
	}
	if fresh, _ := s.Store.ClaimMail(ctx, "E15_"+id, uid, "E15"); !fresh {
		t.Fatal("E15 was mailed for a configuration error")
	}
	// a real decline after a configuration error still mails
	uid2, _ := offCustomer(t, s, f, [2]string{"pm_link2", "config"}, [2]string{"pm_card2", "decline:insufficient_funds"})
	id2 := offReload(t, s, uid2, 2000)
	s.runReload(ctx, id2)
	if b2, _ := s.Store.GetBalance(ctx, uid2); b2.AutoReload.PausedReason != "declined" {
		t.Fatalf("paused %q", b2.AutoReload.PausedReason)
	}
	if fresh, _ := s.Store.ClaimMail(ctx, "E15_"+id2, uid2, "E15"); fresh {
		t.Fatal("E15 not mailed for a decline")
	}
}

// Deletion dues (web): the same — a refused default, the backup charged
// under its own key; a backup that declines leaves no PaymentIntent open.
func TestSettleDeleteConfigErrorTriesBackups(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_link", "config"}, [2]string{"pm_card", ""})
	owedConversion(t, s, uid, 1500)
	res, err := s.collectOutstanding(ctx, uid, settleDelete, payContext{})
	if err != nil || !res.Paid || res.Settle.PaidWith != "pm_card" {
		t.Fatalf("%v %+v", err, res.Settle)
	}
	if len(f.creates) != 2 || !strings.HasSuffix(f.creates[1]["key"], "_pm_card") || f.creates[1]["metadata[settle_id]"] != res.Settle.ID {
		t.Fatalf("creates %v", f.creates)
	}

	uid2, _ := offCustomer(t, s, f, [2]string{"pm_link2", "config"}, [2]string{"pm_card2", "decline:generic_decline"})
	owedConversion(t, s, uid2, 1500)
	res2, err := s.collectOutstanding(ctx, uid2, settleDelete, payContext{})
	if err != nil || res2.Paid || !res2.Declined {
		t.Fatalf("%v %+v", err, res2)
	}
	for id, pi := range f.pis {
		if pi["customer"] != "" && pi["status"] == "requires_payment_method" {
			t.Fatalf("PaymentIntent %s left open", id)
		}
	}
}
