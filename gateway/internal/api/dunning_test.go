package api

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func invJSON(id, sub, reason string, attempt int, next int64) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"id": id, "object": "invoice", "status": "open", "amount_due": 29900, "currency": "usd",
		"attempt_count": attempt, "next_payment_attempt": next, "hosted_invoice_url": "https://invoice.example/" + id, "billing_reason": reason,
		"parent": map[string]any{"subscription_details": map[string]any{"subscription": sub}}})
	return b
}

// D5: a renewal that fails mails RN1 (once) with the invoice's pay link;
// a bank check mails RN2; the plan reads past_due with the next try while
// its benefits stay on; paid, it clears; ended unpaid, the app's
// entitlement ends at the cancel.
func TestRenewalDunning(t *testing.T) {
	f := newPlanFixture(t, "business", "business", 29900, 29, 30)
	ctx := context.Background()
	f.fake.invs["in_r1"] = map[string]any{"id": "in_r1", "object": "invoice", "status": "open", "amount_due": 29900,
		"hosted_invoice_url": "https://invoice.example/in_r1"}
	f.fake.subs[f.sub]["status"] = "past_due"
	next := time.Now().Add(72 * time.Hour).Unix()
	for i := 0; i < 2; i++ { // the event twice
		f.s.handlePlanInvoiceFailed(ctx, "invoice.payment_failed", invJSON("in_r1", f.sub, "subscription_cycle", 1, next))
	}
	plan := f.s.planJSON(ctx, f.uid)
	if plan["past_due"] != true || plan["active"] != true || plan["payment_failed_at"] == nil || plan["pay_url"] == nil ||
		plan["next_payment_attempt_at"] != time.Unix(next, 0).UTC().Format(time.RFC3339) || plan["amount_due_cents"] != int64(29900) {
		t.Fatalf("plan %v", plan)
	}
	if !mailed(f.s, "RN1_in_r1") {
		t.Fatal("no RN1")
	}
	if at := f.s.accountTier(ctx, f.uid); at.Tier != "business" {
		t.Fatalf("benefits off while past_due: %+v", at)
	}
	tok := tokenOf(t, plan["pay_url"].(string))
	if code, out := payCall(t, f.s.HandlePayRequestCheckout, "POST", tok, `{}`); code != 200 || out["url"] != "https://invoice.example/in_r1" {
		t.Fatalf("pay %d %v", code, out)
	}
	f.s.handlePlanInvoiceFailed(ctx, "invoice.payment_action_required", invJSON("in_r1", f.sub, "subscription_cycle", 1, next))
	if !mailed(f.s, "RN2_in_r1") || f.s.planJSON(ctx, f.uid)["action_required"] != true {
		t.Fatal("no RN2 / action_required")
	}
	// a step-up invoice is the step-up's business, not dunning
	f.s.handlePlanInvoiceFailed(ctx, "invoice.payment_failed", invJSON("in_su", f.sub, "subscription_update", 1, next))
	if mailed(f.s, "RN1_in_su") {
		t.Fatal("dunning mail for a step-up invoice")
	}
	// paid: cleared, the link closes
	f.fake.subs[f.sub]["status"] = "active"
	paid, _ := json.Marshal(map[string]any{"id": "in_r1", "subscription": f.sub, "lines": map[string]any{"data": []any{map[string]any{"amount": 29900}}}})
	f.s.handlePlanInvoicePaid(ctx, paid)
	plan = f.s.planJSON(ctx, f.uid)
	if plan["past_due"] != false || plan["payment_failed_at"] != nil {
		t.Fatalf("after paying %v", plan)
	}
	if pr, _ := f.s.Store.GetPayRequest(ctx, tok); pr.State != store.PayPaid {
		t.Fatalf("link %s", pr.State)
	}
}

func TestRenewalEndsUnpaid(t *testing.T) {
	f := newPlanFixture(t, "business", "business", 29900, 29, 30)
	ctx := context.Background()
	f.fake.subs[f.sub]["status"] = "past_due"
	f.s.handlePlanInvoiceFailed(ctx, "invoice.payment_failed", invJSON("in_r2", f.sub, "subscription_cycle", 4, 0))
	if !mailed(f.s, "RN1_in_r2") {
		t.Fatal("no RN1")
	}
	f.fake.subs[f.sub]["status"] = "canceled"
	raw, _ := json.Marshal(f.fake.subs[f.sub])
	f.s.handleSubscriptionEvent(ctx, raw)
	c, _ := f.s.Store.GetCustomer(ctx, f.uid)
	if c.Plan.Status != "canceled" || c.Plan.Active(time.Now()) || c.Plan.Dunning == nil || c.Plan.Dunning.RevokedAt == nil {
		t.Fatalf("plan %+v dunning %+v", c.Plan, c.Plan.Dunning)
	}
}
