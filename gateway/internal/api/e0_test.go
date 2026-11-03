package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/notify"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// fakeStripe answers the PaymentIntent, Checkout Session and Refund calls
// the payment layer makes, from in-memory objects.
type fakeStripe struct {
	mu       sync.Mutex
	pis      map[string]map[string]any // id → {status, amount_received, payment_method}
	sessions map[string]map[string]any // id → {status, payment_status, payment_intent, expires_at}
	refunds  []string                  // payment_intent ids refunded
	pmPrints map[string]string         // payment method id → card fingerprint
	subs     map[string]map[string]any // subscription id → object
	invPays  map[string]string         // payment intent → invoice id
	invs     map[string]map[string]any // invoice id → object
	expired  []string
	created  int
}

func newFakeStripe() *fakeStripe {
	return &fakeStripe{pis: map[string]map[string]any{}, sessions: map[string]map[string]any{}, pmPrints: map[string]string{},
		subs: map[string]map[string]any{}, invPays: map[string]string{}, invs: map[string]map[string]any{}}
}

func (f *fakeStripe) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = r.ParseForm()
	p := r.URL.Path
	write := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	switch {
	case strings.HasPrefix(p, "/v1/checkout/sessions/") && strings.HasSuffix(p, "/expire"):
		id := strings.TrimSuffix(strings.TrimPrefix(p, "/v1/checkout/sessions/"), "/expire")
		s := f.sessions[id]
		if s["status"] != "open" {
			w.WriteHeader(400)
			write(map[string]any{"error": map[string]any{"type": "invalid_request_error", "message": "not open"}})
			return
		}
		s["status"] = "expired"
		f.expired = append(f.expired, id)
		write(f.session(id))
	case strings.HasPrefix(p, "/v1/checkout/sessions/"):
		write(f.session(strings.TrimPrefix(p, "/v1/checkout/sessions/")))
	case strings.HasPrefix(p, "/v1/subscriptions/"):
		id := strings.TrimPrefix(p, "/v1/subscriptions/")
		if r.Method == http.MethodDelete {
			f.subs[id]["status"] = "canceled"
		}
		write(f.subs[id])
	case p == "/v1/invoice_payments":
		data := []any{}
		if inv := f.invPays[r.URL.Query().Get("payment[payment_intent]")]; inv != "" {
			data = append(data, map[string]any{"invoice": inv})
		}
		if inv := r.URL.Query().Get("invoice"); inv != "" {
			for pi, id := range f.invPays {
				if id == inv {
					data = append(data, map[string]any{"invoice": inv, "status": "paid", "amount_paid": f.invs[inv]["amount_paid"],
						"payment": map[string]any{"type": "payment_intent", "payment_intent": pi}})
				}
			}
		}
		write(map[string]any{"data": data})
	case strings.HasPrefix(p, "/v1/invoices/") && f.invs[strings.TrimPrefix(p, "/v1/invoices/")] != nil:
		write(f.invs[strings.TrimPrefix(p, "/v1/invoices/")])
	case p == "/v1/payment_intents/search":
		var data []map[string]any
		for id, pi := range f.pis {
			if _, ok := pi["metadata"]; ok {
				data = append(data, f.pi(id))
			}
		}
		write(map[string]any{"data": data, "has_more": false})
	case p == "/v1/events" || (p == "/v1/invoices" && r.Method == http.MethodGet) || (p == "/v1/refunds" && r.Method == http.MethodGet):
		write(map[string]any{"data": []any{}, "has_more": false})
	case strings.HasPrefix(p, "/v1/payment_methods/"):
		write(map[string]any{"id": strings.TrimPrefix(p, "/v1/payment_methods/"), "card": map[string]any{"fingerprint": f.pmPrints[strings.TrimPrefix(p, "/v1/payment_methods/")]}})
	case strings.HasPrefix(p, "/v1/payment_intents/") && strings.HasSuffix(p, "/cancel"):
		id := strings.TrimSuffix(strings.TrimPrefix(p, "/v1/payment_intents/"), "/cancel")
		pi := f.pis[id]
		if pi["status"] == "succeeded" {
			w.WriteHeader(400)
			write(map[string]any{"error": map[string]any{"type": "invalid_request_error", "code": "payment_intent_unexpected_state"}})
			return
		}
		pi["status"] = "canceled"
		write(f.pi(id))
	case strings.HasPrefix(p, "/v1/payment_intents/"):
		write(f.pi(strings.TrimPrefix(p, "/v1/payment_intents/")))
	case p == "/v1/refunds":
		f.refunds = append(f.refunds, r.Form.Get("payment_intent"))
		amt, _ := strconv.ParseInt(r.Form.Get("amount"), 10, 64)
		write(map[string]any{"id": fmt.Sprintf("re_%s_%d", r.Form.Get("payment_intent"), len(f.refunds)), "object": "refund", "amount": amt,
			"status": "succeeded", "payment_intent": r.Form.Get("payment_intent")})
	default:
		w.WriteHeader(404)
		write(map[string]any{"error": map[string]any{"type": "invalid_request_error", "message": "unhandled " + p}})
	}
}

