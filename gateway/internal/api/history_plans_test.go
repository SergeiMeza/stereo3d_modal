package api

import (
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

func planInv(id, status, reason string, paid int64, md map[string]string, lines ...int64) stripex.PlanInvoice {
	inv := stripex.PlanInvoice{ID: id, Number: "N-" + id, Status: status, Total: paid, AmountPaid: paid, Currency: "usd",
		Created: time.Date(2026, 11, 5, 0, 24, 8, 0, time.UTC).Unix(), HostedInvoiceURL: "https://invoice.stripe.com/i/" + id,
		InvoicePDF: "https://pay.stripe.com/invoice/" + id + "/pdf", BillingReason: reason}
	inv.Parent.SubscriptionDetails.Subscription = "sub_1"
	inv.Parent.SubscriptionDetails.Metadata = md
	for _, l := range lines {
		inv.Lines.Data = append(inv.Lines.Data, struct {
			Description string `json:"description"`
			Amount      int64  `json:"amount"`
		}{Description: "line", Amount: l})
	}
	return inv
}

// Every plan invoice is a "plan" row with its invoice links and the
// paying PaymentIntent (for the receipt and card); a step-up adds a
// plan_change row and keeps its credit line; another env's or product's
// invoices and drafts stay out; a waiting step-down and the plans' credit
// show as rows without money.
func TestPlanHistoryRows(t *testing.T) {
	r := pricing.DefaultsFor("test")
	biz := map[string]string{"env": "test", "product": "svs-web", "kind": "plan", "plan": "business"}
	studio := map[string]string{"env": "test", "product": "svs-web", "plan": "studio", "changed_from": "business", "change_kind": changeStepUp}
	rows := planInvoiceRows(r, "test", []stripex.PlanInvoice{
		planInv("in_first", "paid", "subscription_create", 29900, biz, 29900),
		planInv("in_up", "paid", "subscription_update", 1098800, studio, 1198800, -100000),
		planInv("in_renew", "open", "subscription_cycle", 29900, biz, 29900),
		planInv("in_draft", "draft", "subscription_cycle", 29900, biz),
		planInv("in_prod", "paid", "subscription_create", 29900, map[string]string{"env": "prod", "product": "svs-web", "plan": "business"}),
		planInv("in_other", "paid", "subscription_create", 500, map[string]string{"env": "test", "product": "other"}),
	}, map[string]string{"in_first": "pi_first", "in_up": "pi_up"})
	byID := map[string]historyRow{}
	for _, row := range rows {
		byID[row.RowID] = row
	}
	if len(rows) != 4 {
		t.Fatalf("rows %d %+v", len(rows), rows)
	}
	first := byID["plan_in_first"]
	if first.Kind != "plan" || first.Label != "Business plan · monthly" || first.AmountCents != 29900 || first.Status != "paid" ||
		first.pi != "pi_first" || first.Invoice["hosted_invoice_url"] == "" || first.Invoice["invoice_pdf"] == "" ||
		first.Plan.Reason != "first" || first.Plan.InvoiceID != "in_first" {
		t.Fatalf("first %+v %+v", first, first.Plan)
	}
	up := byID["plan_in_up"]
	if up.Label != "Studio plan · yearly" || up.Plan.Reason != "change" || len(up.Lines) != 2 || up.Lines[1].AmountCents != -100000 {
		t.Fatalf("step-up %+v %+v", up, up.Lines)
	}
	if ch := byID["plan_change_in_up"]; ch.Kind != "plan_change" || ch.Label != "Business → Studio" || ch.AmountCents != 0 || ch.Change.Kind != changeStepUp {
		t.Fatalf("change %+v", ch)
	}
	if renew := byID["plan_in_renew"]; renew.Status != "payment_needed" || renew.Plan.Reason != "renewal" {
		t.Fatalf("renewal %+v", renew)
	}
	at := time.Date(2026, 12, 5, 0, 24, 8, 0, time.UTC)
	if sc := scheduledChangeRow(&store.Plan{Tier: "studio", SubscriptionID: "sub_1", ScheduledTo: "business", ScheduledAt: &at}); sc == nil ||
		sc.Status != "scheduled" || sc.Label != "Studio → Business" || !sc.Change.EffectiveAt.Equal(at) {
		t.Fatalf("scheduled %+v", sc)
	}
	if sc := scheduledChangeRow(&store.Plan{Tier: "business", SubscriptionID: "sub_1", CancelAtPeriodEnd: true, CurrentPeriodEnd: &at}); sc == nil || sc.Change.Kind != "cancel" || sc.Label != "Business → Pay per video" {
		t.Fatalf("cancel %+v", sc)
	}
	credit := creditRows([]store.Entry{{ID: "e1", Kind: store.EntryPlanCredit, Cents: 40000, Delta: 40000, At: at},
		{ID: "e2", Kind: store.EntryPlanCreditExpiry, Cents: 1200, Delta: -1200, At: at}, {ID: "e3", Kind: "run", Cents: 500}})
	if len(credit) != 2 || credit[0].Kind != "credit" || credit[0].Credit.Cents != 40000 || credit[0].AmountCents != 0 || credit[1].Credit.Kind != "expired" ||
		credit[0].Label != "Usage credit added · $400.00" {
		t.Fatalf("credit %+v", credit)
	}
	all := append(rows, credit...)
	if got := filterRows(all, "plan"); len(got) != len(all) {
		t.Fatalf("plan filter %d", len(got))
	}
	if got := filterRows(append(all, historyRow{Kind: "charge"}), "runs"); len(got) != 1 {
		t.Fatalf("runs filter %d", len(got))
	}
}
