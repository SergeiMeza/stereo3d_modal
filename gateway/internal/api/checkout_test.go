package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

func TestPayNowBilling(t *testing.T) {
	exp := time.Date(2026, 11, 3, 13, 0, 0, 0, time.UTC)
	c := &store.Conversion{State: store.StateCreated, PaymentFlow: store.FlowPayNow, PayReason: "declined",
		DeclinedMethodLabel: "Visa •••• 4242",
		CurrentPayment:      &store.Payment{Kind: store.PaymentCheckoutSession, ID: "cs_1", UI: "elements", ClientSecret: "cs_secret", ExpiresAt: &exp}}
	b := payNowBilling(c, "pk_test_x")
	ch, _ := b["checkout"].(map[string]any)
	if b["status"] != "requires_payment" || b["reason"] != "declined" || b["declined_method_label"] != "Visa •••• 4242" ||
		ch["client_secret"] != "cs_secret" || ch["expires_at"] != "2026-11-03T13:00:00Z" || b["publishable_key"] != "pk_test_x" {
		t.Errorf("billing %v", b)
	}
	// no open session: nothing to mount, no key
	noSession := *c
	noSession.CurrentPayment = nil
	if b := payNowBilling(&noSession, "pk_test_x"); b["publishable_key"] != nil || b["checkout"] != nil {
		t.Errorf("no session %v", b)
	}
	c.Stripe.PIStatus = store.PIProcessing
	if payNowBilling(c, "pk_test_x")["status"] != "waiting_for_payment" {
		t.Error("processing")
	}
	if payNowBilling(&store.Conversion{State: store.StatePaid, PaymentFlow: store.FlowPayNow}, "pk_test_x") != nil {
		t.Error("paid run has no sheet block")
	}
	if err := runPayable(&store.Conversion{State: store.StateSucceeded}); err == nil {
		t.Error("succeeded run payable")
	}
}

func TestMethodLabelsAndOrder(t *testing.T) {
	for _, tc := range []struct {
		m    stripex.CardInfo
		want string
	}{
		{stripex.CardInfo{Type: "card", Brand: "visa", Last4: "4242"}, "Visa •••• 4242"},
		{stripex.CardInfo{Type: "card", Brand: "visa", Last4: "4242", Wallet: "apple_pay"}, "Apple Pay · Visa •••• 4242"},
		{stripex.CardInfo{Type: "paypal", Email: "jane@gmail.com"}, "PayPal · j•••@gmail.com"},
		{stripex.CardInfo{Type: "link"}, "Link"},
	} {
		if got := methodLabel(&tc.m); got != tc.want {
			t.Errorf("%+v: %q", tc.m, got)
		}
	}
	ms := []*stripex.CardInfo{{PaymentMethodID: "a", Created: 1}, {PaymentMethodID: "b", Created: 2}, {PaymentMethodID: "c", Created: 3}, {PaymentMethodID: "d", Created: 4}}
	got := orderMethods(ms, "c", []string{"d", "a"})
	ids := ""
	for _, m := range got {
		ids += m.PaymentMethodID
	}
	if ids != "cdab" {
		t.Errorf("order %s, want default first, then backup order, then by age", ids)
	}
}

// A run read back (GET /v1/conversions/{id}, "Finish payment") carries
// the publishable key in billing, so the sheet mounts.
func TestReadBackRunHasPublishableKey(t *testing.T) {
	s, _ := e0Service(t)
	if s.Stripe == nil {
		t.Skip("no Stripe client in this service")
	}
	s.Stripe.PublishableKey = "pk_test_readback"
	c := &store.Conversion{ID: store.NewID(), State: store.StateCreated, PaymentFlow: store.FlowPayNow,
		CurrentPayment: &store.Payment{Kind: store.PaymentCheckoutSession, ID: "cs_1", UI: "elements", ClientSecret: "cs_secret"}}
	b, _ := s.conversionResponse(c, nil)["billing"].(map[string]any)
	if b == nil || b["publishable_key"] != "pk_test_readback" || b["checkout"] == nil {
		t.Fatalf("billing %v", b)
	}
}

