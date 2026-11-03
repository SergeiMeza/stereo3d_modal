package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

func TestPlanMonths(t *testing.T) {
	start := time.Date(2026, 1, 31, 10, 0, 0, 0, time.UTC)
	end := start.AddDate(1, 0, 0)
	p := &store.Plan{Interval: "year", CurrentPeriodStart: &start, CurrentPeriodEnd: &end}
	for _, c := range []struct {
		now  time.Time
		k    int
		from string
		to   string
	}{
		{start, 0, "2026-01-31", "2026-02-28"},
		{time.Date(2026, 2, 28, 10, 0, 0, 0, time.UTC), 1, "2026-02-28", "2026-03-31"},
		{time.Date(2026, 12, 31, 9, 0, 0, 0, time.UTC), 10, "2026-11-30", "2026-12-31"},
		{time.Date(2026, 12, 31, 11, 0, 0, 0, time.UTC), 11, "2026-12-31", "2027-01-31"},
	} {
		k, from, to, ok := p.Month(c.now)
		if !ok || k != c.k || from.Format("2006-01-02") != c.from || to.Format("2006-01-02") != c.to {
			t.Errorf("%s: month %d %s→%s, want %d %s→%s", c.now, k, from.Format("2006-01-02"), to.Format("2006-01-02"), c.k, c.from, c.to)
		}
	}
}

// Yearly Studio: $1,500 each month from the scheduler, once per month;
// held back while a dispute is open, resumed after; free previews reset
// monthly; a refund proposal adds the months not yet started pro rata;
// /v1/pricing says "year".
func TestStudioYearly(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	rates := pricing.DefaultsFor("test")
	s.Pricing = pricing.NewStatic(rates)
	def, _ := rates.Plan(pricing.TierStudio)
	if !def.Yearly() || def.PriceCents != 1198800 || def.CreditCents != 150000 || def.FreePreviews != 200 {
		t.Fatalf("studio %+v", def)
	}
	uid := "u" + store.NewID()
	start := time.Now().UTC().AddDate(0, -2, -3) // in month 3 of 12
	end := start.AddDate(1, 0, 0)
	sub := "sub_y" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1", Plan: &store.Plan{Tier: "studio", SubscriptionID: sub, Status: "active",
		Interval: "year", CurrentPeriodStart: &start, CurrentPeriodEnd: &end, LastInvoiceID: "in_y" + sub}})
	if n := s.planMonthlySweep(ctx, time.Now().UTC()); n != 1 {
		t.Fatalf("granted %d", n)
	}
	if n := s.planMonthlySweep(ctx, time.Now().UTC()); n != 0 {
		t.Fatal("once per month")
	}
	b, _ := s.Store.GetBalance(ctx, uid)
	if b.PlanCreditCents() != 150000 {
		t.Fatalf("credit %d", b.PlanCreditCents())
	}
	if done, _ := s.Store.EntryExists(ctx, uid, planMonthEntry(sub, 2)); !done {
		t.Fatal("month 3 entry")
	}
	// Free previews: this month's window.
	at := s.accountTier(ctx, uid)
	if at.AllowanceKey != "studio" || at.PeriodKey != "plan:"+sub+":m02" || at.PeriodEnd == nil || !at.PeriodEnd.After(time.Now()) {
		t.Fatalf("tier %+v", at)
	}

	// Paused: no grant for a due month; resumed: granted.
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		c.Plan.CurrentPeriodStart = func() *time.Time { x := start.AddDate(0, -1, 0); return &x }() // month 4 now due
		return nil
	})
	s.setGrantsPaused(ctx, uid, "dispute:du_1")
	if n := s.planMonthlySweep(ctx, time.Now().UTC()); n != 0 {
		t.Fatal("paused: no grant")
	}
	s.setGrantsPaused(ctx, uid, "")
	if done, _ := s.Store.EntryExists(ctx, uid, planMonthEntry(sub, 3)); !done {
		t.Fatal("resume grants the due month")
	}

	// Refund proposal: this month's share + the months not yet started.
	pi := "pi_y" + sub
	fake.invPays[pi] = "in_y" + sub
	fake.invs["in_y"+sub] = map[string]any{"id": "in_y" + sub, "amount_paid": 1198800}
	fake.pis[pi] = map[string]any{"status": "succeeded", "amount_received": 1198800}
	s.Store.BalanceTx(ctx, uid, func(*store.Balance) ([]store.BalanceOp, error) {
		return []store.BalanceOp{{Kind: store.EntryAdjustment, Cents: -75000, EntryID: "spent_y"}}, nil
	})
	q, err := s.planRefundQuote(ctx, uid)
	if err != nil || !q.Yearly || q.MonthsNotStarted != 8 || q.UnspentCents != 75000 {
		t.Fatalf("quote %+v %v", q, err)
	}
	// 1198800 ÷ 12 = 99900 × 75000 ÷ 150000 = 49950; + 1198800 × 8 ÷ 12 = 799200
	if q.CurrentCents != 49950 || q.FutureCents != 799200 || q.ProposalCents != 849150 {
		t.Fatalf("proposal %+v", q)
	}
	cs, err := s.openPlanRefundCase(ctx, uid, "owner@x", "")
	if err != nil || cs.Mode != "manual" || cs.RequestedCents != 849150 {
		t.Fatalf("case %+v %v", cs, err)
	}

	// /v1/pricing: the plan bills yearly, the credit comes monthly.
	rec := httptest.NewRecorder()
	s.HandlePublicPricing(rec, httptest.NewRequest("GET", "/v1/pricing", nil))
	var out struct {
		Plans map[string]struct {
			Interval       string `json:"interval"`
			PriceCents     int64  `json:"price_cents"`
			CreditCents    int64  `json:"credit_cents"`
			CreditInterval string `json:"credit_interval"`
		} `json:"plans"`
	}
	json.Unmarshal(rec.Body.Bytes(), &out)
	st := out.Plans["studio"]
	if st.Interval != "year" || st.PriceCents != 1198800 || st.CreditCents != 150000 || st.CreditInterval != "month" ||
		out.Plans["business"].Interval != "month" || out.Plans["business"].PriceCents != 29900 {
		t.Fatalf("pricing %s", rec.Body.String()[:min(400, rec.Body.Len())])
	}
}

