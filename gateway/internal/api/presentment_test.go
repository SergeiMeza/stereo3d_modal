package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

func sessionEvent(t *testing.T, id string, md map[string]string) json.RawMessage {
	t.Helper()
	md["env"], md["product"] = "test", "svs-web"
	raw, _ := json.Marshal(map[string]any{"id": id, "mode": "payment", "status": "complete", "payment_status": "paid", "metadata": md})
	return raw
}

func presentIn(fake *fakeStripe, session string, amount int64, currency string) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.sessions[session]["currency"] = "usd"
	fake.sessions[session]["presentment_details"] = map[string]any{"presentment_amount": amount, "presentment_currency": currency}
}

// Adaptive Pricing: a paid Checkout Session's presentment goes on the run
// once. A webhook retry or a later read keeps the first; a USD session
// (none, or presented in usd) leaves it nil. Amounts stay USD.
func TestPresentmentOnRun(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	fake.addSession("cs_jp", "complete", "succeeded")
	presentIn(fake, "cs_jp", 1648, "JPY")
	run := createdRun(t, s, &store.Payment{Kind: store.PaymentCheckoutSession, ID: "cs_jp", UI: "elements"})
	ev := sessionEvent(t, "cs_jp", map[string]string{"kind": "run", "conversion_id": run.ID})
	for i := 0; i < 2; i++ { // Stripe delivers twice
		if err := s.handleCheckoutEvent(ctx, "checkout.session.completed", ev); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := s.Store.GetConversion(ctx, run.ID)
	if got.State != store.StatePaid || got.Stripe.CapturedCents != 3000 || got.Stripe.Presentment == nil ||
		*got.Stripe.Presentment != (store.Presentment{AmountMinor: 1648, Currency: "jpy"}) {
		t.Fatalf("run %s %d %+v", got.State, got.Stripe.CapturedCents, got.Stripe.Presentment)
	}
	// set once: a later read showing something else changes nothing
	presentIn(fake, "cs_jp", 9999, "krw")
	s.handleCheckoutEvent(ctx, "checkout.session.async_payment_succeeded", ev)
	if got, _ = s.Store.GetConversion(ctx, run.ID); got.Stripe.Presentment.AmountMinor != 1648 {
		t.Fatalf("overwritten %+v", got.Stripe.Presentment)
	}
	// USD: no presentment at all, or Stripe's presentment in usd
	for i, mod := range []func(){func() {}, func() { presentIn(fake, "cs_usd1", 3000, "usd") }} {
		id := []string{"cs_usd0", "cs_usd1"}[i]
		fake.addSession(id, "complete", "succeeded")
		mod()
		r := createdRun(t, s, &store.Payment{Kind: store.PaymentCheckoutSession, ID: id, UI: "elements"})
		if err := s.handleCheckoutEvent(ctx, "checkout.session.completed", sessionEvent(t, id, map[string]string{"kind": "run", "conversion_id": r.ID})); err != nil {
			t.Fatal(err)
		}
		if got, _ := s.Store.GetConversion(ctx, r.ID); got.State != store.StatePaid || got.Stripe.Presentment != nil {
			t.Fatalf("usd %d: %s %+v", i, got.State, got.Stripe.Presentment)
		}
	}
}

// A paid top-up session: the presentment goes on the top-up once; the
// credit is the USD amount.
func TestPresentmentOnTopup(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	tp := &store.Topup{ID: "t" + store.NewID(), UID: uid, Cents: 3000, Currency: "usd", State: store.TopupOpen}
	if err := s.Store.CreateTopup(ctx, tp); err != nil {
		t.Fatal(err)
	}
	fake.addSession("cs_de", "complete", "succeeded")
	presentIn(fake, "cs_de", 2795, "eur")
	ev := sessionEvent(t, "cs_de", map[string]string{"kind": "topup", "topup_id": tp.ID})
	for i := 0; i < 2; i++ {
		if err := s.handleCheckoutEvent(ctx, "checkout.session.completed", ev); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := s.Store.GetTopup(ctx, tp.ID)
	bal, _ := s.Store.GetBalance(ctx, uid)
	if got.State != store.TopupPaid || got.Presentment == nil || *got.Presentment != (store.Presentment{AmountMinor: 2795, Currency: "eur"}) ||
		bal == nil || bal.BalanceCents != 3000 {
		t.Fatalf("topup %s %+v balance %+v", got.State, got.Presentment, bal)
	}
}

// The store's guard: once, and only for the PaymentIntent the record was
// paid with; every record kind; an unknown record is ErrNotFound.
func TestSetPresentmentGuard(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	jpy := store.Presentment{AmountMinor: 1648, Currency: "jpy"}
	tp := &store.Topup{ID: "t" + store.NewID(), UID: uid, Cents: 3000, Currency: "usd", State: store.TopupOpen, PaymentIntentID: "pi_topup"}
	if err := s.Store.CreateTopup(ctx, tp); err != nil {
		t.Fatal(err)
	}
	if set, err := s.Store.SetPresentment(ctx, store.PresentTopup, tp.ID, "pi_other", jpy); set || err != nil {
		t.Fatalf("another PaymentIntent %v %v", set, err)
	}
	if set, err := s.Store.SetPresentment(ctx, store.PresentTopup, tp.ID, "pi_topup", jpy); !set || err != nil {
		t.Fatalf("first %v %v", set, err)
	}
	if set, _ := s.Store.SetPresentment(ctx, store.PresentTopup, tp.ID, "pi_topup", store.Presentment{AmountMinor: 1, Currency: "krw"}); set {
		t.Fatal("set twice")
	}
	got, _ := s.Store.GetTopup(ctx, tp.ID)
	if got.Presentment == nil || *got.Presentment != jpy {
		t.Fatalf("topup %+v", got.Presentment)
	}
	if _, err := s.Store.SetPresentment(ctx, store.PresentRun, "nope", "pi", jpy); err != store.ErrNotFound {
		t.Fatalf("missing run: %v", err)
	}
	// an off-session outcome (no presentment) never writes
	tp2 := &store.Topup{ID: "t" + store.NewID(), UID: uid, Cents: 3000, Currency: "usd", State: store.TopupOpen, PaymentIntentID: "pi_auto"}
	s.Store.CreateTopup(ctx, tp2)
	if err := s.notePresentment(ctx, store.PresentTopup, tp2.ID, stripex.Outcome{Paid: true, PaymentIntentID: "pi_auto"}); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Store.GetTopup(ctx, tp2.ID); got.Presentment != nil {
		t.Fatalf("off-session wrote %+v", got.Presentment)
	}
	for _, kind := range []string{store.PresentSettle, store.PresentCharge} {
		if _, err := s.Store.SetPresentment(ctx, kind, "nope", "pi", jpy); err != store.ErrNotFound {
			t.Fatalf("%s missing: %v", kind, err)
		}
	}
}

// The contract: presentment {amount_minor, currency} | null on the run
// read (and so each run of a project), every history card row and the
// admin run; amount_cents stays USD.
func TestPresentmentFields(t *testing.T) {
	jpy := &store.Presentment{AmountMinor: 1648, Currency: "jpy"}
	now := time.Now()
	run := &store.Conversion{ID: "c1", State: store.StateSucceeded, Quote: store.Quote{AmountCents: 1000, Currency: "usd"},
		Stripe: store.Stripe{PaymentIntentID: "pi_c1", PIStatus: store.PISucceeded, CapturedCents: 1000, CapturedAt: &now, Presentment: jpy}}
	usd := &store.Conversion{ID: "c2", State: store.StateSucceeded, Quote: store.Quote{AmountCents: 500, Currency: "usd"},
		Stripe: store.Stripe{PaymentIntentID: "pi_c2", PIStatus: store.PISucceeded, CapturedCents: 500, CapturedAt: &now}}
	s := &Service{}
	for _, c := range []*store.Conversion{run, usd} {
		raw, _ := json.Marshal(s.conversionResponse(c, nil))
		var got map[string]any
		json.Unmarshal(raw, &got)
		p, present := got["presentment"]
		if !present || (c == run) != (p != nil) {
			t.Fatalf("%s: presentment %v (%v)", c.ID, p, present)
		}
		if c == run && (p.(map[string]any)["amount_minor"] != float64(1648) || p.(map[string]any)["currency"] != "jpy") {
			t.Fatalf("run %v", p)
		}
	}
	if adminRunJSON(run)["presentment"] != jpy {
		t.Fatal("admin run")
	}
	eur := &store.Presentment{AmountMinor: 2795, Currency: "eur"}
	rows := historyRows(nil,
		[]*store.Settle{{ID: "s1", State: store.SettlePaid, PaidCents: 2000, PaymentIntentID: "pi_s1", PaidAt: &now, Presentment: eur}},
		[]*store.Conversion{run, usd},
		&store.Topup{ID: "t1", State: store.TopupPaid, PaidCents: 3000, PaymentIntentID: "pi_t1", PaidAt: &now, Presentment: eur})
	want := map[string]*store.Presentment{store.ChargeID(store.ChargeRun, "c1"): jpy, store.ChargeID(store.ChargeRun, "c2"): nil,
		store.ChargeID(store.ChargeSettle, "s1"): eur, store.ChargeID(store.ChargeTopup, "t1"): eur}
	for _, r := range rows {
		w, ok := want[r.RowID]
		if !ok {
			t.Fatalf("row %s", r.RowID)
		}
		if r.Presentment != w {
			t.Fatalf("%s: %+v", r.RowID, r.Presentment)
		}
		raw, _ := json.Marshal(r)
		if !strings.Contains(string(raw), `"presentment":`) {
			t.Fatalf("%s has no presentment key: %s", r.RowID, raw)
		}
	}
}

// Refunds go back in USD and Stripe returns the presented currency at the
// original rate: a refund row keeps Stripe's refund presentment (set once,
// from the created refund); a fully refunded run's history refund row
// shows the original amount, negative like amount_cents; a partial one
// shows none.
func TestRefundPresentment(t *testing.T) {
	re := &stripex.RefundResult{Currency: "usd"}
	json.Unmarshal([]byte(`{"id":"re_1","status":"succeeded","amount":400,"currency":"usd","presentment_details":{"presentment_amount":659,"presentment_currency":"jpy"}}`), re)
	if p := re.Presentment(); p == nil || *p != (stripex.Presentment{AmountMinor: 659, Currency: "jpy"}) {
		t.Fatalf("refund %+v", p)
	}
	if (&stripex.RefundResult{Currency: "usd"}).Presentment() != nil {
		t.Fatal("usd refund")
	}
	now := time.Now()
	jpy := &store.Presentment{AmountMinor: 1648, Currency: "jpy"}
	full := &store.Conversion{ID: "f", State: store.StateFailed, Stripe: store.Stripe{PaymentIntentID: "pi_f", PIStatus: store.PIRefunded,
		CapturedCents: 1000, RefundedCents: 1000, CapturedAt: &now, RefundedAt: &now, Presentment: jpy}}
	part := &store.Conversion{ID: "p", State: store.StateFailed, Stripe: store.Stripe{PaymentIntentID: "pi_p", PIStatus: store.PIRefunded,
		CapturedCents: 1000, RefundedCents: 400, CapturedAt: &now, RefundedAt: &now, Presentment: jpy}}
	got := map[string]*store.Presentment{}
	for _, r := range historyRows(nil, nil, []*store.Conversion{full, part}) {
		got[r.RowID] = r.Presentment
	}
	if p := got["refund_f"]; p == nil || *p != (store.Presentment{AmountMinor: -1648, Currency: "jpy"}) || got["refund_p"] != nil ||
		got[store.ChargeID(store.ChargeRun, "p")] != jpy {
		t.Fatalf("rows %+v", got)
	}
}

// applyRefundStatus keeps the created refund's presentment and a later
// event without one doesn't clear it.
func TestRefundRowPresentment(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	pi := "pi_" + store.NewID()
	row, err := s.Store.ReserveRefund(ctx, store.ReserveSpec{ChargeID: "ch_" + pi, UID: "u1", PI: pi, CaseID: "case1",
		Items: map[string]int64{"c1": 400}, StripeRemainder: -1, Source: "gateway", Unassigned: true,
		Fallback: &store.Charge{UID: "u1", Kind: store.ChargeRun, PaymentIntentID: pi, AmountCents: 1000, Currency: "usd"}})
	if err != nil {
		t.Fatal(err)
	}
	re := &stripex.RefundResult{ID: "re_1", Status: "pending", Currency: "usd"}
	json.Unmarshal([]byte(`{"presentment_details":{"presentment_amount":659,"presentment_currency":"jpy"}}`), re)
	s.applyRefundStatus(ctx, row.ID, re)
	s.applyRefundStatus(ctx, row.ID, &stripex.RefundResult{ID: "re_1", Status: "pending"}) // an older payload
	rows, err := s.Store.ListRefundRows(ctx, pi)
	if err != nil || len(rows) != 1 || rows[0].Presentment == nil || *rows[0].Presentment != (store.Presentment{AmountMinor: 659, Currency: "jpy"}) {
		t.Fatalf("%+v %v", rows, err)
	}
}
