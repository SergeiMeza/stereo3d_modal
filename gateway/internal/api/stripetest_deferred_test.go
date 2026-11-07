//go:build stripetest

package api

// deferred-ready on real Stripe test mode (guard rails in
// stripetest_offsession_test.go): web groups' retry schedule, B6
// re-drives, and the group invoice that never charges a second time.

import (
	"context"
	"testing"
	"time"

	"github.com/stripe/stripe-go/v78"
	"github.com/stripe/stripe-go/v78/charge"
	"github.com/stripe/stripe-go/v78/customer"
	"github.com/stripe/stripe-go/v78/invoice"
	"github.com/stripe/stripe-go/v78/paymentmethod"
	"github.com/stripe/stripe-go/v78/testhelpers/testclock"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

func stCharges(t *testing.T, cus string) int {
	t.Helper()
	it := charge.List(&stripe.ChargeListParams{Customer: stripe.String(cus)})
	n := 0
	for it.Next() {
		n++
	}
	return n
}

// stAdvanceClock moves the customer's test clock to at and waits for it.
func stAdvanceClock(t *testing.T, cus string, at time.Time) {
	t.Helper()
	c, err := customer.Get(cus, nil)
	if err != nil || c.TestClock == nil {
		t.Fatalf("customer clock: %v", err)
	}
	if _, err := testclock.Advance(c.TestClock.ID, &stripe.TestHelpersTestClockAdvanceParams{FrozenTime: stripe.Int64(at.Unix())}); err != nil {
		t.Fatal(err)
	}
	for range 30 {
		if clk, err := testclock.Get(c.TestClock.ID, nil); err == nil && clk.Status == stripe.TestHelpersTestClockStatusReady {
			return
		}
		time.Sleep(time.Second)
	}
	t.Fatal("test clock not ready")
}

// stSetDefault saves pm on the account and makes it the default.
func stSetDefault(t *testing.T, s *Service, uid, cus, pm string) string {
	t.Helper()
	got, err := paymentmethod.Attach(pm, &stripe.PaymentMethodAttachParams{Customer: stripe.String(cus)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := customer.Update(cus, &stripe.CustomerParams{InvoiceSettings: &stripe.CustomerInvoiceSettingsParams{DefaultPaymentMethod: stripe.String(got.ID)}}); err != nil {
		t.Fatal(err)
	}
	s.Store.UpdateCustomer(context.Background(), uid, func(c *store.Customer) error { c.DefaultPaymentMethod = got.ID; return nil })
	return got.ID
}

// Item 3: a paid web group's invoice lists its runs and is paid by the
// group's own PaymentIntent (attach_payment): one charge on the customer
// before and after, the job run twice.
func TestStripeTestWebGroupInvoice(t *testing.T) {
	s := stService(t)
	ctx := context.Background()
	uid, cus, _ := stCustomer(t, s, "group-invoice", "pm_card_visa")
	b := offBatch(t, s, uid, "proj_stripetest", 1000, 700)
	got, err := s.chargeBatch(ctx, b)
	if err != nil || got.State != store.BatchPaid {
		t.Fatalf("%v %s", err, got.State)
	}
	if n := stCharges(t, cus); n != 1 {
		t.Fatalf("%d charges after the group", n)
	}
	// The customer's test clock stands still at its creation; the invoice's
	// effective date is the payment's (now). Move the clock past it.
	stAdvanceClock(t, cus, time.Now().Add(2*time.Minute))
	chID := store.ChargeGroup + "_" + b.ID
	for i := range 2 {
		ok := s.runInvoiceJob(ctx, chID)
		ch, _ := s.Store.GetCharge(ctx, chID)
		t.Logf("evidence: invoice job %d done=%v state=%s invoice=%s err=%s", i, ok, ch.InvoiceState, ch.InvoiceID, ch.InvoiceError)
		if ch.InvoiceState != store.InvoiceDone {
			t.Fatalf("invoice %s: %s", ch.InvoiceState, ch.InvoiceError)
		}
	}
	ch, _ := s.Store.GetCharge(ctx, chID)
	p := &stripe.InvoiceParams{}
	p.AddExpand("lines")
	inv, err := invoice.Get(ch.InvoiceID, p)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("evidence: invoice %s status %s total %d paid %d out_of_band %v lines %d", inv.ID, inv.Status, inv.Total, inv.AmountPaid,
		inv.PaidOutOfBand, len(inv.Lines.Data))
	pis := stPIs(t, cus)
	if inv.Status != stripe.InvoiceStatusPaid || inv.AmountPaid != 1700 || len(inv.Lines.Data) != 2 || stCharges(t, cus) != 1 ||
		countStatus(pis, stripe.PaymentIntentStatusSucceeded) != 1 {
		t.Fatalf("invoice %s paid %d lines %d charges %d PIs %d", inv.Status, inv.AmountPaid, len(inv.Lines.Data), stCharges(t, cus), len(pis))
	}
	// Finalizing makes the invoice's own PaymentIntent; attaching the
	// group's payment cancels it unconfirmed. It never charges.
	for _, pi := range pis {
		switch {
		case pi.ID == got.PaymentIntentID && pi.Status == stripe.PaymentIntentStatusSucceeded:
		case pi.Status == stripe.PaymentIntentStatusCanceled && pi.AmountReceived == 0 && pi.LatestCharge == nil:
			t.Logf("evidence: invoice's own PI %s canceled, never charged", pi.ID)
		default:
			t.Fatalf("unexpected PI %s %s received %d", pi.ID, pi.Status, pi.AmountReceived)
		}
	}
}

// Items 1 and 4 on real Stripe: 0341 fails the web group with a schedule
// and a settle pay link; the +24 h retry declines under a new settle's
// key; with a working card saved the +72 h retry pays once, the receipt
// claimed.
func TestStripeTestWebGroupRetrySchedule(t *testing.T) {
	s := stService(t)
	ctx := context.Background()
	uid, cus, _ := stCustomer(t, s, "group-retry", "pm_card_chargeCustomerFail")
	b := offBatch(t, s, uid, "proj_stripetest", 1200)
	got, _ := s.chargeBatch(ctx, b)
	if got.State != store.BatchFailed || got.Retry == nil || got.Retry.State != store.RetryPending || got.Retry.PayRequestID == "" {
		t.Fatalf("%s %+v", got.State, got.Retry)
	}
	due := func() {
		past := time.Now().UTC().Add(-time.Second)
		s.Store.TransitionBatch(ctx, b.ID, []string{store.BatchFailed}, func(bb *store.Batch) error { bb.Retry.NextAttemptAt = &past; return nil }, nil, nil)
		s.settleSweep(ctx)
	}
	due()
	got, _ = s.Store.GetBatch(ctx, b.ID)
	if got.State != store.BatchFailed || got.Retry.Attempts != 2 || got.Retry.State != store.RetryPending {
		t.Fatalf("after the +24 h try: %s %+v", got.State, got.Retry)
	}
	stSetDefault(t, s, uid, cus, "pm_card_visa")
	due()
	got, _ = s.Store.GetBatch(ctx, b.ID)
	pis := stPIs(t, cus)
	t.Logf("evidence: group %s %s retry %s attempts %d settle %s", b.ID, got.State, got.Retry.State, got.Retry.Attempts, got.SettleID)
	if got.State != store.BatchPaid || got.Retry.State != store.RetryPaid || countStatus(pis, stripe.PaymentIntentStatusSucceeded) != 1 ||
		s.owedCents(ctx, uid) != 0 || !mailed(s, "E20_"+got.SettleID) {
		t.Fatalf("%s %+v PIs %d", got.State, got.Retry, len(pis))
	}
	for _, pi := range pis {
		if pi.Status == stripe.PaymentIntentStatusRequiresPaymentMethod {
			t.Fatalf("PI %s left open", pi.ID)
		}
		if pi.PaymentMethodConfigurationDetails == nil || pi.PaymentMethodConfigurationDetails.ID != s.Cfg.StripePMCWeb {
			t.Fatalf("PI %s not under pmc_web", pi.ID)
		}
	}
	s.settleSweep(ctx)
	if n := len(stPIs(t, cus)); n != len(pis) {
		t.Fatal("charged after paying")
	}
}

// Item 2 (B6) on real Stripe: the group's charge went out and its answer
// was lost, then the default changed. A re-drive of a group with its
// method recorded replays that request; one recorded before B6 gets
// idempotency_error and adopts the PaymentIntent the key made. One
// charge either way.
func TestStripeTestWebGroupRedrive(t *testing.T) {
	s := stService(t)
	ctx := context.Background()
	for _, recorded := range []bool{true, false} {
		name := "group-redrive-legacy"
		if recorded {
			name = "group-redrive-recorded"
		}
		t.Run(name, func(t *testing.T) {
			uid, cus, ids := stCustomer(t, s, name, "pm_card_visa")
			b := offBatch(t, s, uid, "proj_stripetest", 1100)
			cust, _ := s.Store.GetCustomer(ctx, uid)
			if recorded {
				s.Store.TransitionBatch(ctx, b.ID, []string{store.BatchCharging}, func(bb *store.Batch) error { bb.ChargePM = ids[0]; return nil }, nil, nil)
			}
			job := stripex.Job{Web: true, BatchID: b.ID, UID: b.UID, Description: batchDescription(b), Metadata: batchMetadata(b),
				ReceiptEmail: cust.Email, PMC: s.Cfg.StripePMCWeb}
			first, err := s.Stripe.ChargeSaved(cus, ids[0], b.TotalCents, b.Currency, job) // sent; the answer "lost"
			if err != nil || first.Status != stripe.PaymentIntentStatusSucceeded {
				t.Fatalf("first send: %v", err)
			}
			stSetDefault(t, s, uid, cus, "pm_card_mastercard")
			b, _ = s.Store.GetBatch(ctx, b.ID)
			got, err := s.chargeBatch(ctx, b)
			pis := stPIs(t, cus)
			t.Logf("evidence: re-drive %s state %s pi %s (first %s)", name, got.State, got.PaymentIntentID, first.ID)
			if err != nil || got.State != store.BatchPaid || got.PaymentIntentID != first.ID || len(pis) != 1 || stCharges(t, cus) != 1 {
				t.Fatalf("%v %s PIs %d", err, got.State, len(pis))
			}
		})
	}
}
