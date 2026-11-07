package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/notify"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/revenuecat"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// offFake is a Stripe that charges saved methods off-session the way test
// mode does (audit 2026-11-07): a decline or a bank check is a 402 whose
// error carries the PaymentIntent (requires_payment_method), the SDK hands
// back an empty PaymentIntent with it, and a replayed Idempotency-Key gets
// the first answer again.
type offFake struct {
	mu       sync.Mutex
	t        *testing.T
	outcome  map[string]string   // pm → "" (pays) | "decline:<code>" | "auth" | "stop:<code>"
	methods  map[string][]string // customer → saved pms, oldest first
	pis      map[string]map[string]any
	idem     map[string][2]any // key → {status, body}
	creates  []map[string]string
	confirms []map[string]string // {pi, pm, key}
	cancels  []string
	sessions []map[string]string
	n        int
	// lostAnswers: the next n creates charge, then answer 500 (a timeout
	// after Stripe took the money).
	lostAnswers int
	subs        map[string]map[string]any // subscription id → {customer, status, metadata, default_payment_method}
	subSets     []map[string]string       // POST /v1/subscriptions/{id} forms
	invoices    map[string]map[string]any // invoice id → {status, amount_due, hosted_invoice_url}
}

func newOffFake(t *testing.T) *offFake {
	return &offFake{t: t, outcome: map[string]string{}, methods: map[string][]string{}, pis: map[string]map[string]any{},
		idem: map[string][2]any{}, subs: map[string]map[string]any{}, invoices: map[string]map[string]any{}}
}

func (f *offFake) charge(pi map[string]any, pm string) (int, map[string]any) {
	pi["payment_method"] = pm
	switch o := f.outcome[pm]; {
	case o == "":
		pi["status"], pi["amount_received"] = "succeeded", pi["amount"]
		return 200, f.piJSON(pi)
	case o == "config": // Stripe refuses the request: no PaymentIntent
		delete(f.pis, pi["id"].(string))
		return 400, map[string]any{"error": map[string]any{"type": "invalid_request_error",
			"message": "The PaymentMethod provided (link) is not allowed for this PaymentIntent."}}
	case o == "auth":
		pi["status"] = "requires_payment_method"
		return 402, map[string]any{"error": map[string]any{"type": "card_error", "code": "authentication_required",
			"decline_code": "authentication_required", "message": "This payment requires authentication.", "payment_intent": f.piJSON(pi)}}
	default:
		code := o[strings.Index(o, ":")+1:]
		pi["status"] = "requires_payment_method"
		return 402, map[string]any{"error": map[string]any{"type": "card_error", "code": "card_declined",
			"decline_code": code, "message": "Your card was declined.", "payment_intent": f.piJSON(pi)}}
	}
}

// succeeded counts the PaymentIntents that took money.
func (f *offFake) succeeded() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, pi := range f.pis {
		if pi["status"] == "succeeded" {
			n++
		}
	}
	return n
}

func (f *offFake) piJSON(pi map[string]any) map[string]any {
	out := map[string]any{"object": "payment_intent"}
	for k, v := range pi {
		out[k] = v
	}
	if pm, _ := pi["payment_method"].(string); pm != "" {
		out["payment_method"] = map[string]any{"id": pm, "object": "payment_method"}
	}
	return out
}

