package api

import (
	"context"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// B1: every web off-session PaymentIntent is made under pmc_web, so a
// Link or PayPal saved on the web sheet can be charged (the account's
// Default configuration offers card, Apple Pay and BLIK only: the
// 2026-11-06 "link is not allowed" incident).
func TestWebOffSessionChargesNamePMC(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()

	uid, _ := offCustomer(t, s, f, [2]string{"pm_link", ""})
	s.runReload(ctx, offReload(t, s, uid, 2000))

	uid2, _ := offCustomer(t, s, f, [2]string{"pm_paypal", ""})
	owedConversion(t, s, uid2, 1500)
	if res, err := s.collectOutstanding(ctx, uid2, settleDelete, payContext{}); err != nil || !res.Paid {
		t.Fatalf("delete settle %v %+v", err, res)
	}

	uid3, cus3 := offCustomer(t, s, f, [2]string{"pm_card", ""})
	conv := &store.Conversion{ID: store.NewID(), UID: uid3, State: store.StateCreated, Kind: "video",
		Quote: store.Quote{AmountCents: 900, Currency: "usd"}}
	conv.Stripe.Mode, conv.Stripe.PIStatus = store.BillingModeAutoPrecharge, store.PICharging
	conv.Stripe.CustomerID, conv.Stripe.ChargePM = cus3, "pm_card"
	if err := s.Store.CreateConversion(ctx, conv); err != nil {
		t.Fatal(err)
	}
	if got, err := s.runPrecharge(ctx, conv); err != nil || got.State != store.StatePaid {
		t.Fatalf("precharge %v %+v", err, got)
	}

	if len(f.creates) != 3 {
		t.Fatalf("creates %d", len(f.creates))
	}
	for _, c := range f.creates {
		if c["payment_method_configuration"] != "pmc_test" || c["off_session"] != "true" || c["currency"] != "usd" {
			t.Fatalf("charge without pmc_web: %v", c)
		}
	}
}
