package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Credit and balance first (owner 2026-11-07). Emulator only, made-up
// accounts.

func splitFixture(t *testing.T, creditCents int64) (*Service, *fakeStripe, string) {
	t.Helper()
	s, fake := e0Service(t)
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1", DefaultPaymentMethod: "pm_1", PaidMethods: []string{"pm_1"}})
	if creditCents > 0 {
		a := &AdminUser{UID: "admin", Email: "owner@x", Method: "cli"}
		if err := s.adminGrantCredit(ctx, a, uid, creditCents, "", "test credit"); err != nil {
			t.Fatal(err)
		}
	}
	return s, fake, uid
}

func splitRun(uid string, cents int64, flow string) *store.Conversion {
	c := &store.Conversion{ID: store.NewID(), UID: uid, ProjectID: "p" + store.NewID(), Kind: "video", Step: store.StepProduction,
		Method: store.MethodLifelike, PaymentFlow: flow, Quote: store.Quote{AmountCents: cents, Currency: "usd"}}
	return c
}

func available(t *testing.T, s *Service, uid string) int64 {
	t.Helper()
	b, err := s.Store.GetBalance(context.Background(), uid)
	if err != nil {
		t.Fatal(err)
	}
	return b.Available()
}

// How much the balance holds per flow: all of it for a batched card part,
// leaving at least $0.50 for a card charged alone; nothing for China, an
// account under review, or no balance.
func TestPartialHoldCents(t *testing.T) {
	s, _, uid := splitFixture(t, 2000)
	ctx := context.Background()
	cust, _ := s.Store.GetCustomer(ctx, uid)
	for _, tc := range []struct {
		flow   string
		amount int64
		want   int64
	}{
		{store.FlowAfter, 2378, 2000}, {store.FlowPrecharge, 2378, 2000}, {store.FlowPrecharge, 2020, 1970},
		{store.FlowAfter, 2020, 2000}, {store.FlowPayNow, 3000, 2000}, {store.FlowChina, 3000, 0},
	} {
		if got := s.partialHoldCents(ctx, uid, cust, tc.amount, tc.flow); got != tc.want {
			t.Errorf("%s %d: %d, want %d", tc.flow, tc.amount, got, tc.want)
		}
	}
	cust.UnderReview = true
	if s.partialHoldCents(ctx, uid, cust, 2378, store.FlowAfter) != 0 {
		t.Error("under review")
	}
	if s.partialHoldCents(ctx, "u"+store.NewID(), nil, 2378, store.FlowAfter) != 0 {
		t.Error("no balance")
	}
	split := s.paySplit(ctx, uid, &store.Customer{}, 2378, store.FlowAfter)
	if split["credit_cents"] != int64(2000) || split["balance_cents"] != int64(0) || split["card_cents"] != int64(378) ||
		split["text"] != "$20.00 from credit · $3.78 to your card" {
		t.Fatalf("split %v", split)
	}
}

