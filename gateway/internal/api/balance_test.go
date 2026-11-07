package api

import (
	"context"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

func paidTopup(t *testing.T, s *Service, uid string, cents int64) *store.Topup {
	t.Helper()
	ctx := context.Background()
	tp := &store.Topup{ID: "t" + store.NewID(), UID: uid, Cents: cents, Currency: "usd", State: store.TopupOpen}
	if err := s.Store.CreateTopup(ctx, tp); err != nil {
		t.Fatal(err)
	}
	if err := s.applyTopupPayment(ctx, tp.ID, stripex.Outcome{PaymentIntentID: "pi_" + tp.ID, AmountReceived: cents, Paid: true}); err != nil {
		t.Fatal(err)
	}
	return tp
}

// N9/T20: a top-up pays what the account owes (an app one-shot debt
// included, R10), and the account clears; the top-up gets a charge record
// for its invoice; a second payment of the same top-up is refunded.
func TestTopupPaysDebtsAndInvoices(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	if err := s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"}); err != nil {
		t.Fatal(err)
	}
	debt := &store.Conversion{ID: store.NewID(), UID: uid, State: store.StateSucceeded, Kind: "video", Quote: store.Quote{AmountCents: 700, Currency: "usd"}}
	debt.Stripe.PIStatus = store.PIChargeFailed
	if err := s.Store.CreateConversion(ctx, debt); err != nil {
		t.Fatal(err)
	}
	tp := paidTopup(t, s, uid, 2500)
	if owed := s.owedCents(ctx, uid); owed != 0 {
		t.Fatalf("still owed %d", owed)
	}
	b, _ := s.Store.GetBalance(ctx, uid)
	if b.BalanceCents != 1800 || b.Available() != 1800 {
		t.Fatalf("balance %+v", b)
	}
	if c, _ := s.Store.GetConversion(ctx, debt.ID); c.Stripe.PIStatus != store.PISucceeded {
		t.Fatalf("debt run %s", c.Stripe.PIStatus)
	}
	if ch, err := s.Store.GetCharge(ctx, "topup_"+tp.ID); err != nil || ch.InvoiceState != store.InvoicePending || ch.AmountCents != 2500 {
		t.Fatalf("top-up charge %+v %v", ch, err)
	}
	// The same top-up paid twice: the second PaymentIntent is refunded.
	fake.pis["pi_dup"] = map[string]any{"status": "succeeded", "amount_received": 2500}
	if err := s.applyTopupPayment(ctx, tp.ID, stripex.Outcome{PaymentIntentID: "pi_dup", AmountReceived: 2500, Paid: true}); err != nil {
		t.Fatal(err)
	}
	if len(fake.refunds) != 1 || fake.refunds[0] != "pi_dup" {
		t.Fatalf("refunds %v", fake.refunds)
	}
	if b, _ = s.Store.GetBalance(ctx, uid); b.BalanceCents != 1800 {
		t.Fatalf("credited twice: %d", b.BalanceCents)
	}
}

func TestPlanBalance(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	cust := &store.Customer{StripeCustomerID: "cus_1", DefaultPaymentMethod: "pm_1"}
	if p := s.planBalance(ctx, uid, cust, 500); p.Use || p.Exists {
		t.Fatalf("no balance: %+v", p)
	}
	paidTopup(t, s, uid, 1000)
	if p := s.planBalance(ctx, uid, cust, 900); !p.Use || !p.Enough || p.ReloadCents != 0 {
		t.Fatalf("covered: %+v", p)
	}
	if p := s.planBalance(ctx, uid, cust, 1500); p.Use || p.Enough || p.Available != 1000 {
		t.Fatalf("short, no auto-reload: %+v", p)
	}
	s.Store.BalanceTx(ctx, uid, func(b *store.Balance) ([]store.BalanceOp, error) {
		b.AutoReload = store.AutoReload{Enabled: true, BelowCents: 500, AddCents: 1000}
		return []store.BalanceOp{{Kind: store.EntryAdjustment}}, nil
	})
	// Short by $13.01 with auto-reload adding $10: the reload is $14.
	if p := s.planBalance(ctx, uid, cust, 2301); !p.Use || p.ReloadCents != 1400 {
		t.Fatalf("reload: %+v", p)
	}
	// A $0.50 run holds $1 (T25).
	if p := s.planBalance(ctx, uid, cust, 50); !p.Use {
		t.Fatalf("small run: %+v", p)
	}
}
