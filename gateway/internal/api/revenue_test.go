package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The revenue report (owner 2026-11-07): totals from our own records per
// UTC day — payments on their paid_at, refunds on their refunded_at (the
// next day here), a lost dispute on its close; app charges apart; test
// accounts left out on prod and flagged on TEST; balance and credit spent
// by method; presentment by currency; new paying accounts.
func TestRevenueDaily(t *testing.T) {
	for _, env := range []string{"test", "prod"} {
		s, _ := e0Service(t)
		s.Cfg.Env = env
		ctx := context.Background()
		d1 := time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC)
		d2 := d1.AddDate(0, 0, 1)
		real, tester := "u"+store.NewID(), "u"+store.NewID()
		s.Store.PutCustomer(ctx, real, &store.Customer{Email: "buyer@realmail.jp"})
		s.Store.PutCustomer(ctx, tester, &store.Customer{Email: "probe+location_JP@example.com"})
		conv := func(step, method string, web bool) string {
			c := &store.Conversion{ID: store.NewID(), UID: real, State: store.StateSucceeded, Step: step, Method: method, Kind: "video"}
			c.Params.Web = web
			if step != "" {
				c.ProjectID = "p1"
			}
			s.Store.CreateConversion(ctx, c)
			return c.ID
		}
		life, prev, app := conv(store.StepProduction, store.MethodLifelike, true), conv(store.StepLifelikePreview, store.MethodLifelike, true), conv("", "", false)
		charge := func(uid, kind string, cents int64, at time.Time, lines []string, pres *store.Presentment) *store.Charge {
			ch := &store.Charge{UID: uid, Kind: kind, SourceID: store.NewID(), PaymentIntentID: "pi_" + store.NewID(), AmountCents: cents,
				Currency: "usd", PaidAt: at, Presentment: pres}
			for _, id := range lines {
				ch.Lines = append(ch.Lines, store.ChargeLine{ConversionID: id, AmountCents: cents / int64(len(lines))})
			}
			if err := s.Store.RecordCharge(ctx, ch); err != nil {
				t.Fatal(err)
			}
			return ch
		}
		jp := &store.Presentment{AmountMinor: 1648, Currency: "jpy"}
		lifeCh := charge(real, store.ChargeRun, 1000, d1.Add(9*time.Hour), []string{life}, jp)
		charge(real, store.ChargeRun, 100, d1.Add(10*time.Hour), []string{prev}, nil)
		charge(real, store.ChargeTopup, 2500, d1.Add(23*time.Hour+59*time.Minute), nil, nil)
		charge(real, store.ChargeRun, 700, d1.Add(12*time.Hour), []string{app}, nil) // the app's
		charge(tester, store.ChargeTopup, 5000, d1.Add(11*time.Hour), nil, nil)      // a probe account
		charge(real, store.ChargeSettle, 1200, d2.Add(time.Hour), nil, nil)          // a settle on day 2
		s.Store.RecordPlanPayment(ctx, &store.PlanPayment{InvoiceID: "in_" + store.NewID(), UID: real, PlanID: "pro_monthly", AmountCents: 499,
			Currency: "usd", PaidAt: d1.Add(8 * time.Hour), PaymentIntentID: "pi_plan_" + real,
			Refunds: []store.PlanRefund{{ID: "re_plan", Cents: 499, At: d2.Add(2 * time.Hour)}}})
		// a refund of the Lifelike run, booked the next day
		row, err := s.Store.ReserveRefund(ctx, store.ReserveSpec{ChargeID: lifeCh.ID, UID: real, PI: lifeCh.PaymentIntentID, CaseID: "CASE-R1",
			Items: map[string]int64{life: 400}, StripeRemainder: -1, Source: "gateway"})
		if err != nil {
			t.Fatal(err)
		}
		at := d2.Add(3 * time.Hour)
		s.Store.UpdateRefundRow(ctx, row.ID, func(r *store.RefundRow) error {
			r.Status, r.RefundedAt, r.ReID = store.RefundSucceeded, &at, "re_life"
			return nil
		})
		// a dispute opened on day 1, lost on day 2
		cs, _, err := s.Store.CreateCase(ctx, &store.Case{UID: real, Type: store.CaseDispute, Status: store.CaseOpen, Open: true,
			Related: store.CaseRelated{ChargeIDs: []string{lifeCh.ID}}, Dispute: &store.DisputeInfo{ID: "dp_1", Amount: 600}}, "system", "dispute")
		if err != nil {
			t.Fatal(err)
		}
		lost := d2.Add(5 * time.Hour)
		s.Store.UpdateCase(ctx, cs.ID, "system", func(c *store.Case) error {
			c.OpenedAt, c.ClosedAt, c.Dispute.Outcome, c.Status, c.Open = d1.Add(14*time.Hour), &lost, "lost", store.CaseClosed, false
			return nil
		})
		// balance and credit spent on day 1
		s.Store.BalanceTx(ctx, real, func(*store.Balance) ([]store.BalanceOp, error) {
			return []store.BalanceOp{{Kind: store.EntryTopup, Cents: 1000, TopupID: "t1", Ref: "pi_t1", EntryID: "topup_t1"}}, nil
		})
		s.Store.BalanceTx(ctx, real, func(*store.Balance) ([]store.BalanceOp, error) {
			return []store.BalanceOp{{Kind: store.EntryDebtPayment, Cents: 300, Ref: "st1", EntryID: "debt_st1"}}, nil
		})

		days, err := s.buildRevenue(ctx, d1, d2.AddDate(0, 0, 1), d2.AddDate(0, 0, 5))
		if err != nil || len(days) != 2 {
			t.Fatalf("%s: %v %d", env, err, len(days))
		}
		a, b := days[0], days[1]
		testGross := map[string]int64{"test": 5000, "prod": 0}[env]
		// day 1: lifelike 1000 + preview 100 + top-up 2500 + Pro 499 (+ the probe's 5000 on TEST)
		if a.Day != "2026-11-03" || !a.Closed || a.Gross != 4099+testGross || a.Refunds != 0 || a.Net != a.Gross ||
			a.ByProduct["run_lifelike"].Gross != 1000 || a.ByProduct["run_preview"].Gross != 100 || a.ByProduct["topup"].Gross != 2500+testGross ||
			a.ByProduct["pro_monthly"].Gross != 499 || a.ByProduct["app_run"].Gross != 700 || a.App.Gross != 700 ||
			a.Counts["payments"] != map[string]int{"test": 5, "prod": 4}[env] || a.Counts["disputes"] != 1 ||
			a.Counts["new_paying_accounts"] != map[string]int{"test": 2, "prod": 1}[env] || a.ByMethod["card_cents"] != a.Gross {
			b, _ := json.Marshal(a)
			t.Fatalf("%s day 1: %s", env, b)
		}
		if len(a.Presentment) != 1 || a.Presentment[0] != (revPresentment{Currency: "jpy", AmountMinor: 1648, Count: 1}) {
			t.Fatalf("%s presentment %v", env, a.Presentment)
		}
		if (env == "test") != (a.TestAccounts != nil) || env == "test" && a.TestAccounts.Gross != 5000 {
			t.Fatalf("%s test accounts %+v", env, a.TestAccounts)
		}
		// day 2: a settle (1200), the refunds (400 run, 499 Pro) and the lost dispute (600)
		if b.Gross != 1200 || b.ByProduct["settle_batch"].Gross != 1200 || b.Counts["payments"] != 1 || b.Counts["new_paying_accounts"] != 0 ||
			b.Refunds != 899 || b.DisputesLost != 600 || b.Net != -299 || b.Counts["refunds"] != 2 ||
			b.ByProduct["run_lifelike"].Refunds != 400 || b.ByProduct["run_lifelike"].DisputesLost != 600 ||
			b.ByProduct["pro_monthly"].Refunds != 499 || b.ByProduct["pro_monthly"].Net != -499 {
			bb, _ := json.Marshal(b)
			t.Fatalf("%s day 2: %s", env, bb)
		}
		// the ledger: today's 300 from the balance (written now, so outside these days)
		today := time.Now().UTC().Truncate(24 * time.Hour)
		td, _ := s.buildRevenue(ctx, today, today.AddDate(0, 0, 1), time.Now())
		if td[0].ByMethod["balance_cents"]+td[0].ByMethod["credit_cents"] != 300 || td[0].Closed {
			t.Fatalf("%s ledger %v closed %v", env, td[0].ByMethod, td[0].Closed)
		}
		// the same past days again: the same answer
		again, _ := s.buildRevenue(ctx, d1, d2.AddDate(0, 0, 1), d2.AddDate(0, 0, 9))
		x, _ := json.Marshal(days)
		y, _ := json.Marshal(again)
		if string(x) != string(y) {
			t.Fatalf("%s not deterministic", env)
		}
	}
}