func (f *fakeStripe) pi(id string) map[string]any {
	pi := f.pis[id]
	out := map[string]any{"id": id, "object": "payment_intent", "status": pi["status"], "amount_received": pi["amount_received"], "amount": pi["amount_received"]}
	if pm, ok := pi["payment_method"]; ok {
		out["payment_method"] = map[string]any{"id": pm, "object": "payment_method"}
	}
	if md, ok := pi["metadata"]; ok {
		out["metadata"] = md
	}
	charge := map[string]any{"id": "ch_" + id, "object": "charge", "amount_refunded": 0}
	if fp, ok := pi["fingerprint"]; ok {
		charge["payment_method_details"] = map[string]any{"type": "card", "card": map[string]any{"fingerprint": fp, "brand": "visa", "country": "US"}}
	}
	if n, ok := pi["refunded"]; ok {
		charge["amount_refunded"] = n
	}
	out["latest_charge"] = charge
	out["created"] = time.Now().Unix()
	return out
}

func (f *fakeStripe) session(id string) map[string]any {
	s := f.sessions[id]
	return map[string]any{"id": id, "object": "checkout.session", "status": s["status"], "payment_status": s["payment_status"],
		"payment_intent": s["payment_intent"], "expires_at": time.Now().Add(30 * time.Minute).Unix()}
}

func (f *fakeStripe) addSession(id, status, piStatus string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ps, pi := "unpaid", ""
	if piStatus != "" {
		pi = "pi_" + id
		f.pis[pi] = map[string]any{"status": piStatus, "amount_received": 3000, "payment_method": "pm_1"}
		if piStatus == "succeeded" {
			ps = "paid"
		}
	}
	f.sessions[id] = map[string]any{"status": status, "payment_status": ps, "payment_intent": pi}
}

// e0Service is a Service on the Firestore emulator and the fake Stripe;
// tests skip without FIRESTORE_EMULATOR_HOST.
func e0Service(t *testing.T) (*Service, *fakeStripe) {
	t.Helper()
	if os.Getenv("FIRESTORE_EMULATOR_HOST") == "" {
		t.Skip("needs FIRESTORE_EMULATOR_HOST")
	}
	ctx := context.Background()
	env := "e0" + store.NewID()
	st, err := store.New(ctx, "demo-e0", env)
	if err != nil {
		t.Fatal(err)
	}
	fake := newFakeStripe()
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	sc := stripex.New("sk_test_fake", "whsec", "pk", "test")
	stripex.UseTestServer(srv.URL)
	modal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) }))
	t.Cleanup(modal.Close)
	return &Service{Cfg: &config.Config{Env: "test"}, Store: st, Stripe: sc, Pricing: pricing.NewStatic(nil),
		Modal: modalapi.New(modal.URL, "", ""), Slack: notify.NewSlack("", "test")}, fake
}

