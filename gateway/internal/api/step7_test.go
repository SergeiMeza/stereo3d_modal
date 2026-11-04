package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/revenuecat"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// M8: issued URLs and reported plays are logged (country, salted IP
// hash, user agent; never the IP) and show in the case evidence.
func TestDownloadLogFeedsEvidence(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Cfg.ReconcileToken = "tok"
	s.Downloads = s.Store.NewDownloadLog(time.Hour)
	uid := "u" + store.NewID()
	conv := &store.Conversion{ID: store.NewID(), UID: uid, State: store.StateSucceeded, Kind: "video"}
	s.Store.CreateConversion(ctx, conv)
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("X-Forwarded-For", "203.0.113.9")
	r.Header.Set("X-Client-Region", "jp")
	r.Header.Set("User-Agent", "Mozilla/5.0 (Quest 3)")
	s.logIssued(r, conv, []outputFile{{Name: "sbs", Filename: "Kyoto_3D.mp4"}})
	rec := httptest.NewRecorder()
	r2 := httptest.NewRequest("POST", "/", strings.NewReader(`{"file":"Kyoto_3D.mp4","kind":"view_in_3d"}`))
	r2.Header.Set("X-Forwarded-For", "203.0.113.9")
	s.HandleLogPlay(rec, r2, &AuthedUser{UID: uid}, conv.ID)
	if rec.Code != 200 {
		t.Fatalf("play: %d %s", rec.Code, rec.Body)
	}
	s.Downloads.Flush(ctx)
	rows, err := s.Store.ListDownloads(ctx, conv.ID, 10)
	if err != nil || len(rows) != 2 {
		t.Fatalf("rows %v %+v", err, rows)
	}
	if rows[0].IPCountry != "JP" || rows[0].IPHash == "" || strings.Contains(rows[0].IPHash, "203.0.113.9") || rows[0].IPHash != rows[1].IPHash {
		t.Fatalf("row %+v", rows[0])
	}
	if rows[0].ExpireAt.Sub(rows[0].At) != store.DownloadRetention {
		t.Fatal("13-month expiry")
	}
	ev := s.evidenceFor(ctx, &store.Case{ID: "CASE-X", UID: uid, Related: store.CaseRelated{ConversionIDs: []string{conv.ID}}})
	if d, ok := ev["downloads"].([]map[string]any); !ok || len(d) != 2 || d[1]["kind"] != store.DownloadPlay {
		t.Fatalf("evidence downloads %#v", ev["downloads"])
	}
}

// H/B11: a dispute blocks the card's fingerprint; another account with
// that card is refused at the gate, and a payment that still succeeds
// with it is refunded and flagged.
func TestBlockListGateAndWebhook(t *testing.T) {
	s, fake := e0Service(t)
	resetBlockCache()
	t.Cleanup(resetBlockCache)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	run := &store.Conversion{ID: store.NewID(), UID: uid, State: store.StateSucceeded, Kind: "video", Quote: store.Quote{AmountCents: 900, Currency: "usd"}}
	pi := "pi_b" + run.ID
	now := time.Now().UTC()
	run.Stripe = store.Stripe{Mode: store.BillingModeAutoPrecharge, PaymentIntentID: pi, PIStatus: store.PISucceeded, CapturedCents: 900, CapturedAt: &now}
	s.Store.CreateConversion(ctx, run)
	fake.pis[pi] = map[string]any{"status": "succeeded", "amount_received": 900, "fingerprint": "fp_bad",
		"metadata": map[string]string{"env": "test", "product": "svs-web", "user_id": uid, "conversion_id": run.ID}}
	raw := []byte(`{"id":"du_` + run.ID + `","amount":900,"reason":"fraudulent","status":"needs_response","payment_intent":"` + pi + `"}`)
	if err := s.handleDisputeEvent(ctx, "charge.dispute.created", raw); err != nil {
		t.Fatal(err)
	}
	cards, _ := s.Store.BlockedCards(ctx, 10)
	if len(cards) != 1 || cards[0].Fingerprint != "fp_bad" || cards[0].Reason != "dispute" {
		t.Fatalf("block list %+v", cards)
	}
	// Another account, same card as its default: refused at the gate.
	other := "u" + store.NewID()
	s.Store.PutCustomer(ctx, other, &store.Customer{StripeCustomerID: "cus_2", DefaultPaymentMethod: "pm_same", DefaultMethodType: "card"})
	fake.pmPrints["pm_same"] = "fp_bad"
	if _, err := s.requireRunnable(ctx, &AuthedUser{UID: other}); err == nil || !strings.Contains(err.Error(), "can't be used") {
		t.Fatalf("gate: %v", err)
	}
	// A payment with it that succeeds anyway: refunded in full, under review.
	run2 := &store.Conversion{ID: store.NewID(), UID: other, State: store.StatePaid, Kind: "video", Quote: store.Quote{AmountCents: 600, Currency: "usd"}}
	pi2 := "pi_c" + run2.ID
	run2.Stripe = store.Stripe{Mode: store.BillingModeAutoPrecharge, PaymentIntentID: pi2, PIStatus: store.PISucceeded, CapturedCents: 600, CapturedAt: &now}
	s.Store.CreateConversion(ctx, run2)
	fake.pis[pi2] = map[string]any{"status": "succeeded", "amount_received": 600, "fingerprint": "fp_bad",
		"metadata": map[string]string{"env": "test", "product": "svs-web", "user_id": other, "conversion_id": run2.ID}}
	s.checkBlockedPayment(ctx, pi2)
	cust, _ := s.Store.GetCustomer(ctx, other)
	if !cust.UnderReview {
		t.Fatal("flagged: under review")
	}
	rows, _ := s.Store.ListRefundRows(ctx, pi2)
	if len(rows) != 1 || rows[0].TotalCents != 600 {
		t.Fatalf("refund rows %+v", rows)
	}
}