// Auth: only a Google ID token for this gateway from a service account in
// KPI_OIDC_SERVICE_ACCOUNTS; no token, another account or another
// audience is refused; bad ranges are 400.
func TestRevenueDailyAuth(t *testing.T) {
	s, _ := e0Service(t)
	s.Cfg.KPIServiceAccounts = []string{"svs-kpi-reader@spatial-video-studio.iam.gserviceaccount.com"}
	s.InternalCaller = func(_ context.Context, tok string) (string, error) {
		switch tok {
		case "good":
			return "svs-kpi-reader@spatial-video-studio.iam.gserviceaccount.com", nil
		case "other-sa":
			return "svs-backend@spatial-video-studio.iam.gserviceaccount.com", nil
		}
		return "", errors.New("token not valid for this service") // wrong audience, expired, forged
	}
	call := func(tok, query string) (int, map[string]any) {
		r := httptest.NewRequest(http.MethodGet, "/v1/admin/revenue/daily?"+query, nil)
		if tok != "" {
			r.Header.Set("Authorization", "Bearer "+tok)
		}
		w := httptest.NewRecorder()
		s.HandleAdminRevenueDaily(w, r)
		var out map[string]any
		json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	q := "from=2026-11-01&to=2026-11-02"
	for _, tok := range []string{"", "other-sa", "wrong-audience"} {
		if code, _ := call(tok, q); code != http.StatusUnauthorized {
			t.Fatalf("token %q: %d", tok, code)
		}
	}
	if code, out := call("good", q); code != 200 || len(out["days"].([]any)) != 2 || out["currency"] != "usd" || out["app"] != "separate" {
		t.Fatalf("good %d %v", code, out)
	}
	for _, bad := range []string{"from=2026-11-02&to=2026-11-01", "from=x&to=y", "from=2025-01-01&to=2026-11-01"} {
		if code, _ := call("good", bad); code != http.StatusBadRequest {
			t.Fatalf("%s: %d", bad, code)
		}
	}
	// the backend's own account can't read it, and an empty list lets nobody in
	s.Cfg.KPIServiceAccounts = nil
	if code, _ := call("good", q); code != http.StatusUnauthorized {
		t.Fatal("empty allowlist let a caller in")
	}
}

// A plan invoice's payment is recorded once from invoice.paid; its
// refunds are appended once each (a second delivery adds nothing).
func TestPlanPaymentRecord(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	inv := "in_" + store.NewID()
	at := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	if !s.recordPlanPayment(ctx, inv, uid, "business", 29900, "USD", at) || s.recordPlanPayment(ctx, inv, uid, "business", 29900, "usd", at) {
		t.Fatal("recorded twice, or not at all")
	}
	pays, _ := s.Store.ListPlanPayments(ctx, 100)
	var p *store.PlanPayment
	for _, x := range pays {
		if x.InvoiceID == inv {
			p = x
		}
	}
	if p == nil || p.AmountCents != 29900 || p.Currency != "usd" || !p.PaidAt.Equal(at) || p.PlanID != "business" {
		t.Fatalf("%+v", p)
	}
	// refunds attach by the paying PaymentIntent, once per refund
	pi := "pi_plan_" + store.NewID()
	s.Store.RecordPlanPayment(ctx, &store.PlanPayment{InvoiceID: "in_" + pi, UID: uid, PlanID: "pro_yearly", AmountCents: 4999, Currency: "usd", PaidAt: at, PaymentIntentID: pi})
	for i := 0; i < 2; i++ {
		ok, err := s.Store.AddPlanRefund(ctx, pi, store.PlanRefund{ID: "re_1", Cents: 1000, At: at.Add(time.Hour)})
		if err != nil || ok != (i == 0) {
			t.Fatalf("delivery %d: %v %v", i, ok, err)
		}
	}
	if ok, _ := s.Store.AddPlanRefund(ctx, "pi_not_a_plan", store.PlanRefund{ID: "re_2", Cents: 5}); ok {
		t.Fatal("a refund for no plan payment was added")
	}
}