func (f *offFake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = r.ParseForm()
	p := r.URL.Path
	key := r.Header.Get("Idempotency-Key")
	reply := func(code int, v any) {
		if key != "" && r.Method == http.MethodPost {
			f.idem[key] = [2]any{code, v}
		}
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(v)
	}
	if key != "" && r.Method == http.MethodPost {
		if prev, ok := f.idem[key]; ok {
			w.WriteHeader(prev[0].(int))
			_ = json.NewEncoder(w).Encode(prev[1])
			return
		}
	}
	form := map[string]string{"key": key}
	for k := range r.Form {
		form[k] = r.Form.Get(k)
	}
	switch {
	case p == "/v1/payment_intents" && r.Method == http.MethodPost:
		f.n++
		id := fmt.Sprintf("pi_off_%d", f.n)
		md := map[string]any{}
		for k, v := range form {
			if name, ok := strings.CutPrefix(k, "metadata["); ok {
				md[strings.TrimSuffix(name, "]")] = v
			}
		}
		var amount int64
		fmt.Sscan(form["amount"], &amount)
		pi := map[string]any{"id": id, "amount": amount, "currency": form["currency"], "customer": form["customer"], "metadata": md,
			"client_secret": id + "_secret_x", "created": time.Now().Unix()}
		f.pis[id] = pi
		f.creates = append(f.creates, form)
		code, body := f.charge(pi, form["payment_method"])
		if f.lostAnswers > 0 {
			f.lostAnswers--
			delete(f.idem, key) // Stripe would replay; the gateway never asks
			w.WriteHeader(500)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"type": "api_error", "message": "timeout"}})
			return
		}
		reply(code, body)
	case p == "/v1/payment_intents" && r.Method == http.MethodGet:
		data := []any{}
		for i := f.n; i >= 1; i-- {
			if pi := f.pis[fmt.Sprintf("pi_off_%d", i)]; pi != nil && pi["customer"] == r.URL.Query().Get("customer") {
				data = append(data, f.piJSON(pi))
			}
		}
		reply(200, map[string]any{"object": "list", "data": data, "has_more": false, "url": p})
	case strings.HasPrefix(p, "/v1/payment_intents/") && strings.HasSuffix(p, "/confirm"):
		id := strings.TrimSuffix(strings.TrimPrefix(p, "/v1/payment_intents/"), "/confirm")
		pi := f.pis[id]
		f.confirms = append(f.confirms, map[string]string{"pi": id, "pm": form["payment_method"], "key": key})
		if pi == nil || pi["status"] == "succeeded" || pi["status"] == "canceled" {
			reply(400, map[string]any{"error": map[string]any{"type": "invalid_request_error", "code": "payment_intent_unexpected_state"}})
			return
		}
		reply(f.charge(pi, form["payment_method"]))
	case strings.HasPrefix(p, "/v1/payment_intents/") && strings.HasSuffix(p, "/cancel"):
		id := strings.TrimSuffix(strings.TrimPrefix(p, "/v1/payment_intents/"), "/cancel")
		f.cancels = append(f.cancels, id)
		pi := f.pis[id]
		if pi["status"] == "succeeded" {
			reply(400, map[string]any{"error": map[string]any{"type": "invalid_request_error", "code": "payment_intent_unexpected_state"}})
			return
		}
		pi["status"] = "canceled"
		reply(200, f.piJSON(pi))
	case strings.HasPrefix(p, "/v1/payment_intents/"):
		id := strings.TrimPrefix(p, "/v1/payment_intents/")
		if pi := f.pis[id]; pi != nil {
			reply(200, f.piJSON(pi))
			return
		}
		reply(404, map[string]any{"error": map[string]any{"type": "invalid_request_error", "code": "resource_missing"}})
	case strings.HasPrefix(p, "/v1/customers/") && strings.HasSuffix(p, "/payment_methods"):
		cus := strings.TrimSuffix(strings.TrimPrefix(p, "/v1/customers/"), "/payment_methods")
		data := []any{}
		for i, pm := range f.methods[cus] {
			data = append(data, map[string]any{"id": pm, "object": "payment_method", "type": "card", "created": 1000 + i,
				"card": map[string]any{"brand": "visa", "last4": fmt.Sprintf("%04d", 4242+i), "fingerprint": "fp_" + pm}})
		}
		reply(200, map[string]any{"object": "list", "data": data, "has_more": false, "url": p})
	case strings.HasPrefix(p, "/v1/customers/"):
		cus := strings.TrimPrefix(p, "/v1/customers/")
		def := any(nil)
		if ms := f.methods[cus]; len(ms) > 0 {
			def = map[string]any{"id": ms[0], "object": "payment_method", "type": "card", "card": map[string]any{"brand": "visa", "last4": "4242"}}
		}
		reply(200, map[string]any{"id": cus, "object": "customer", "invoice_settings": map[string]any{"default_payment_method": def}})
	case p == "/v1/subscriptions" && r.Method == http.MethodGet:
		data := []any{}
		for _, sub := range f.subs {
			if sub["customer"] == r.URL.Query().Get("customer") {
				data = append(data, sub)
			}
		}
		reply(200, map[string]any{"object": "list", "data": data, "has_more": false})
	case strings.HasPrefix(p, "/v1/subscriptions/") && r.Method == http.MethodPost:
		id := strings.TrimPrefix(p, "/v1/subscriptions/")
		f.subSets = append(f.subSets, form)
		if sub := f.subs[id]; sub != nil && form["default_payment_method"] != "" {
			sub["default_payment_method"] = form["default_payment_method"]
		}
		reply(200, f.subs[id])
	case strings.HasPrefix(p, "/v1/invoices/") && r.Method == http.MethodGet:
		if inv := f.invoices[strings.TrimPrefix(p, "/v1/invoices/")]; inv != nil {
			reply(200, inv)
			return
		}
		reply(404, map[string]any{"error": map[string]any{"type": "invalid_request_error", "code": "resource_missing"}})
	case p == "/v1/checkout/sessions" && r.Method == http.MethodPost:
		f.n++
		f.sessions = append(f.sessions, form)
		id := fmt.Sprintf("cs_off_%d", f.n)
		reply(200, map[string]any{"id": id, "object": "checkout.session", "status": "open", "payment_status": "unpaid",
			"client_secret": id + "_secret", "url": "https://checkout.example/" + id, "expires_at": time.Now().Add(time.Hour).Unix()})
	default:
		f.t.Logf("offFake: unhandled %s %s", r.Method, p)
		reply(404, map[string]any{"error": map[string]any{"type": "invalid_request_error", "message": "unhandled " + p}})
	}
}