// N8 step 3 / B12: with cash in the balance, "Delete and refund" opens
// the closure case and the account stays until it is decided; deciding
// it deletes the account.
func TestDeletionWaitsForClosureCase(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	paidTopup(t, s, uid, 2000)
	del := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		s.HandleDeleteAccount(rec, httptest.NewRequest("POST", "/", strings.NewReader(body)), &AuthedUser{UID: uid})
		return rec
	}
	if rec := del(`{}`); rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "balance_remaining") {
		t.Fatalf("first: %d %s", rec.Code, rec.Body)
	}
	rec := del(`{"balance_confirmed":true}`)
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != http.StatusAccepted || out["deletion_pending"] != true || out["case_id"] == "" {
		t.Fatalf("pending: %d %s", rec.Code, rec.Body)
	}
	caseID := out["case_id"].(string)
	cust, _ := s.Store.GetCustomer(ctx, uid)
	if !cust.DeletionPending || cust.AccountDeleted || cust.DeletionCaseID != caseID {
		t.Fatalf("customer %+v", cust)
	}
	if _, err := s.requireRunnable(ctx, &AuthedUser{UID: uid}); err == nil || !strings.Contains(err.Error(), "being deleted") {
		t.Fatalf("gate while pending: %v", err)
	}
	if again := del(`{"balance_confirmed":true}`); again.Code != http.StatusAccepted {
		t.Fatalf("again: %d", again.Code)
	}
	if n := s.finishPendingDeletions(ctx); n != 0 {
		t.Fatal("not decided yet")
	}
	cs, _ := s.Store.GetCase(ctx, caseID)
	if err := s.applyCaseAction(ctx, cs, caseActionReq{Action: "approve"}, "owner@x"); err != nil {
		t.Fatal(err)
	}
	if n := s.finishPendingDeletions(ctx); n != 1 {
		t.Fatalf("finished %d", n)
	}
	cust, _ = s.Store.GetCustomer(ctx, uid)
	if !cust.AccountDeleted || cust.DeletionPending {
		t.Fatalf("after decision %+v", cust)
	}
}