func createdRun(t *testing.T, s *Service, current *store.Payment) *store.Conversion {
	t.Helper()
	exp := time.Now().Add(30 * time.Minute)
	c := &store.Conversion{ID: store.NewID(), UID: "u1", State: store.StateCreated, Kind: "video",
		PaymentFlow: store.FlowPayNow, CurrentPayment: current, ExpiresAt: &exp,
		Quote: store.Quote{AmountCents: 3000, Currency: "usd"}}
	if current != nil {
		c.Payments = []store.Payment{*current}
	}
	if err := s.Store.CreateConversion(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	return c
}

// E0-1: two replacements race; exactly one becomes current, the loser's
// new object is closed, and the old one was closed before either.
func TestE0OneLivePaymentRace(t *testing.T) {
	s, fake := e0Service(t)
	fake.addSession("cs_old", "open", "")
	conv := createdRun(t, s, &store.Payment{Kind: store.PaymentCheckoutSession, ID: "cs_old"})
	var wg sync.WaitGroup
	results := make([]*store.Conversion, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], _ = s.replaceRunPayment(context.Background(), conv, func(attempt int) (*store.Payment, error) {
				id := fmt.Sprintf("cs_new%d", i)
				fake.addSession(id, "open", "")
				exp := time.Now().Add(30 * time.Minute)
				return &store.Payment{Kind: store.PaymentCheckoutSession, ID: id, Attempt: attempt, ExpiresAt: &exp}, nil
			})
		}(i)
	}
	wg.Wait()
	final, err := s.Store.GetConversion(context.Background(), conv.ID)
	if err != nil {
		t.Fatal(err)
	}
	winner := final.CurrentPayment.ID
	if winner != "cs_new0" && winner != "cs_new1" {
		t.Fatalf("current %q", winner)
	}
	loser := map[string]string{"cs_new0": "cs_new1", "cs_new1": "cs_new0"}[winner]
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.sessions["cs_old"]["status"] != "expired" || fake.sessions[loser]["status"] != "expired" || fake.sessions[winner]["status"] != "open" {
		t.Errorf("old %v loser %v winner %v", fake.sessions["cs_old"]["status"], fake.sessions[loser]["status"], fake.sessions[winner]["status"])
	}
	if !final.ExpiresAt.After(time.Now().Add(30 * time.Minute)) {
		t.Errorf("run clock didn't follow the new object: %v", final.ExpiresAt)
	}
}

// E0-1: replacing an object that was already paid creates nothing; the run
// is paid with it.
func TestE0ReplacePaidCreatesNothing(t *testing.T) {
	s, fake := e0Service(t)
	fake.addSession("cs_paid", "complete", "succeeded")
	conv := createdRun(t, s, &store.Payment{Kind: store.PaymentCheckoutSession, ID: "cs_paid"})
	made := false
	got, err := s.replaceRunPayment(context.Background(), conv, func(int) (*store.Payment, error) {
		made = true
		return &store.Payment{Kind: store.PaymentCheckoutSession, ID: "cs_x"}, nil
	})
	if err != errAlreadyPaid || made || got.State != store.StatePaid || got.Stripe.PaymentIntentID != "pi_cs_paid" {
		t.Fatalf("err %v made %v state %s pi %s", err, made, got.State, got.Stripe.PaymentIntentID)
	}
}