// offService is a Service on the Firestore emulator and offFake.
func offService(t *testing.T) (*Service, *offFake) {
	t.Helper()
	if os.Getenv("FIRESTORE_EMULATOR_HOST") == "" {
		t.Skip("needs FIRESTORE_EMULATOR_HOST")
	}
	st, err := store.New(context.Background(), "demo-off", "off"+store.NewID())
	if err != nil {
		t.Fatal(err)
	}
	fake := newOffFake(t)
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	sc := stripex.New("sk_test_fake", "whsec", "pk_test_x", "test")
	stripex.UseTestServer(srv.URL)
	modal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) }))
	t.Cleanup(modal.Close)
	return &Service{Cfg: &config.Config{Env: "test", SiteURL: "https://site.example", StripePMCWeb: "pmc_test"}, Store: st, Stripe: sc,
		Pricing: pricing.NewStatic(pricing.DefaultsFor("test")), RevenueCat: revenuecat.New(""),
		Modal: modalapi.New(modal.URL, "", ""), Slack: notify.NewSlack("", "test")}, fake
}

// offCustomer is a made-up account with saved methods (the first the
// default) and their outcomes.
func offCustomer(t *testing.T, s *Service, f *offFake, outcomes ...[2]string) (uid, cus string) {
	t.Helper()
	uid, cus = "u"+store.NewID(), "cus_"+store.NewID()
	rec := &store.Customer{StripeCustomerID: cus, Email: uid + "@example.com"}
	for _, o := range outcomes {
		f.methods[cus] = append(f.methods[cus], o[0])
		f.outcome[o[0]] = o[1]
	}
	if len(outcomes) > 0 {
		rec.DefaultPaymentMethod = outcomes[0][0]
	}
	if err := s.Store.PutCustomer(context.Background(), uid, rec); err != nil {
		t.Fatal(err)
	}
	return uid, cus
}

// owedConversion is a finished run whose charge failed: what a settle
// collects.
func owedConversion(t *testing.T, s *Service, uid string, cents int64) string {
	t.Helper()
	c := &store.Conversion{ID: store.NewID(), UID: uid, State: store.StateSucceeded, Kind: "video",
		Quote: store.Quote{AmountCents: cents, Currency: "usd"}}
	c.Stripe.Mode = store.BillingModeAuto
	c.Stripe.PIStatus = store.PIChargeFailed
	if err := s.Store.CreateConversion(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	return c.ID
}