// M3: a succeeded payment with no record is refunded (flag 1); a run
// past its expiry and a paid top-up's ledger are checked; a dry run
// reports without refunding.
func TestM3Reconcile(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	paidTopup(t, s, uid, 1500)
	fake.pis["pi_orphan"] = map[string]any{"status": "succeeded", "amount_received": 400,
		"metadata": map[string]string{"env": "test", "product": "svs-web", "user_id": uid, "conversion_id": "c_missing"}}
	old := time.Now().Add(-2 * time.Hour)
	stale := &store.Conversion{ID: store.NewID(), UID: uid, State: store.StateCreated, Kind: "video", ExpiresAt: &old,
		Quote: store.Quote{AmountCents: 300, Currency: "usd"}}
	s.Store.CreateConversion(ctx, stale)

	dry := s.RunM3(ctx, time.Now().Add(-48*time.Hour), true)
	if dry.Counts["no_record"] != 1 || dry.Counts["run_past_expiry"] != 1 || len(fake.refunds) != 0 {
		t.Fatalf("dry: %+v refunds %v", dry, fake.refunds)
	}
	if dry.Counts["balance_mismatch"] != 0 || dry.Counts["topup_entries"] != 0 {
		t.Fatalf("ledger flagged: %+v", dry.Flags)
	}
	real := s.RunM3(ctx, time.Now().Add(-48*time.Hour), false)
	if real.Counts["no_record"] != 1 || len(fake.refunds) != 1 || fake.refunds[0] != "pi_orphan" {
		t.Fatalf("real: %+v refunds %v", real.Counts, fake.refunds)
	}
	// The money moved: the next run sees the payment refunded.
	fake.pis["pi_orphan"]["refunded"] = 400
	if again := s.RunM3(ctx, time.Now().Add(-48*time.Hour), false); again.Counts["no_record"] != 0 || len(fake.refunds) != 1 {
		t.Fatalf("again: %+v", again.Counts)
	}
}

// Web follow-ups: the free-preview period names what the allowance
// counts over; a top-up past the day's cap has its own code.
func TestPreviewPeriodAndTopupDailyCap(t *testing.T) {
	for key, want := range map[string]string{"": "first_project", "pro_weekly": "week", "pro_monthly": "month", "pro_yearly": "year",
		"pro_pass_3m": "pass", "pro_pass_6m": "pass", "pro_lifetime": "month", "business": "month", "studio": "month"} {
		if got := previewPeriod(key); got != want {
			t.Fatalf("%q: %s, want %s", key, got, want)
		}
	}
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	for i := 0; i < 10; i++ {
		paidTopup(t, s, uid, 9500)
	}
	rec := httptest.NewRecorder()
	s.HandleTopup(rec, httptest.NewRequest("POST", "/", strings.NewReader(`{"amount_cents":10000,"ui":"elements"}`)), &AuthedUser{UID: uid})
	var out struct {
		Error   string         `json:"error"`
		Details map[string]any `json:"details"`
	}
	json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != http.StatusUnprocessableEntity || out.Error != "topup_daily_cap" || out.Details["day_left_cents"] != float64(5000) {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

// Tier order studio > business > pro: a plan reached through RevenueCat
// gets the plan's rate and allowance, never Pro Monthly's; the Stripe
// mirror stays the plan's source, and the higher tier wins.
func TestTierOrderWithRevenueCat(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	bodies := map[string]string{}
	rc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(bodies[strings.TrimPrefix(r.URL.Path, "/v1/subscribers/")]))
	}))
	t.Cleanup(rc.Close)
	s.RevenueCat = revenuecat.New("k").WithBase(rc.URL, time.Now)
	until := time.Now().Add(20 * 24 * time.Hour).UTC().Format(time.RFC3339)
	// Business through "pro" only (no mirror yet): business, not pro_monthly.
	a := "u" + store.NewID()
	bodies[a] = `{"subscriber":{"entitlements":{"pro":{"expires_date":"` + until + `","product_identifier":"prod_VYiOG5FegIJiFK"}}}}`
	if at := s.accountTier(ctx, a); at.Tier != pricing.TierBusiness || at.AllowanceKey != "business" {
		t.Fatalf("rc business: %+v", at)
	}
	// Mirror says business, RevenueCat says studio: studio.
	b := "u" + store.NewID()
	end := time.Now().Add(20 * 24 * time.Hour)
	s.Store.PutCustomer(ctx, b, &store.Customer{StripeCustomerID: "cus_1", Plan: &store.Plan{Tier: "business", SubscriptionID: "sub_1", Status: "active", CurrentPeriodEnd: &end}})
	bodies[b] = `{"subscriber":{"entitlements":{"studio":{"expires_date":"` + until + `","product_identifier":"prod_VYiOZAbAXiJP29"},"pro":{"expires_date":"` + until + `","product_identifier":"prod_VYiOZAbAXiJP29"}}}}`
	if at := s.accountTier(ctx, b); at.Tier != pricing.TierStudio || at.AllowanceKey != "studio" {
		t.Fatalf("studio wins: %+v", at)
	}
	// Mirror business, RevenueCat plain Pro Monthly: business (with its credit plan).
	c := "u" + store.NewID()
	s.Store.PutCustomer(ctx, c, &store.Customer{StripeCustomerID: "cus_1", Plan: &store.Plan{Tier: "business", SubscriptionID: "sub_2", Status: "active", CurrentPeriodEnd: &end}})
	bodies[c] = `{"subscriber":{"entitlements":{"pro":{"expires_date":"` + until + `","product_identifier":"pro_subs_1m_v1"}}}}`
	if at := s.accountTier(ctx, c); at.Tier != pricing.TierBusiness || at.Plan == nil {
		t.Fatalf("mirror plan over Pro: %+v", at)
	}
}