// invoice.created on a plan's draft invoice sets the web's statement line
// once; other products' invoices, other envs and finalized invoices are
// left alone.
func TestPlanInvoiceDescriptor(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	if stripex.WebStatementDescriptor != "SPATIAL AI* SV STUDIO" || len(stripex.WebStatementDescriptor) > 22 {
		t.Fatalf("descriptor %q", stripex.WebStatementDescriptor)
	}
	fake.subs["sub_d1"] = map[string]any{"id": "sub_d1", "status": "active", "customer": "cus_1",
		"metadata": map[string]string{"product": "svs-web", "env": "test", "user_id": "u1", "plan": "studio", "kind": "plan"}}
	fake.subs["sub_other"] = map[string]any{"id": "sub_other", "status": "active", "metadata": map[string]string{"product": "other-app"}}
	fake.invs["in_draft"] = map[string]any{"id": "in_draft", "status": "draft"}
	fake.invs["in_open"] = map[string]any{"id": "in_open", "status": "open"}
	fake.invs["in_other"] = map[string]any{"id": "in_other", "status": "draft"}
	fake.invs["in_md"] = map[string]any{"id": "in_md", "status": "draft"}

	event := func(id, status, sub string) json.RawMessage {
		b, _ := json.Marshal(map[string]any{"id": id, "status": status, "statement_descriptor": fake.invs[id]["statement_descriptor"],
			"parent": map[string]any{"subscription_details": map[string]any{"subscription": sub}}})
		return b
	}
	s.handlePlanInvoiceCreated(ctx, event("in_draft", "draft", "sub_d1"))
	if fake.invs["in_draft"]["statement_descriptor"] != "SPATIAL AI* SV STUDIO" || fake.descriptorSets != 1 {
		t.Fatalf("draft %v sets=%d", fake.invs["in_draft"], fake.descriptorSets)
	}
	s.handlePlanInvoiceCreated(ctx, event("in_draft", "draft", "sub_d1")) // redelivered: already set
	s.handlePlanInvoiceCreated(ctx, event("in_open", "open", "sub_d1"))   // the first invoice, finalized by Checkout
	s.handlePlanInvoiceCreated(ctx, event("in_other", "draft", "sub_other"))
	if fake.descriptorSets != 1 || fake.invs["in_other"]["statement_descriptor"] != nil {
		t.Fatalf("sets=%d other=%v", fake.descriptorSets, fake.invs["in_other"])
	}
	// The invoice's own copy of the subscription metadata is enough.
	b, _ := json.Marshal(map[string]any{"id": "in_md", "status": "draft", "parent": map[string]any{"subscription_details": map[string]any{
		"subscription": "sub_gone", "metadata": map[string]string{"product": "svs-web", "env": "test", "plan": "business"}}}})
	s.handlePlanInvoiceCreated(ctx, b)
	if fake.invs["in_md"]["statement_descriptor"] != "SPATIAL AI* SV STUDIO" {
		t.Fatalf("metadata path %v", fake.invs["in_md"])
	}
}
