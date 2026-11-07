package api

import (
	"context"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// D4: a step-up whose payment fails isn't retried by us: its 402 carries
// the pay link (details.pay_url) and SU1 mails it; the quote's next try
// gets a fresh idempotency key (never Stripe's cached 402).
func TestStepUpFailureMailsPayLink(t *testing.T) {
	f := newPlanFixture(t, "pro_monthly", "pro", 499, 10, 30)
	ctx := context.Background()
	f.fake.failNextChange = true
	code, out := f.post(f.s.HandlePlanChange, `{"to":"pro_yearly","confirm":true}`)
	d, _ := out["details"].(map[string]any)
	if code != 402 || d == nil || !strings.Contains(d["pay_url"].(string), "/pay/pr_") {
		t.Fatalf("%d %v", code, out)
	}
	tok := tokenOf(t, d["pay_url"].(string))
	pr, _ := f.s.Store.GetPayRequest(ctx, tok)
	if pr.Kind != store.PayKindStepUp || pr.PlanTo != "pro_yearly" || pr.SourceID != f.sub+":pro_yearly" {
		t.Fatalf("%+v", pr)
	}
	if !anyMail(f.s, "SU1_"+tok) {
		t.Fatal("no SU1")
	}
	base := "planchange_" + f.sub + "_pro_yearly_123"
	if f.s.stepUpKey(ctx, base) != base {
		t.Fatal("fresh quote key")
	}
	f.s.Store.AddPlanChangeFail(ctx, base)
	if got := f.s.stepUpKey(ctx, base); got != base+"_a1" {
		t.Fatalf("after a failure: %s", got)
	}
}

func anyMail(s *Service, prefix string) bool {
	for d := int64(-5); d <= 5; d++ {
		if mailed(s, prefix+"_"+itoa(int(time.Now().Unix()+d))) {
			return true
		}
	}
	return false
}

// The pay page for a step-up: today's price, paid on-session; the change
// is then made with that payment as a credit on its invoice (no second
// charge), once, however often the event comes.
func TestStepUpPaidOnPayPage(t *testing.T) {
	f := newPlanFixture(t, "pro_monthly", "pro", 499, 10, 30)
	ctx := context.Background()
	f.s.Cfg.StripePMCWeb = "pmc_test"
	f.fake.failNextChange = true
	_, out := f.post(f.s.HandlePlanChange, `{"to":"pro_yearly","confirm":true}`)
	tok := tokenOf(t, out["details"].(map[string]any)["pay_url"].(string))
	_, got := payCall(t, f.s.HandleGetPayRequest, "GET", tok, "")
	today := got["amount_cents"].(float64)
	if got["state"] != "open" || today <= 0 {
		t.Fatalf("GET %v", got)
	}
	code, co := payCall(t, f.s.HandlePayRequestCheckout, "POST", tok, `{}`)
	if code != 200 || co["checkout"] == nil {
		t.Fatalf("checkout %d %v", code, co)
	}
	form := f.fake.sessionForms[len(f.fake.sessionForms)-1]
	if form["metadata[kind]"] != "stepup" || form["metadata[plan_to]"] != "pro_yearly" || form["metadata[pay_request]"] != tok {
		t.Fatalf("session %v", form)
	}
	// paid: the session's PaymentIntent took 3000 (the fake's amount)
	f.fake.addSession("cs_su", "complete", "succeeded")
	md := map[string]string{"kind": "stepup", "pay_request": tok, "user_id": f.uid, "plan_to": "pro_yearly",
		"quote_at": form["metadata[quote_at]"], "credit_cents": form["metadata[credit_cents]"]}
	updatesBefore := len(f.fake.subUpdates)
	for i := 0; i < 2; i++ { // the event twice
		if err := f.s.applyStepUpSession(ctx, "checkout.session.completed", "cs_su", md); err != nil {
			t.Fatal(err)
		}
	}
	if len(f.fake.subUpdates) != updatesBefore+1 {
		t.Fatalf("changes %d", len(f.fake.subUpdates)-updatesBefore)
	}
	paidCredit := false
	for _, amt := range f.fake.invItems {
		if amt == -3000 {
			paidCredit = true
		}
	}
	if !paidCredit {
		t.Fatalf("the payment isn't a credit on the change: %v", f.fake.invItems)
	}
	if pr, _ := f.s.Store.GetPayRequest(ctx, tok); pr.State != store.PayPaid || pr.CheckoutID != "cs_su" {
		t.Fatalf("%+v", pr)
	}
	if len(f.fake.refunds) != 0 {
		t.Fatalf("refunded %v", f.fake.refunds)
	}
	// a second paid session for the same link is refunded
	f.fake.addSession("cs_su2", "complete", "succeeded")
	f.s.applyStepUpSession(ctx, "checkout.session.completed", "cs_su2", md)
	if len(f.fake.refunds) != 1 {
		t.Fatalf("a second payment wasn't refunded: %v", f.fake.refunds)
	}
}

// stepUpPaidFixture: a step-up whose card payment failed, its pay page's
// session opened and paid (cs_su); md is the session's metadata.
func stepUpPaidFixture(t *testing.T) (planFixture, string, map[string]string) {
	f := newPlanFixture(t, "pro_monthly", "pro", 499, 10, 30)
	f.s.Cfg.StripePMCWeb = "pmc_test"
	f.fake.failNextChange = true
	_, out := f.post(f.s.HandlePlanChange, `{"to":"pro_yearly","confirm":true}`)
	tok := tokenOf(t, out["details"].(map[string]any)["pay_url"].(string))
	if code, co := payCall(t, f.s.HandlePayRequestCheckout, "POST", tok, `{}`); code != 200 || co["checkout"] == nil {
		t.Fatalf("checkout %d %v", code, co)
	}
	form := f.fake.sessionForms[len(f.fake.sessionForms)-1]
	f.fake.addSession("cs_su", "complete", "succeeded")
	return f, tok, map[string]string{"kind": "stepup", "pay_request": tok, "user_id": f.uid, "plan_to": "pro_yearly",
		"quote_at": form["metadata[quote_at]"], "credit_cents": form["metadata[credit_cents]"]}
}

// REV-01: a delivery that fails after the claim leaves the request
// applying (the page says paid, nothing refunded); the next delivery
// makes the change, once.
func TestStepUpPaidFirstDeliveryFails(t *testing.T) {
	f, tok, md := stepUpPaidFixture(t)
	ctx := context.Background()
	before := len(f.fake.subUpdates)
	f.fake.changeDown = true
	if err := f.s.applyStepUpSession(ctx, "checkout.session.completed", "cs_su", md); err == nil {
		t.Fatal("a failed change answered 2xx: Stripe won't send it again")
	}
	pr, _ := f.s.Store.GetPayRequest(ctx, tok)
	if pr.State != store.PayApplying || pr.CheckoutID != "cs_su" || pr.ApplyLease != nil || pr.ApplyError == "" || len(f.fake.refunds) != 0 {
		t.Fatalf("after a failed first delivery: %+v refunds %v", pr, f.fake.refunds)
	}
	if _, got := payCall(t, f.s.HandleGetPayRequest, "GET", tok, ""); got["state"] != "paid" {
		t.Fatalf("page %v", got)
	}
	f.fake.changeDown = false
	for i := 0; i < 2; i++ { // Stripe's redelivery, then once more
		if err := f.s.applyStepUpSession(ctx, "checkout.session.completed", "cs_su", md); err != nil {
			t.Fatal(err)
		}
	}
	if pr, _ = f.s.Store.GetPayRequest(ctx, tok); pr.State != store.PayPaid || len(f.fake.subUpdates) != before+1 || len(f.fake.refunds) != 0 {
		t.Fatalf("after the redelivery: %+v changes %d refunds %v", pr, len(f.fake.subUpdates)-before, f.fake.refunds)
	}
	if c, _ := f.s.Store.GetCustomer(ctx, f.uid); c.Plan.Key() != "pro_yearly" {
		t.Fatalf("plan %s", c.Plan.Key())
	}
}

// REV-01: the sweep makes a change no delivery finished; one cut after the
// change was made is marked paid without a second change; one still
// failing two hours after the payment is refunded.
func TestStepUpApplySweep(t *testing.T) {
	ctx := context.Background()
	t.Run("applies", func(t *testing.T) {
		f, tok, md := stepUpPaidFixture(t)
		before := len(f.fake.subUpdates)
		f.fake.changeDown = true
		f.s.applyStepUpSession(ctx, "checkout.session.completed", "cs_su", md)
		f.fake.changeDown = false
		if n := f.s.stepUpApplySweep(ctx, time.Now()); n != 1 {
			t.Fatalf("swept %d", n)
		}
		if pr, _ := f.s.Store.GetPayRequest(ctx, tok); pr.State != store.PayPaid || len(f.fake.subUpdates) != before+1 {
			t.Fatalf("%+v", pr)
		}
	})
	t.Run("held lease", func(t *testing.T) {
		f, tok, md := stepUpPaidFixture(t)
		lease := time.Now().Add(time.Minute)
		now := time.Now().UTC()
		f.s.Store.UpdatePayRequest(ctx, tok, func(x *store.PayRequest) error {
			x.State, x.CheckoutID, x.ClaimedAt, x.ApplyLease, x.Apply = store.PayApplying, "cs_su", &now, &lease, map[string]string{"plan_to": md["plan_to"], "quote_at": md["quote_at"], "credit_cents": md["credit_cents"]}
			return nil
		})
		if err := f.s.applyStepUpSession(ctx, "checkout.session.completed", "cs_su", md); err != errStepUpBusy {
			t.Fatalf("a delivery during another attempt: %v", err)
		}
		if n := f.s.stepUpApplySweep(ctx, time.Now()); n != 0 {
			t.Fatalf("the sweep took a held one: %d", n)
		}
		if n := f.s.stepUpApplySweep(ctx, time.Now().Add(3*time.Minute)); n != 1 {
			t.Fatalf("the sweep left an expired lease: %d", n)
		}
	})
	t.Run("cut after the change", func(t *testing.T) {
		f, tok, md := stepUpPaidFixture(t)
		if err := f.s.applyStepUpSession(ctx, "checkout.session.completed", "cs_su", md); err != nil {
			t.Fatal(err)
		}
		f.s.Store.UpdatePayRequest(ctx, tok, func(x *store.PayRequest) error { // as if cut before "paid" was written
			x.State, x.ClosedAt, x.ApplyLease = store.PayApplying, nil, nil
			return nil
		})
		before := len(f.fake.subUpdates)
		if err := f.s.applyStepUpSession(ctx, "checkout.session.completed", "cs_su", md); err != nil {
			t.Fatal(err)
		}
		if pr, _ := f.s.Store.GetPayRequest(ctx, tok); pr.State != store.PayPaid || len(f.fake.subUpdates) != before || len(f.fake.refunds) != 0 {
			t.Fatalf("%+v changes %d refunds %v", pr, len(f.fake.subUpdates)-before, f.fake.refunds)
		}
	})
	t.Run("gives up", func(t *testing.T) {
		f, tok, md := stepUpPaidFixture(t)
		f.fake.changeDown = true
		f.s.applyStepUpSession(ctx, "checkout.session.completed", "cs_su", md)
		f.s.stepUpApplySweep(ctx, time.Now().Add(time.Hour))
		if len(f.fake.refunds) != 0 {
			t.Fatal("refunded inside the two hours")
		}
		f.s.stepUpApplySweep(ctx, time.Now().Add(3*time.Hour))
		pr, _ := f.s.Store.GetPayRequest(ctx, tok)
		if pr.State != store.PayVoid || len(f.fake.refunds) != 1 {
			t.Fatalf("not refunded after two hours: %+v %v", pr, f.fake.refunds)
		}
		// Stripe's late redelivery: nothing more
		f.fake.changeDown = false
		if err := f.s.applyStepUpSession(ctx, "checkout.session.completed", "cs_su", md); err != nil || len(f.fake.refunds) != 1 {
			t.Fatalf("redelivery after the refund: %v %v", err, f.fake.refunds)
		}
	})
}

// REV-19: a quote that is no longer a step-up is refunded with a reason,
// not a typed nil.
func TestStepUpNoLongerStepUpRefunded(t *testing.T) {
	f, tok, md := stepUpPaidFixture(t)
	ctx := context.Background()
	md["plan_to"] = "pro_weekly" // from monthly: a step-down
	if err := f.s.applyStepUpSession(ctx, "checkout.session.completed", "cs_su", md); err != nil {
		t.Fatal(err)
	}
	pr, _ := f.s.Store.GetPayRequest(ctx, tok)
	if pr.State != store.PayVoid || pr.ApplyError != "no longer a step-up" || len(f.fake.refunds) != 1 {
		t.Fatalf("%+v %v", pr, f.fake.refunds)
	}
}