// Option b: a paid plan invoice grants business AND pro until the
// period's end + 3 days, once per invoice; a full refund of that invoice
// revokes both (other promotional grants come back); M3 re-grants a
// missing one.
func TestPlanEntitlementGrants(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	var calls []string
	var mu sync.Mutex
	entitled := map[string]bool{}
	rc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == http.MethodPost {
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			calls = append(calls, fmt.Sprintf("%s %v", strings.TrimPrefix(r.URL.Path, "/v1/subscribers/"), body["end_time_ms"]))
			w.Write([]byte(`{}`))
			return
		}
		ents := map[string]any{}
		for e := range entitled {
			ents[e] = map[string]any{"expires_date": time.Now().Add(30 * 24 * time.Hour).UTC().Format(time.RFC3339), "product_identifier": "rc_promo_" + e}
		}
		json.NewEncoder(w).Encode(map[string]any{"subscriber": map[string]any{"entitlements": ents}})
	}))
	t.Cleanup(rc.Close)
	s.RevenueCat = revenuecat.New("sk_test_fake").WithBase(rc.URL, time.Now)
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	end := time.Now().Add(30 * 24 * time.Hour).Truncate(time.Second).UTC()
	fake.subs["sub_p1"] = map[string]any{"id": "sub_p1", "status": "active", "customer": "cus_1",
		"metadata":             map[string]string{"product": "svs-web", "env": "test", "user_id": uid, "plan": "business"},
		"current_period_start": time.Now().Unix(), "current_period_end": end.Unix()}
	paid := []byte(`{"id":"in_p1","subscription":"sub_p1"}`)
	s.handlePlanInvoicePaid(ctx, paid)
	s.handlePlanInvoicePaid(ctx, paid) // the same invoice again: no second grant
	wantEnd := fmt.Sprint(float64(end.Add(72 * time.Hour).UnixMilli()))
	if len(calls) != 2 || !strings.HasPrefix(calls[0], uid+"/entitlements/business/promotional") ||
		!strings.HasPrefix(calls[1], uid+"/entitlements/pro/promotional") || !strings.HasSuffix(calls[0], wantEnd) {
		t.Fatalf("grants %v (want end %s)", calls, wantEnd)
	}
	cust, _ := s.Store.GetCustomer(ctx, uid)
	if cust.Plan == nil || cust.Plan.RCGrantInvoice != "in_p1" || cust.Plan.RCGrantedUntil == nil {
		t.Fatalf("grant record %+v", cust.Plan)
	}
	if b, _ := s.Store.GetBalance(ctx, uid); b.BalanceCents <= 0 {
		t.Fatal("the plan credit still lands")
	}
	// M3: RevenueCat shows nothing → granted again.
	rep := &M3Report{Counts: map[string]int{}}
	s.m3Plans(ctx, rep, false)
	if rep.Counts["plan_entitlement_missing"] != 1 || len(calls) != 4 {
		t.Fatalf("m3 %+v %v", rep.Flags, calls)
	}
	entitled["business"], entitled["pro"] = true, true
	rep = &M3Report{Counts: map[string]int{}}
	s.m3Plans(ctx, rep, false)
	if rep.Counts["plan_entitlement_missing"] != 0 {
		t.Fatal("entitled: no flag")
	}
	// A full refund of the plan invoice: its business and pro revoked
	// (nothing else promotional to give back here).
	fake.invPays["pi_plan"] = "in_p1"
	fake.invs["in_p1"] = map[string]any{"id": "in_p1", "amount_paid": 29900, "parent": map[string]any{"subscription_details": map[string]any{"subscription": "sub_p1"}}}
	fake.pis["pi_plan"] = map[string]any{"status": "succeeded", "amount_received": 29900, "refunded": 29900}
	if err := s.handleRefundEvent(ctx, "refund.created", []byte(`{"id":"re_plan","status":"succeeded","amount":29900,"payment_intent":"pi_plan"}`)); err != nil {
		t.Fatal(err)
	}
	if n := len(calls); !strings.HasPrefix(calls[n-2], uid+"/entitlements/business/revoke_promotionals") ||
		!strings.HasPrefix(calls[n-1], uid+"/entitlements/pro/revoke_promotionals") {
		t.Fatalf("revoke %v", calls)
	}
	cust, _ = s.Store.GetCustomer(ctx, uid)
	if cust.Plan.RCRevokedAt == nil {
		t.Fatal("revoke recorded")
	}
}

