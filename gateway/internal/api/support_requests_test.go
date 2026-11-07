package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// supportIP is a valid address of its own (the per-address limit is
// process-wide).
func supportIP() string { return fmt.Sprintf("198.18.%d.%d", rand.IntN(254)+1, rand.IntN(254)+1) }

func callSupport(t *testing.T, h func(http.ResponseWriter, *http.Request, *AuthedUser), uid, method, body string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, "/", strings.NewReader(body))
	req.Header.Set("X-Forwarded-For", supportIP())
	h(rec, req, &AuthedUser{UID: uid, AuthTime: time.Now()})
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// paidRun stores a finished run paid by its own PaymentIntent paidAgo ago.
func paidRun(t *testing.T, s *Service, fake *fakeStripe, uid, state string, cents int64, paidAgo time.Duration, opts ...func(*store.Conversion)) *store.Conversion {
	t.Helper()
	at := time.Now().Add(-paidAgo).UTC()
	id := store.NewID()
	pi := "pi_" + id
	c := &store.Conversion{ID: id, UID: uid, State: state, Kind: "video", CreatedAt: at.Add(-time.Hour), UpdatedAt: at,
		Quote: store.Quote{AmountCents: cents, Currency: "usd"},
		Stripe: store.Stripe{Mode: store.BillingModeAutoPrecharge, PaymentIntentID: pi, PIStatus: store.PISucceeded,
			CapturedCents: cents, CapturedAt: &at}}
	for _, o := range opts {
		o(c)
	}
	if err := s.Store.CreateConversion(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	fake.pis[pi] = map[string]any{"status": "succeeded", "amount_received": cents}
	fake.mu.Unlock()
	return c
}

// planPaid gives uid a Business plan whose latest invoice was paid
// paidAgo ago.
func planPaid(t *testing.T, s *Service, fake *fakeStripe, uid string, paidAgo time.Duration, cancelled bool) string {
	t.Helper()
	inv, pi := "in_"+store.NewID(), "pi_"+store.NewID()
	start := time.Now().Add(-paidAgo).UTC()
	end := start.AddDate(0, 1, 0)
	if err := s.Store.PutCustomer(context.Background(), uid, &store.Customer{StripeCustomerID: "cus_s", Plan: &store.Plan{Tier: "business",
		SubscriptionID: "sub_" + inv, Status: "active", CurrentPeriodStart: &start, CurrentPeriodEnd: &end, CancelAtPeriodEnd: cancelled,
		LastInvoiceID: inv, LastCreditCents: 40000}}); err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	fake.invs[inv] = map[string]any{"id": inv, "status": "paid", "amount_paid": 29900, "status_transitions": map[string]any{"paid_at": start.Unix()}}
	fake.invPays[pi] = inv
	fake.pis[pi] = map[string]any{"status": "succeeded", "amount_received": 29900}
	fake.mu.Unlock()
	return inv
}

func optionIDs(out map[string]any) []string {
	var ids []string
	for _, r := range out["runs"].([]any) {
		ids = append(ids, r.(map[string]any)["conversion_id"].(string))
	}
	return ids
}

// Options: runs paid in the last 30 days that are finished, paid and not
// refunded; the plan's latest invoice in the window, a cancelled plan too.
func TestRefundOptions(t *testing.T) {
	s, fake, _, _ := promoService(t)
	uid := "u" + store.NewID()
	planPaid(t, s, fake, uid, 3*24*time.Hour, true)
	recent := paidRun(t, s, fake, uid, store.StateSucceeded, 1800, 5*24*time.Hour)
	paidRun(t, s, fake, uid, store.StateSucceeded, 1800, 40*24*time.Hour) // outside the window
	paidRun(t, s, fake, uid, store.StateProcessing, 1800, time.Hour)      // still running
	paidRun(t, s, fake, uid, store.StateSucceeded, 900, 24*time.Hour, func(c *store.Conversion) { c.Stripe.RefundedCents = 900 })

	code, out := callSupport(t, s.HandleRefundOptions, uid, "GET", "")
	if code != 200 || out["window_days"] != float64(30) {
		t.Fatalf("%d %v", code, out)
	}
	if ids := optionIDs(out); len(ids) != 1 || ids[0] != recent.ID {
		t.Fatalf("runs %v", ids)
	}
	plan, _ := out["plan"].(map[string]any)
	if plan == nil || plan["cancelled"] != true || plan["paid_cents"] != float64(29900) || plan["open_request_id"] != nil {
		t.Fatalf("plan %v", out["plan"])
	}
	// a plan paid 45 days ago: not offered
	old := "u" + store.NewID()
	planPaid(t, s, fake, old, 45*24*time.Hour, false)
	if _, out := callSupport(t, s.HandleRefundOptions, old, "GET", ""); out["plan"] != nil {
		t.Fatalf("old plan %v", out["plan"])
	}
}

// A request is always manual (even for a reason the policy refunds on its
// own), shown to the customer, and nothing is refunded; asking again joins
// the open case.
func TestRefundRequestManualAndMerged(t *testing.T) {
	s, fake, _, _ := promoService(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_m"})
	failed := paidRun(t, s, fake, uid, store.StateFailed, 2400, 2*24*time.Hour) // run_failed_undelivered: auto by policy
	code, out := callSupport(t, s.HandleRefundRequest, uid, "POST", `{"conversion_ids":["`+failed.ID+`"],"text":"It never finished."}`)
	if code != 201 {
		t.Fatalf("%d %v", code, out)
	}
	reqs := out["requests"].([]any)
	first := reqs[0].(map[string]any)
	if len(reqs) != 1 || first["merged"] != false || first["status"] != "We're looking at it" {
		t.Fatalf("requests %v", reqs)
	}
	cs, err := s.Store.GetCase(ctx, first["id"].(string))
	if err != nil || cs.Mode != "manual" || cs.Source != SourceCustomer || !cs.CustomerVisible || cs.CustomerText != "It never finished." || !cs.Open {
		t.Fatalf("case %+v %v", cs, err)
	}
	fake.mu.Lock()
	refunds := len(fake.refunds)
	fake.mu.Unlock()
	if refunds != 0 {
		t.Fatal("a customer request never refunds on its own")
	}
	// the options show it as asked
	_, opts := callSupport(t, s.HandleRefundOptions, uid, "GET", "")
	if r := opts["runs"].([]any)[0].(map[string]any); r["open_request_id"] != cs.ID {
		t.Fatalf("options %v", r)
	}
	// again: the same case, merged, its note on the timeline
	code, out = callSupport(t, s.HandleRefundRequest, uid, "POST", `{"conversion_ids":["`+failed.ID+`"],"text":"Any news?"}`)
	again := out["requests"].([]any)[0].(map[string]any)
	if code != 201 || again["id"] != cs.ID || again["merged"] != true {
		t.Fatalf("again %d %v", code, out)
	}
	evs, _ := s.Store.ListCaseEvents(ctx, cs.ID, 20)
	merged := 0
	for _, e := range evs {
		if e.Kind == "request_merged" && e.Text == "Any news?" {
			merged++
		}
	}
	if merged != 1 {
		t.Fatalf("events %+v", evs)
	}
}

// The plan's invoice: a manual plan_refund case from the customer, after
// cancelling too.
func TestRefundRequestPlan(t *testing.T) {
	s, fake, _, _ := promoService(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	inv := planPaid(t, s, fake, uid, 2*24*time.Hour, true)
	code, out := callSupport(t, s.HandleRefundRequest, uid, "POST", `{"plan":true,"text":"Cancelled, didn't use it."}`)
	if code != 201 {
		t.Fatalf("%d %v", code, out)
	}
	id := out["requests"].([]any)[0].(map[string]any)["id"].(string)
	cs, _ := s.Store.GetCase(ctx, id)
	if cs.Reason != ReasonPlanRefund || cs.Source != SourceCustomer || cs.Mode != "manual" || len(cs.Related.InvoiceIDs) != 1 || cs.Related.InvoiceIDs[0] != inv {
		t.Fatalf("case %+v", cs)
	}
	_, list := callSupport(t, s.HandleSupportRequests, uid, "GET", "")
	r := list["requests"].([]any)[0].(map[string]any)
	if r["id"] != id || r["about"] != "plan" || r["status"] != "We're looking at it" || r["your_note"] != "Cancelled, didn't use it." {
		t.Fatalf("list %v", r)
	}
}

// Refusals: not in the options, a long note, the daily limit, ten open
// requests, a deleted account.
func TestRefundRequestLimits(t *testing.T) {
	s, fake, _, _ := promoService(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_l"})
	old := paidRun(t, s, fake, uid, store.StateSucceeded, 1800, 35*24*time.Hour)
	code, out := callSupport(t, s.HandleRefundRequest, uid, "POST", `{"conversion_ids":["`+old.ID+`"]}`)
	if code != 400 || out["error"] != "not_refundable" {
		t.Fatalf("old run %d %v", code, out)
	}
	if code, out := callSupport(t, s.HandleRefundRequest, uid, "POST", `{"plan":true}`); code != 400 || out["error"] != "not_refundable" {
		t.Fatalf("no plan %d %v", code, out)
	}
	long := strings.Repeat("é", supportTextMax+1)
	run := paidRun(t, s, fake, uid, store.StateSucceeded, 1800, time.Hour)
	if code, out := callSupport(t, s.HandleRefundRequest, uid, "POST", `{"conversion_ids":["`+run.ID+`"],"text":"`+long+`"}`); code != 400 || out["error"] != "text_too_long" {
		t.Fatalf("long %d %v", code, out)
	}
	if code, _ := callSupport(t, s.HandleRefundRequest, uid, "POST", `{}`); code != 400 {
		t.Fatal("nothing picked")
	}
	// three a day (merges count too)
	for i := 0; i < refundRequestsPerDay; i++ {
		if code, out := callSupport(t, s.HandleRefundRequest, uid, "POST", `{"conversion_ids":["`+run.ID+`"]}`); code != 201 {
			t.Fatalf("try %d: %d %v", i+1, code, out)
		}
	}
	code, out = callSupport(t, s.HandleRefundRequest, uid, "POST", `{"conversion_ids":["`+run.ID+`"]}`)
	if d, _ := out["details"].(map[string]any); code != 429 || out["error"] != "rate_limited" || d["retry_after_s"] == nil {
		t.Fatalf("daily %d %v", code, out)
	}

	// ten open requests: an eleventh waits
	busy := "u" + store.NewID()
	s.Store.PutCustomer(ctx, busy, &store.Customer{StripeCustomerID: "cus_b"})
	for i := 0; i < refundRequestsOpenMax; i++ {
		if _, _, err := s.Store.CreateCase(ctx, &store.Case{UID: busy, Type: store.CaseRefund, Reason: ReasonSupport, Mode: "manual",
			Source: SourceCustomer, Status: store.CaseOpen, CustomerVisible: true, DedupeKey: fmt.Sprintf("seed:%s:%d", busy, i)}, "test", ""); err != nil {
			t.Fatal(err)
		}
	}
	r2 := paidRun(t, s, fake, busy, store.StateSucceeded, 1800, time.Hour)
	if code, out := callSupport(t, s.HandleRefundRequest, busy, "POST", `{"conversion_ids":["`+r2.ID+`"]}`); code != 409 || out["error"] != "too_many_open" {
		t.Fatalf("open %d %v", code, out)
	}

	// a deleted account
	gone := "u" + store.NewID()
	now := time.Now().UTC()
	s.Store.PutCustomer(ctx, gone, &store.Customer{StripeCustomerID: "cus_g", AccountDeleted: true, DeletedAt: &now})
	if code, out := callSupport(t, s.HandleRefundRequest, gone, "POST", `{"plan":true}`); code != 403 || out["error"] != "account_deleted" {
		t.Fatalf("deleted %d %v", code, out)
	}
	if code, _ := callSupport(t, s.HandleRefundOptions, gone, "GET", ""); code != 403 {
		t.Fatal("deleted options")
	}
}

// Ten an hour from one address.
func TestRefundRequestIPLimit(t *testing.T) {
	s, fake, _, _ := promoService(t)
	ip := supportIP()
	codes := map[int]int{}
	for i := 0; i < refundRequestsPerIPHour+1; i++ {
		uid := "u" + store.NewID()
		run := paidRun(t, s, fake, uid, store.StateSucceeded, 500, time.Hour)
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/", strings.NewReader(`{"conversion_ids":["`+run.ID+`"]}`))
		req.Header.Set("X-Forwarded-For", ip)
		s.HandleRefundRequest(rec, req, &AuthedUser{UID: uid, AuthTime: time.Now()})
		codes[rec.Code]++
	}
	if codes[201] != refundRequestsPerIPHour || codes[429] != 1 {
		t.Fatalf("by address %v", codes)
	}
}

// The customer's list in plain words; a question and its answer; a reply
// to a closed request opens a follow-up; another account's case is
// missing.
func TestSupportRequestsAndReply(t *testing.T) {
	s, fake, _, _ := promoService(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_q"})
	run := paidRun(t, s, fake, uid, store.StateSucceeded, 1800, time.Hour)
	_, out := callSupport(t, s.HandleRefundRequest, uid, "POST", `{"conversion_ids":["`+run.ID+`"],"text":"Blurry."}`)
	id := out["requests"].([]any)[0].(map[string]any)["id"].(string)
	cs, _ := s.Store.GetCase(ctx, id)

	// the admin asks a question
	if err := s.applyCaseAction(ctx, cs, caseActionReq{Action: "ask", Text: "Which part looks blurry?"}, "admin"); err != nil {
		t.Fatal(err)
	}
	_, list := callSupport(t, s.HandleSupportRequests, uid, "GET", "")
	r := list["requests"].([]any)[0].(map[string]any)
	if r["state"] != "asked" || r["status"] != "We asked you a question" || r["question"] != "Which part looks blurry?" || r["about"] != "runs" {
		t.Fatalf("asked %v", r)
	}
	code, rep := callSupport(t, func(w http.ResponseWriter, r *http.Request, u *AuthedUser) { s.HandleSupportReply(w, r, u, id) },
		uid, "POST", `{"text":"The second scene."}`)
	if code != 200 || rep["state"] != "looking" || rep["id"] != id {
		t.Fatalf("reply %d %v", code, rep)
	}
	evs, _ := s.Store.ListCaseEvents(ctx, id, 20)
	got := false
	for _, e := range evs {
		got = got || (e.Kind == "customer_message_in" && e.Who == SourceCustomer && e.Text == "The second scene.")
	}
	if !got {
		t.Fatalf("events %+v", evs)
	}

	// decided and closed: Not refunded; a reply opens a follow-up
	if err := s.applyCaseAction(ctx, cs, caseActionReq{Action: "no_refund"}, "admin"); err != nil {
		t.Fatal(err)
	}
	_, list = callSupport(t, s.HandleSupportRequests, uid, "GET", "")
	if r := list["requests"].([]any)[0].(map[string]any); r["status"] != "Not refunded" {
		t.Fatalf("closed %v", r)
	}
	code, rep = callSupport(t, func(w http.ResponseWriter, r *http.Request, u *AuthedUser) { s.HandleSupportReply(w, r, u, id) },
		uid, "POST", `{"text":"Please look again."}`)
	if code != 200 || rep["id"] == id || rep["follow_up_of"] != id || rep["state"] != "looking" {
		t.Fatalf("follow-up %d %v", code, rep)
	}

	// another account: missing
	other := "u" + store.NewID()
	code, rep = callSupport(t, func(w http.ResponseWriter, r *http.Request, u *AuthedUser) { s.HandleSupportReply(w, r, u, id) },
		other, "POST", `{"text":"hi"}`)
	if code != 404 || rep["error"] != "request_not_found" {
		t.Fatalf("other %d %v", code, rep)
	}
	if !ValidCaseID("CASE-0042") || ValidCaseID("CASE-42") || ValidCaseID("../x") {
		t.Fatal("case ids")
	}
}

// RF-02: a balance withdrawal is asked for like the rest. The options list
// the unspent top-ups of the last 14 days; balance: true opens a manual
// topup_withdrawal case per top-up and pays nothing; asking again merges.
func TestRefundRequestBalance(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_b"})
	if code, out := callSupport(t, s.HandleRefundRequest, uid, "POST", `{"balance":true}`); code != 400 || out["error"] != "not_refundable" {
		t.Fatalf("nothing to withdraw %d %v", code, out)
	}
	tp := paidTopup(t, s, uid, 2500)
	_, opts := callSupport(t, s.HandleRefundOptions, uid, "GET", "")
	bal, _ := opts["balance"].(map[string]any)
	if bal == nil || bal["unspent_cents"] != float64(2500) || bal["window_days"] != float64(14) {
		t.Fatalf("balance option %v", opts["balance"])
	}
	if row := bal["topups"].([]any)[0].(map[string]any); row["topup_id"] != tp.ID || row["open_request_id"] != nil {
		t.Fatalf("top-up row %v", row)
	}
	code, out := callSupport(t, s.HandleRefundRequest, uid, "POST", `{"balance":true,"text":"I won't use it."}`)
	if code != 201 {
		t.Fatalf("%d %v", code, out)
	}
	first := out["requests"].([]any)[0].(map[string]any)
	cs, err := s.Store.GetCase(ctx, first["id"].(string))
	if err != nil || cs.Mode != "manual" || cs.Type != store.CaseBalanceRefund || cs.Reason != ReasonTopupWithdraw || cs.Source != SourceCustomer || cs.RequestedCents != 2500 {
		t.Fatalf("case %+v %v", cs, err)
	}
	if b, _ := s.Store.GetBalance(ctx, uid); b.BalanceCents != 2500 || len(fake.refunds) != 0 {
		t.Fatalf("paid out without review: %d %v", b.BalanceCents, fake.refunds)
	}
	code, out = callSupport(t, s.HandleRefundRequest, uid, "POST", `{"balance":true,"text":"Any news?"}`)
	if again := out["requests"].([]any)[0].(map[string]any); code != 201 || again["id"] != cs.ID || again["merged"] != true {
		t.Fatalf("again %d %v", code, out)
	}
	_, opts = callSupport(t, s.HandleRefundOptions, uid, "GET", "")
	if row := opts["balance"].(map[string]any)["topups"].([]any)[0].(map[string]any); row["open_request_id"] != cs.ID {
		t.Fatalf("asked %v", row)
	}
}