// An "after" run: the credit is held when the run is written, spent when
// it succeeds, and the batch gets only the card's part.
func TestSplitAfterRun(t *testing.T) {
	s, _, uid := splitFixture(t, 2000)
	ctx := context.Background()
	c := splitRun(uid, 2378, store.FlowAfter)
	c.State = store.StatePaid
	c.Stripe = store.Stripe{CustomerID: "cus_1", Mode: store.BillingModeAuto}
	c.RunBalance = &store.RunBalance{HoldCents: s.partialHoldCents(ctx, uid, nil, 2378, store.FlowAfter), State: store.HoldHeld, Partial: true}
	if err := s.createRunRecord(ctx, c); err != nil {
		t.Fatal(err)
	}
	if available(t, s, uid) != 0 {
		t.Fatal("credit not held")
	}
	done, err := s.Store.Transition(ctx, c.ID, []string{store.StatePaid}, func(cc *store.Conversion) error {
		cc.State, cc.Stripe.PIStatus = store.StateSucceeded, store.PIChargePending
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if done.RunBalance.State != store.HoldSettled || done.RunBalance.SettledCents != 2000 {
		t.Fatalf("hold %+v", done.RunBalance)
	}
	batched, err := s.batchConversion(ctx, done)
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.Store.GetBatch(ctx, batched.Stripe.BatchID)
	if err != nil || b.TotalCents != 378 {
		t.Fatalf("batch %+v %v", b, err)
	}
	bal, _ := s.Store.GetBalance(ctx, uid)
	if bal.PlanCreditCents() != 0 || bal.Available() != 0 {
		t.Fatalf("credit left %d", bal.PlanCreditCents())
	}
	if r := s.conversionResponse(batched, nil); r["pay_split"].(map[string]any)["card_cents"] != int64(378) {
		t.Fatalf("response %v", r["pay_split"])
	}
}

// A run that fails gives the credit back (released with the transition)
// and charges no card.
func TestSplitRunFailsReleasesCredit(t *testing.T) {
	s, _, uid := splitFixture(t, 2000)
	ctx := context.Background()
	c := splitRun(uid, 2378, store.FlowAfter)
	c.State = store.StatePaid
	c.Stripe = store.Stripe{CustomerID: "cus_1", Mode: store.BillingModeAuto}
	c.RunBalance = &store.RunBalance{HoldCents: 2000, State: store.HoldHeld, Partial: true}
	if err := s.createRunRecord(ctx, c); err != nil {
		t.Fatal(err)
	}
	failed, err := s.Store.Transition(ctx, c.ID, []string{store.StatePaid}, func(cc *store.Conversion) error {
		cc.State = store.StateFailed
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if failed.RunBalance.State != store.HoldReleased || available(t, s, uid) != 2000 {
		t.Fatalf("hold %+v available %d", failed.RunBalance, available(t, s, uid))
	}
	if _, err := s.batchConversion(ctx, failed); err != nil {
		t.Fatal(err)
	}
	if again, _ := s.Store.GetConversion(ctx, c.ID); again.Stripe.BatchID != "" {
		t.Fatal("a failed run was batched")
	}
}

// A pre-charged run: the card is charged only the rest at start.
func TestSplitPrecharge(t *testing.T) {
	s, fake, uid := splitFixture(t, 2000)
	ctx := context.Background()
	c := splitRun(uid, 4000, store.FlowPrecharge)
	c.State = store.StateCreated
	c.Stripe = store.Stripe{CustomerID: "cus_1", Mode: store.BillingModeAutoPrecharge, PIStatus: store.PICharging, ChargePM: "pm_1"}
	c.RunBalance = &store.RunBalance{HoldCents: s.partialHoldCents(ctx, uid, nil, 4000, store.FlowPrecharge), State: store.HoldHeld, Partial: true}
	if err := s.createRunRecord(ctx, c); err != nil {
		t.Fatal(err)
	}
	paid, err := s.runPrecharge(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	if len(fake.piAmounts) != 1 || fake.piAmounts[0] != 2000 {
		t.Fatalf("card charged %v", fake.piAmounts)
	}
	if paid.State != store.StatePaid || paid.Stripe.CapturedCents != 2000 || runCardCents(paid) != 2000 {
		t.Fatalf("run %s captured %d", paid.State, paid.Stripe.CapturedCents)
	}
}

// A lost race (the credit went in between) writes the run without a hold:
// the card pays it all.
func TestSplitLostRace(t *testing.T) {
	s, _, uid := splitFixture(t, 2000)
	ctx := context.Background()
	c := splitRun(uid, 2378, store.FlowAfter)
	c.State = store.StatePaid
	c.Stripe = store.Stripe{CustomerID: "cus_1", Mode: store.BillingModeAuto}
	c.RunBalance = &store.RunBalance{HoldCents: 5000, State: store.HoldHeld, Partial: true} // more than there is
	if err := s.createRunRecord(ctx, c); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Store.GetConversion(ctx, c.ID)
	if got.RunBalance != nil || runCardCents(got) != 2378 || available(t, s, uid) != 2000 {
		t.Fatalf("run %+v available %d", got.RunBalance, available(t, s, uid))
	}
}

// GET /v1/billing's balance.credits: one entry per unexpired credit with
// cents left, soonest to expire first; prepaid_cents is cash only.
func TestBillingCredits(t *testing.T) {
	s, _, uid := splitFixture(t, 10000)
	ctx := context.Background()
	soon := time.Now().Add(4 * 24 * time.Hour)
	if _, _, err := s.Store.BalanceTx(ctx, uid, func(*store.Balance) ([]store.BalanceOp, error) {
		return []store.BalanceOp{{Kind: store.EntryPlanCredit, Cents: 2000, EntryID: "procredit_t", Ref: "pro:t", ExpiresAt: &soon, Additive: true}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	sum := s.balanceSummary(ctx, uid, nil)
	credits := sum["credits"].([]map[string]any)
	if len(credits) != 2 || credits[0]["kind"] != "pro" || credits[0]["cents"] != int64(2000) || credits[1]["kind"] != "grant" ||
		credits[1]["cents"] != int64(10000) || credits[0]["expires_at"] == nil {
		t.Fatalf("credits %v", credits)
	}
	if sum["prepaid_cents"] != int64(0) || sum["available_cents"] != int64(12000) || sum["plan_credit_cents"] != int64(12000) {
		t.Fatalf("summary %v", sum)
	}
	w := httptest.NewRecorder()
	s.HandleGetBilling(w, httptest.NewRequest(http.MethodGet, "/v1/billing", nil), &AuthedUser{UID: uid})
	code, out := decode(w)
	bal, _ := out["balance"].(map[string]any)
	if code != 200 || len(bal["credits"].([]any)) != 2 {
		t.Fatalf("billing %d %v", code, out["balance"])
	}
}