// Plan credit when a plan ends early: a refund we grant removes the
// unspent credit and refunds paid × unspent ÷ credit (rounded down), the
// plan ends; a dispute freezes the unheld credit (a held run still
// settles from it), lost removes it, won unfreezes it; a block freezes,
// an unblock unfreezes; deletion removes.
func TestPlanCreditEarlyEnd(t *testing.T) {
	if planShare(29900, 20000, 40000) != 14950 || planShare(29900, 13333, 40000) != 9966 || planShare(29900, 0, 40000) != 0 {
		t.Fatal("paid × unspent ÷ credit, rounded down")
	}
	s, fake := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	newPlan := func(inv, pi, sub string, spent int64) string {
		uid := "u" + store.NewID()
		end := time.Now().Add(20 * 24 * time.Hour)
		s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1", Plan: &store.Plan{Tier: "business", SubscriptionID: sub,
			Status: "active", CurrentPeriodEnd: &end, LastInvoiceID: inv, LastCreditCents: 40000}})
		ops := []store.BalanceOp{{Kind: store.EntryPlanCredit, Cents: 40000, Ref: sub, ExpiresAt: &end, EntryID: "plancredit_" + inv}}
		if spent > 0 {
			ops = append(ops, store.BalanceOp{Kind: store.EntryAdjustment, Cents: -spent, EntryID: "spent_" + inv})
		}
		if _, _, err := s.Store.BalanceTx(ctx, uid, func(*store.Balance) ([]store.BalanceOp, error) { return ops, nil }); err != nil {
			t.Fatal(err)
		}
		fake.invPays[pi] = inv
		fake.invs[inv] = map[string]any{"id": inv, "amount_paid": 29900, "parent": map[string]any{"subscription_details": map[string]any{"subscription": sub}}}
		fake.pis[pi] = map[string]any{"status": "succeeded", "amount_received": 29900}
		fake.subs[sub] = map[string]any{"id": sub, "status": "active", "metadata": map[string]string{"product": "svs-web", "env": "test", "user_id": uid, "plan": "business"}}
		return uid
	}

	// 2. A refund we grant: $200 of $400 left on $299 → $149.50.
	a := newPlan("in_a"+store.NewID(), "pi_a"+store.NewID(), "sub_a"+store.NewID(), 20000)
	cs, err := s.openPlanRefundCase(ctx, a, "owner@x", "wants out")
	if err != nil || cs.RequestedCents != 14950 {
		t.Fatalf("case %v %+v", err, cs)
	}
	if _, max := s.perRun(ctx, cs); max != 14950 {
		t.Fatalf("proposal %d", max)
	}
	if err := s.applyCaseAction(ctx, cs, caseActionReq{Action: "approve"}, "owner@x"); err != nil {
		t.Fatal(err)
	}
	b, _ := s.Store.GetBalance(ctx, a)
	rows, _ := s.Store.ListRefundRows(ctx, cs.Related.PIIDs[0])
	if b.PlanCreditCents() != 0 || len(rows) != 1 || rows[0].TotalCents != 14950 || fake.subs[fakeSubOf(fake, a)]["status"] != "canceled" {
		t.Fatalf("after refund: credit %d rows %+v", b.PlanCreditCents(), rows)
	}
	if ok, _ := s.Store.EntryExists(ctx, a, "plancredit_refund_"+cs.ID); !ok {
		t.Fatal("removal entry linked to the case")
	}

	// 3 + 7. A dispute freezes the unheld part; a held run still settles.
	d := newPlan("in_d"+store.NewID(), "pi_d"+store.NewID(), "sub_d"+store.NewID(), 0)
	held := &store.Conversion{ID: store.NewID(), UID: d, State: store.StatePaid, Kind: "video", PaymentFlow: store.FlowBalance,
		Quote: store.Quote{AmountCents: 15000, Currency: "usd"}, RunBalance: &store.RunBalance{HoldCents: 15000, State: store.HoldHeld}}
	held.Stripe.Mode = store.BillingModeBalance
	if _, err := s.Store.CreateConversionWithHold(ctx, held, 0); err != nil {
		t.Fatal(err)
	}
	piD := fakePIOf(fake, d)
	dp := "du_" + store.NewID()
	if err := s.handleDisputeEvent(ctx, "charge.dispute.created", []byte(`{"id":"`+dp+`","amount":29900,"status":"needs_response","payment_intent":"`+piD+`"}`)); err != nil {
		t.Fatal(err)
	}
	b, _ = s.Store.GetBalance(ctx, d)
	if b.PlanCreditFrozen() != 25000 || b.Available() != 0 {
		t.Fatalf("frozen %d available %d", b.PlanCreditFrozen(), b.Available())
	}
	s.Store.Transition(ctx, held.ID, []string{store.StatePaid}, func(c *store.Conversion) error {
		c.State = store.StateSucceeded
		c.RunBalance.SettleCents = 15000
		return nil
	})
	b, _ = s.Store.GetBalance(ctx, d)
	if b.PlanCreditCents() != 25000 || b.PlanCreditFrozen() != 25000 || b.HeldCents != 0 {
		t.Fatalf("after the held run: credit %d frozen %d held %d", b.PlanCreditCents(), b.PlanCreditFrozen(), b.HeldCents)
	}
	s.handleDisputeEvent(ctx, "charge.dispute.closed", []byte(`{"id":"`+dp+`","amount":29900,"status":"lost","payment_intent":"`+piD+`"}`))
	b, _ = s.Store.GetBalance(ctx, d)
	if b.PlanCreditCents() != 0 || b.FrozenCents != 0 || b.BalanceCents != 0 {
		t.Fatalf("lost: %+v", b)
	}

	// Won: unfrozen, still expiring at the period's end.
	w := newPlan("in_w"+store.NewID(), "pi_w"+store.NewID(), "sub_w"+store.NewID(), 10000)
	piW := fakePIOf(fake, w)
	dw := "du_" + store.NewID()
	s.handleDisputeEvent(ctx, "charge.dispute.created", []byte(`{"id":"`+dw+`","amount":29900,"status":"needs_response","payment_intent":"`+piW+`"}`))
	s.handleDisputeEvent(ctx, "charge.dispute.closed", []byte(`{"id":"`+dw+`","amount":29900,"status":"won","payment_intent":"`+piW+`"}`))
	b, _ = s.Store.GetBalance(ctx, w)
	if b.PlanCreditCents() != 30000 || b.PlanCreditFrozen() != 0 || b.Available() != 30000 {
		t.Fatalf("won: credit %d frozen %d", b.PlanCreditCents(), b.PlanCreditFrozen())
	}

	// 4. Block / unblock; 5. deletion.
	k := newPlan("in_k"+store.NewID(), "pi_k"+store.NewID(), "sub_k"+store.NewID(), 0)
	act := func(action string) {
		rec := httptest.NewRecorder()
		s.HandleAdminAccountAction(rec, httptest.NewRequest("POST", "/", strings.NewReader(`{"action":"`+action+`"}`)), &AdminUser{Email: "owner@x", AuthTime: time.Now()}, k)
		if rec.Code != 200 {
			t.Fatalf("%s: %d %s", action, rec.Code, rec.Body)
		}
	}
	act("block")
	if b, _ = s.Store.GetBalance(ctx, k); b.PlanCreditFrozen() != 40000 {
		t.Fatalf("block froze %d", b.PlanCreditFrozen())
	}
	act("unblock")
	if b, _ = s.Store.GetBalance(ctx, k); b.PlanCreditFrozen() != 0 || b.Available() != 40000 {
		t.Fatalf("unblock: %d", b.PlanCreditFrozen())
	}
	s.finishAccountDeletion(ctx, k)
	if b, _ = s.Store.GetBalance(ctx, k); b.PlanCreditCents() != 0 {
		t.Fatal("deletion removes the credit")
	}
}

func fakeSubOf(f *fakeStripe, uid string) string {
	for id, sub := range f.subs {
		if md, _ := sub["metadata"].(map[string]string); md["user_id"] == uid {
			return id
		}
	}
	return ""
}

func fakePIOf(f *fakeStripe, uid string) string {
	sub := fakeSubOf(f, uid)
	for pi, inv := range f.invPays {
		if p, _ := f.invs[inv]["parent"].(map[string]any); p != nil {
			if sd, _ := p["subscription_details"].(map[string]any); sd["subscription"] == sub {
				return pi
			}
		}
	}
	return ""
}
