package api

import (
	"context"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Deletion dues (web, audit #1): the default declines, a backup pays —
// the declined PaymentIntent is re-confirmed with the backup, not left
// open. Before the fix the SDK's empty PaymentIntent blanked its id: no
// backup, no cancel, the deletion blocked.
func TestSettleDeleteUsesBackups(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_default", "decline:generic_decline"}, [2]string{"pm_backup", ""})
	conv := owedConversion(t, s, uid, 1500)
	res, err := s.collectOutstanding(ctx, uid, settleDelete, payContext{})
	if err != nil || !res.Paid || res.Settle.State != store.SettlePaid || res.Settle.PaidWith != "pm_backup" {
		t.Fatalf("delete settle: %v %+v %+v", err, res, res.Settle)
	}
	if len(f.creates) != 1 || len(f.confirms) != 1 || f.confirms[0]["pm"] != "pm_backup" || f.confirms[0]["pi"] != "pi_off_1" {
		t.Fatalf("creates %v confirms %v", f.creates, f.confirms)
	}
	if c, _ := s.Store.GetConversion(ctx, conv); c.Stripe.PIStatus != store.PISucceeded {
		t.Fatalf("run %s", c.Stripe.PIStatus)
	}
}

// Every saved method declines: the PaymentIntent is cancelled (none left
// open) and the settle closes declined, the debt back to owed.
func TestSettleDeleteAllDeclineCancels(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_default", "decline:insufficient_funds"}, [2]string{"pm_backup", "decline:generic_decline"})
	conv := owedConversion(t, s, uid, 1500)
	res, err := s.collectOutstanding(ctx, uid, settleDelete, payContext{})
	if err != nil || res.Paid || !res.Declined {
		t.Fatalf("delete settle: %v %+v", err, res)
	}
	if len(f.confirms) != 1 || len(f.cancels) != 1 || f.cancels[0] != "pi_off_1" || f.pis["pi_off_1"]["status"] != "canceled" {
		t.Fatalf("confirms %v cancels %v", f.confirms, f.cancels)
	}
	if c, _ := s.Store.GetConversion(ctx, conv); c.Stripe.PIStatus != store.PIChargeFailed {
		t.Fatalf("run %s", c.Stripe.PIStatus)
	}
}

// D1 regression (owner 2026-11-07): the app's settle triggers keep their
// shipped behaviour byte for byte — on a declined default with a working
// backup, ios_settle and the 24 h soft retry still try nothing else,
// cancel nothing, and answer declined; a bank check on ios_settle still
// answers declined without a client secret.
func TestSettleAppTriggersUnchanged(t *testing.T) {
	for _, tc := range []struct {
		trigger, outcome string
	}{
		{settleIOS, "decline:generic_decline"},
		{settleIOS, "auth"},
		{settleSoftRety, "decline:insufficient_funds"},
		{settleSoftRety, "auth"},
	} {
		t.Run(tc.trigger+"/"+tc.outcome, func(t *testing.T) {
			s, f := offService(t)
			ctx := context.Background()
			uid, _ := offCustomer(t, s, f, [2]string{"pm_default", tc.outcome}, [2]string{"pm_backup", ""})
			conv := owedConversion(t, s, uid, 1500)
			res, err := s.collectOutstanding(ctx, uid, tc.trigger, payContext{})
			if err != nil || res.Paid || !res.Declined || res.RequiresAction || res.ClientSecret != "" {
				t.Fatalf("%+v %v", res, err)
			}
			if len(f.creates) != 1 || len(f.confirms) != 0 || len(f.cancels) != 0 {
				t.Fatalf("creates %d confirms %v cancels %v", len(f.creates), f.confirms, f.cancels)
			}
			if f.creates[0]["key"] != "settle_test_"+res.Settle.ID || f.creates[0]["off_session"] != "true" || f.creates[0]["payment_method"] != "pm_default" {
				t.Fatalf("charge %v", f.creates[0])
			}
			if f.pis["pi_off_1"]["status"] != "requires_payment_method" {
				t.Fatalf("pi %v", f.pis["pi_off_1"])
			}
			if c, _ := s.Store.GetConversion(ctx, conv); c.Stripe.PIStatus != store.PIChargeFailed {
				t.Fatalf("run %s", c.Stripe.PIStatus)
			}
		})
	}
}