// Pay-now hands out the open session only with 10 minutes or more left;
// one closer to its end is replaced by a fresh one for the same run and
// amount (k1016a30746cb172: paid in the last minute, expired under the
// customer). A replayed pay-first create does the same.
func TestPayNowRefreshesLapsingSession(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	s.Cfg.StripePMCWeb = "pmc_test"
	payNow := func(c *store.Conversion) (int, map[string]any) {
		rec := httptest.NewRecorder()
		s.HandleRunPayNow(rec, httptest.NewRequest("POST", "/", strings.NewReader(`{"ui":"elements"}`)), &AuthedUser{UID: c.UID}, c.ID)
		var out map[string]any
		json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	sheet := func(id string, left time.Duration) *store.Payment {
		exp := time.Now().Add(left)
		fake.addSession(id, "open", "")
		fake.mu.Lock()
		fake.sessions[id]["expires_at"] = exp.Unix()
		fake.mu.Unlock()
		return &store.Payment{Kind: store.PaymentCheckoutSession, ID: id, UI: "elements", ClientSecret: id + "_secret", ExpiresAt: &exp}
	}
	// 25 minutes left: the same session
	roomy := createdRun(t, s, sheet("cs_roomy", 25*time.Minute))
	before := len(fake.sessionForms)
	if code, out := payNow(roomy); code != 200 || out["checkout"].(map[string]any)["client_secret"] != "cs_roomy_secret" || len(fake.sessionForms) != before {
		t.Fatalf("roomy %d %v", code, out)
	}
	// 9 minutes left: a fresh session, the old one closed, same amount
	short := createdRun(t, s, sheet("cs_short", 9*time.Minute))
	code, out := payNow(short)
	got, _ := s.Store.GetConversion(ctx, short.ID)
	if code != 200 || len(fake.sessionForms) != before+1 || got.CurrentPayment.ID == "cs_short" || got.State != store.StateCreated {
		t.Fatalf("short %d %v %+v", code, out, got.CurrentPayment)
	}
	fake.mu.Lock()
	closed, amount := fake.sessions["cs_short"]["status"], fake.sessionForms[before]["line_items[0][price_data][unit_amount]"]
	fake.mu.Unlock()
	if closed != "expired" || amount != "3000" || got.CurrentPayment.ExpiresAt.Sub(time.Now()) < 20*time.Minute || !got.ExpiresAt.After(*got.CurrentPayment.ExpiresAt) {
		t.Fatalf("old %v amount %q new %+v run expiry %v", closed, amount, got.CurrentPayment, got.ExpiresAt)
	}
	// a replayed pay-first create: fresh when lapsing, as is otherwise
	lapsing := createdRun(t, s, sheet("cs_lapsing", 5*time.Minute))
	rec := httptest.NewRecorder()
	if !s.replayPayFirst(ctx, rec, &AuthedUser{UID: lapsing.UID}, lapsing, payContext{Device: "computer"}) {
		t.Fatal("not handled")
	}
	if got, _ := s.Store.GetConversion(ctx, lapsing.ID); got.CurrentPayment.ID == "cs_lapsing" || !strings.Contains(rec.Body.String(), `"publishable_key"`) {
		t.Fatalf("replay %+v %s", got.CurrentPayment, rec.Body.String())
	}
	fresh := createdRun(t, s, sheet("cs_fresh", 28*time.Minute))
	n := len(fake.sessionForms)
	s.replayPayFirst(ctx, httptest.NewRecorder(), &AuthedUser{UID: fresh.UID}, fresh, payContext{})
	if len(fake.sessionForms) != n {
		t.Fatal("a roomy session was replaced on replay")
	}
	if s.replayPayFirst(ctx, httptest.NewRecorder(), &AuthedUser{UID: "u1"}, &store.Conversion{State: store.StatePaid, PaymentFlow: store.FlowPayNow}, payContext{}) {
		t.Fatal("a paid run is not a pay-first replay")
	}
}