// E0-2: money on a non-current object is adopted while the run is unpaid,
// and refunded once it's paid.
func TestE0LateMoneyAdoptOrRefund(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	fake.addSession("cs_cur", "open", "")
	fake.addSession("cs_late", "complete", "succeeded")
	conv := createdRun(t, s, &store.Payment{Kind: store.PaymentCheckoutSession, ID: "cs_cur"})
	out := stripex.Outcome{Paid: true, PaymentIntentID: "pi_cs_late", AmountReceived: 3000}
	got, err := s.applyRunPayment(ctx, conv.ID, store.Payment{Kind: store.PaymentCheckoutSession, ID: "cs_late"}, out)
	if err != nil || got.State != store.StatePaid || got.CurrentPayment.ID != "cs_late" {
		t.Fatalf("adopt: %v %+v", err, got)
	}
	fake.mu.Lock()
	curStatus := fake.sessions["cs_cur"]["status"]
	fake.mu.Unlock()
	if curStatus != "expired" {
		t.Errorf("previous current not closed: %v", curStatus)
	}
	// a second payment after it's paid → refunded
	fake.addSession("cs_dup", "complete", "succeeded")
	if _, err := s.applyRunPayment(ctx, conv.ID, store.Payment{Kind: store.PaymentCheckoutSession, ID: "cs_dup"},
		stripex.Outcome{Paid: true, PaymentIntentID: "pi_cs_dup", AmountReceived: 3000}); err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.refunds) != 1 || fake.refunds[0] != "pi_cs_dup" {
		t.Errorf("refunds %v", fake.refunds)
	}
}

// E0-3: an expired clock resolves the object first: unpaid → the run
// expires not charged; paid → the run is paid.
func TestE0ClockFollowsPayment(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	fake.addSession("cs_open", "open", "")
	fake.addSession("cs_done", "complete", "succeeded")
	past := time.Now().Add(-time.Minute)
	a := createdRun(t, s, &store.Payment{Kind: store.PaymentCheckoutSession, ID: "cs_open"})
	b := createdRun(t, s, &store.Payment{Kind: store.PaymentCheckoutSession, ID: "cs_done"})
	for _, id := range []string{a.ID, b.ID} {
		if _, err := s.Store.Transition(ctx, id, []string{store.StateCreated}, func(c *store.Conversion) error {
			c.ExpiresAt = &past
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	s.resolveRunClocks(ctx)
	ga, _ := s.Store.GetConversion(ctx, a.ID)
	gb, _ := s.Store.GetConversion(ctx, b.ID)
	if ga.State != store.StateExpired || gb.State != store.StatePaid {
		t.Errorf("a %s b %s", ga.State, gb.State)
	}
}

// E0-4: one lease holder per group.
func TestE0OneLeaseHolder(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	c := &store.Conversion{ID: store.NewID(), UID: "u-lease", State: store.StateSucceeded,
		Quote:  store.Quote{AmountCents: 100, Currency: "usd"},
		Stripe: store.Stripe{Mode: store.BillingModeAuto, PIStatus: store.PIChargePending}}
	if err := s.Store.CreateConversion(ctx, c); err != nil {
		t.Fatal(err)
	}
	if err := s.Store.PutCustomer(ctx, "u-lease", &store.Customer{StripeCustomerID: "cus_x"}); err != nil {
		t.Fatal(err)
	}
	b, err := s.Store.BatchConversion(ctx, c.ID, store.BatchItem{ConversionID: c.ID, AmountCents: 100}, time.Hour, 5000)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.TransitionBatch(ctx, b.ID, []string{store.BatchOpen}, func(bb *store.Batch) error {
		bb.State = store.BatchCharging
		return nil
	}, nil, nil); err != nil {
		t.Fatal(err)
	}
	_, ok1 := s.acquireBatchLease(ctx, b)
	saved := leaseOwner
	leaseOwner = "gw-other"
	_, ok2 := s.acquireBatchLease(ctx, b)
	leaseOwner = saved
	if !ok1 || ok2 {
		t.Errorf("lease: first %v second %v", ok1, ok2)
	}
}

// P3 at the store: a racing Create on one id lets exactly one through.
func TestP3CreateRace(t *testing.T) {
	s, _ := e0Service(t)
	id := store.IdemConversionID("test", "u1", "k")
	var wg sync.WaitGroup
	var mu sync.Mutex
	ok, exists := 0, 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := s.Store.CreateConversion(context.Background(), &store.Conversion{ID: id, UID: "u1", State: store.StatePaid})
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				ok++
			case err == store.ErrAlreadyExists:
				exists++
			}
		}()
	}
	wg.Wait()
	if ok != 1 || exists != 7 {
		t.Errorf("ok %d exists %d", ok, exists)
	}
}
