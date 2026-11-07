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
