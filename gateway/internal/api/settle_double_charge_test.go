package api

import (
	"context"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// B5 (D8: every caller, web and app): a settle's charge took the money
// but its answer was lost (a timeout). The sweep used to release the debt
// and the next settle charged again — two charges for one debt (seen in
// test mode: pi_3UZ4KZAV… and pi_3UZ4KaAV…). Now the charge is recorded
// before it goes out, the sweep finds the PaymentIntent and the settle is
// paid by it: one charge.
func TestSettleLostAnswerChargesOnce(t *testing.T) {
	for _, trigger := range []string{settleDelete, settleSoftRety, settleIOS} {
		t.Run(trigger, func(t *testing.T) {
			s, f := offService(t)
			ctx := context.Background()
			uid, _ := offCustomer(t, s, f, [2]string{"pm_default", ""})
			conv := owedConversion(t, s, uid, 1000)
			f.lostAnswers = 1
			res, err := s.collectOutstanding(ctx, uid, trigger, payContext{})
			if err == nil || res.Settle == nil || res.Settle.State != store.SettleSettling {
				t.Fatalf("first try: %v %+v", err, res.Settle)
			}
			if f.succeeded() != 1 {
				t.Fatal("the lost answer should have taken the money")
			}
			// the lease lapses; the reconciler's sweep comes
			if _, err := s.Store.UpdateSettle(ctx, res.Settle.ID, func(x *store.Settle) error {
				x.Lease.Until = time.Now().Add(-time.Minute)
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			s.settleSweep(ctx)
			again, err := s.collectOutstanding(ctx, uid, trigger, payContext{})
			if err != nil {
				t.Fatal(err)
			}
			if n := f.succeeded(); n != 1 || len(f.creates) != 1 {
				t.Fatalf("charged %d times (%d creates): a double charge", n, len(f.creates))
			}
			st, _ := s.Store.GetSettle(ctx, res.Settle.ID)
			if !again.Nothing || st.State != store.SettlePaid || st.PaymentIntentID != "pi_off_1" || st.PaidCents != 1000 {
				t.Fatalf("after the sweep: again %+v settle %+v", again, st)
			}
			if c, _ := s.Store.GetConversion(ctx, conv); c.Stripe.PIStatus != store.PISucceeded {
				t.Fatalf("run %s", c.Stripe.PIStatus)
			}
			if st.ChargeKey != "settle_test_"+st.ID || st.ChargePM != "pm_default" || st.ChargeStartedAt == nil {
				t.Fatalf("charge not recorded first: %+v", st)
			}
		})
	}
}

// A lost answer whose charge never reached Stripe (nothing to find): the
// sweep releases the settle as before, and the next settle charges once.
func TestSettleLostRequestReleases(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, cus := offCustomer(t, s, f, [2]string{"pm_default", ""})
	owedConversion(t, s, uid, 1000)
	res, err := s.collectOutstanding(ctx, uid, settleDelete, payContext{})
	if err != nil || !res.Paid {
		t.Fatalf("%v %+v", err, res)
	}
	// a second debt, its charge recorded but never sent (crash between the
	// write and the call)
	owedConversion(t, s, uid, 700)
	st, err := s.Store.OpenSettle(ctx, uid, settleDelete, store.Lease{Owner: "x", Until: time.Now().Add(-time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	at := time.Now().UTC()
	s.Store.UpdateSettle(ctx, st.ID, func(x *store.Settle) error {
		x.ChargeKey, x.ChargePM, x.ChargeCustomerID, x.ChargeStartedAt = "settle_test_"+st.ID, "pm_default", cus, &at
		return nil
	})
	s.settleSweep(ctx)
	if got, _ := s.Store.GetSettle(ctx, st.ID); got.State == store.SettleSettling || got.State == store.SettlePaid {
		t.Fatalf("not released: %s", got.State)
	}
	if res, err := s.collectOutstanding(ctx, uid, settleDelete, payContext{}); err != nil || !res.Paid || f.succeeded() != 2 {
		t.Fatalf("%v %+v succeeded %d", err, res, f.succeeded())
	}
}
