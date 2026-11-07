//go:build stripetest

package api

// Stripe TEST-mode integration tests for the web's off-session charges
// (audit 2026-11-07). Real gateway code against real Stripe test mode and
// the Firestore emulator:
//
//	STRIPE_TEST_KEY=sk_test_… FIRESTORE_EMULATOR_HOST=127.0.0.1:8787 \
//	  go test -tags stripetest ./internal/api -run StripeTest -v
//
// Guard rails: the key must be sk_test_/rk_test_; the service runs as env
// "stripetest", so the TEST gateway's webhook handler ignores everything
// made here; every customer sits on its own test clock (metadata
// probe=offsession) and the clocks — with their customers — are deleted
// when the test ends. Mail is never sent (no Resend client). Test cards:
// 4242 (visa) and 5555 (mastercard) pay; 0341 attaches, then declines;
// 3184 always asks for the bank's check; 0002 declines (used as an
// unsaved default, it can't be attached).

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stripe/stripe-go/v78"
	"github.com/stripe/stripe-go/v78/customer"
	"github.com/stripe/stripe-go/v78/paymentintent"
	"github.com/stripe/stripe-go/v78/paymentmethod"
	"github.com/stripe/stripe-go/v78/price"
	"github.com/stripe/stripe-go/v78/subscription"
	"github.com/stripe/stripe-go/v78/subscriptionschedule"
	"github.com/stripe/stripe-go/v78/testhelpers/testclock"

	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/notify"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/revenuecat"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

const stEnv = "stripetest"

func stService(t *testing.T) *Service {
	t.Helper()
	key := strings.TrimSpace(os.Getenv("STRIPE_TEST_KEY"))
	if !strings.HasPrefix(key, "sk_test_") && !strings.HasPrefix(key, "rk_test_") {
		t.Skip("needs STRIPE_TEST_KEY (sk_test_/rk_test_ only)")
	}
	if os.Getenv("FIRESTORE_EMULATOR_HOST") == "" {
		t.Skip("needs FIRESTORE_EMULATOR_HOST")
	}
	pmc := os.Getenv("STRIPE_TEST_PMC_WEB")
	if pmc == "" {
		pmc = "pmc_1UXYkVAVV5NpxADI3Vj4kzJI" // TEST's pmc_web (deploy.sh)
	}
	st, err := store.New(context.Background(), "demo-stripetest", stEnv+store.NewID())
	if err != nil {
		t.Fatal(err)
	}
	sc := stripex.New(key, "whsec", "pk_test_x", stEnv)
	return &Service{Cfg: &config.Config{Env: stEnv, SiteURL: "https://site.example", StripePMCWeb: pmc}, Store: st, Stripe: sc,
		Pricing: pricing.NewStatic(pricing.DefaultsFor("test")), Slack: notify.NewSlack("", stEnv), RevenueCat: revenuecat.New("")}
}

// stCustomer is a made-up account on its own test clock with the magic
// test methods attached in order (the first the default). A method named
// "unsaved:pm_card_…" is only stored as the account's default (cards that
// decline at attach).
func stCustomer(t *testing.T, s *Service, name string, pms ...string) (uid, cus string, ids []string) {
	t.Helper()
	clk, err := testclock.New(&stripe.TestHelpersTestClockParams{FrozenTime: stripe.Int64(time.Now().Unix()), Name: stripe.String("offsession-" + name)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := testclock.Del(clk.ID, nil); err != nil {
			t.Logf("clock %s not deleted: %v", clk.ID, err)
		}
	})
	email := "probe.offsession+" + name + "@example.com"
	cp := &stripe.CustomerParams{Email: stripe.String(email), TestClock: stripe.String(clk.ID)}
	cp.AddMetadata("probe", "offsession")
	c, err := customer.New(cp)
	if err != nil {
		t.Fatal(err)
	}
	def := ""
	for _, pm := range pms {
		if v, ok := strings.CutPrefix(pm, "unsaved:"); ok {
			def = v
			continue
		}
		got, err := paymentmethod.Attach(pm, &stripe.PaymentMethodAttachParams{Customer: stripe.String(c.ID)})
		if err != nil {
			t.Fatalf("attach %s: %v", pm, err)
		}
		ids = append(ids, got.ID)
		time.Sleep(1100 * time.Millisecond) // distinct created seconds: backups go oldest first
	}
	if len(ids) > 0 {
		if _, err := customer.Update(c.ID, &stripe.CustomerParams{InvoiceSettings: &stripe.CustomerInvoiceSettingsParams{DefaultPaymentMethod: stripe.String(ids[0])}}); err != nil {
			t.Fatal(err)
		}
		if def == "" {
			def = ids[0]
		}
	}
	uid = "u" + store.NewID()
	if err := s.Store.PutCustomer(context.Background(), uid, &store.Customer{StripeCustomerID: c.ID, Email: email, DefaultPaymentMethod: def}); err != nil {
		t.Fatal(err)
	}
	t.Logf("evidence: clock %s customer %s methods %v", clk.ID, c.ID, ids)
	return uid, c.ID, ids
}

func stPIs(t *testing.T, cus string) []*stripe.PaymentIntent {
	t.Helper()
	p := &stripe.PaymentIntentListParams{Customer: stripe.String(cus)}
	p.AddExpand("data.payment_method")
	it := paymentintent.List(p)
	var out []*stripe.PaymentIntent
	for it.Next() {
		pi := it.PaymentIntent()
		code := ""
		if pi.LastPaymentError != nil {
			code = string(pi.LastPaymentError.Code) + "/" + string(pi.LastPaymentError.DeclineCode)
		}
		pmc := ""
		if pi.PaymentMethodConfigurationDetails != nil {
			pmc = pi.PaymentMethodConfigurationDetails.ID
		}
		t.Logf("evidence: PI %s %s %d %s pmc=%s err=%s", pi.ID, pi.Status, pi.Amount, pi.Currency, pmc, code)
		out = append(out, pi)
	}
	return out
}

func countStatus(pis []*stripe.PaymentIntent, st stripe.PaymentIntentStatus) int {
	n := 0
	for _, pi := range pis {
		if pi.Status == st {
			n++
		}
	}
	return n
}

func stReload(t *testing.T, s *Service, uid string) string {
	t.Helper()
	ctx := context.Background()
	if _, _, err := s.Store.BalanceTx(ctx, uid, func(b *store.Balance) ([]store.BalanceOp, error) {
		b.AutoReload = store.AutoReload{Enabled: true, BelowCents: 500, AddCents: 2000}
		return []store.BalanceOp{{Kind: store.EntryAdjustment, Cents: 0, Note: "settings"}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	id := "r" + store.NewID()
	now := time.Now().UTC()
	if err := s.Store.CreateTopup(ctx, &store.Topup{ID: id, UID: uid, Cents: 2000, Currency: "usd", State: store.TopupCharging, Auto: true,
		CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	return id
}

// Auto-reload (web): the default pays; a decline (0341) and a bank check
// (3184) go on to the backup; 0002 alone fails paused with no credit; a
// refused request (a method of another customer: invalid_request) still
// tries the backup. Every charge under pmc_web, in USD, credited once.
func TestStripeTestAutoReload(t *testing.T) {
	s := stService(t)
	ctx := context.Background()
	_, _, foreignPMs := stCustomer(t, s, "reload-foreign", "pm_card_visa")
	for _, tc := range []struct {
		name     string
		pms      []string
		state    string
		paidWith int // index into the attached methods; -1 none
		paused   string
	}{
		{"reload-visa", []string{"pm_card_visa"}, store.TopupPaid, 0, ""},
		{"reload-0341-backup", []string{"pm_card_chargeCustomerFail", "pm_card_mastercard"}, store.TopupPaid, 1, ""},
		{"reload-3184-backup", []string{"pm_card_authenticationRequired", "pm_card_mastercard"}, store.TopupPaid, 1, ""},
		{"reload-0002-only", []string{"unsaved:pm_card_chargeDeclined"}, store.TopupFailed, -1, "declined"},
		{"reload-refused-backup", []string{"unsaved:" + foreignPMs[0], "pm_card_mastercard"}, store.TopupPaid, 0, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			uid, cus, ids := stCustomer(t, s, tc.name, tc.pms...)
			id := stReload(t, s, uid)
			s.runReload(ctx, id)
			// a duplicate succeeded event changes nothing
			if tp, _ := s.Store.GetTopup(ctx, id); tp.PaymentIntentID != "" {
				_ = s.handleTopupPI(ctx, "payment_intent.succeeded", id, tp.PaymentIntentID, "succeeded", 2000, tp.PaidWith)
			}
			tp, _ := s.Store.GetTopup(ctx, id)
			b, _ := s.Store.GetBalance(ctx, uid)
			entries, _, _ := s.Store.ListEntries(ctx, uid, 50, "")
			topups := 0
			for _, e := range entries {
				if e.Kind == store.EntryTopup {
					topups++
				}
			}
			t.Logf("evidence: topup %s state=%s pi=%s paid_with=%s balance=%d paused=%q", id, tp.State, tp.PaymentIntentID, tp.PaidWith, b.BalanceCents, b.AutoReload.PausedReason)
			pis := stPIs(t, cus)
			if tp.State != tc.state || b.AutoReload.PausedReason != tc.paused {
				t.Fatalf("state %s paused %q", tp.State, b.AutoReload.PausedReason)
			}
			if tc.state == store.TopupPaid {
				if tc.paidWith >= 0 && tc.paidWith < len(ids) && tp.PaidWith != ids[tc.paidWith] {
					t.Fatalf("paid with %s, want %s", tp.PaidWith, ids[tc.paidWith])
				}
				if b.BalanceCents != 2000 || topups != 1 || countStatus(pis, stripe.PaymentIntentStatusSucceeded) != 1 {
					t.Fatalf("balance %d topup entries %d", b.BalanceCents, topups)
				}
			} else if b.BalanceCents != 0 || topups != 0 || countStatus(pis, stripe.PaymentIntentStatusSucceeded) != 0 {
				t.Fatal("credit or money on a failed reload")
			}
			for _, pi := range pis {
				if pi.Currency != "usd" || pi.PaymentMethodConfigurationDetails == nil || pi.PaymentMethodConfigurationDetails.ID != s.Cfg.StripePMCWeb {
					t.Fatalf("PI %s not USD under pmc_web", pi.ID)
				}
				if pi.Status == stripe.PaymentIntentStatusRequiresPaymentMethod {
					t.Fatalf("PI %s left open", pi.ID)
				}
			}
		})
	}
}

func stOwedRun(t *testing.T, s *Service, uid string, cents int64) string {
	t.Helper()
	c := &store.Conversion{ID: store.NewID(), UID: uid, State: store.StateSucceeded, Kind: "video", Quote: store.Quote{AmountCents: cents, Currency: "usd"}}
	c.Stripe.Mode, c.Stripe.PIStatus = store.BillingModeAuto, store.PIChargeFailed
	if err := s.Store.CreateConversion(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	return c.ID
}

// Deletion dues (web): the settle pays on the default, or on the backup
// after 0341 or 3184; nothing is left open; the ledger records it once.
func TestStripeTestDeletionDues(t *testing.T) {
	s := stService(t)
	ctx := context.Background()
	for _, tc := range []struct {
		name string
		pms  []string
		paid bool
	}{
		{"dues-visa", []string{"pm_card_visa"}, true},
		{"dues-0341-backup", []string{"pm_card_chargeCustomerFail", "pm_card_mastercard"}, true},
		{"dues-3184-backup", []string{"pm_card_authenticationRequired", "pm_card_mastercard"}, true},
		{"dues-0341-only", []string{"pm_card_chargeCustomerFail"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			uid, cus, _ := stCustomer(t, s, tc.name, tc.pms...)
			conv := stOwedRun(t, s, uid, 1500)
			res, err := s.collectOutstanding(ctx, uid, settleDelete, payContext{})
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("evidence: settle %s state=%s pi=%s paid_with=%s", res.Settle.ID, res.Settle.State, res.Settle.PaymentIntentID, res.Settle.PaidWith)
			pis := stPIs(t, cus)
			c, _ := s.Store.GetConversion(ctx, conv)
			if res.Paid != tc.paid || (tc.paid && (c.Stripe.PIStatus != store.PISucceeded || countStatus(pis, stripe.PaymentIntentStatusSucceeded) != 1)) {
				t.Fatalf("paid %v run %s", res.Paid, c.Stripe.PIStatus)
			}
			if tc.paid {
				if _, cerr := s.Store.GetCharge(ctx, store.ChargeSettle+"_"+res.Settle.ID); cerr != nil {
					t.Fatalf("charge record: %v", cerr)
				}
			}
			for _, pi := range pis {
				if pi.Status == stripe.PaymentIntentStatusRequiresPaymentMethod {
					t.Fatalf("PI %s left open", pi.ID)
				}
			}
		})
	}
}

// B5 against real Stripe: the charge went out (the gateway recorded it
// first) and its answer was lost; the sweep finds the PaymentIntent and
// the debt is paid by it — never charged a second time.
func TestStripeTestSettleLostAnswer(t *testing.T) {
	s := stService(t)
	ctx := context.Background()
	for _, trigger := range []string{settleDelete, settleSoftRety} {
		t.Run(trigger, func(t *testing.T) {
			uid, cus, ids := stCustomer(t, s, "lost-"+strings.ReplaceAll(trigger, "_", ""), "pm_card_visa")
			stOwedRun(t, s, uid, 1000)
			st, err := s.Store.OpenSettle(ctx, uid, trigger, store.Lease{Owner: "gone", Until: time.Now().Add(-time.Minute)})
			if err != nil {
				t.Fatal(err)
			}
			at := time.Now().UTC()
			s.Store.UpdateSettle(ctx, st.ID, func(x *store.Settle) error {
				x.ChargeKey, x.ChargePM, x.ChargeCustomerID, x.ChargeStartedAt = s.Stripe.SettleChargeKey(st.ID), ids[0], cus, &at
				return nil
			})
			pi, err := s.Stripe.ChargeSettle(cus, ids[0], 1000, "usd", st.ID, stripex.Job{Web: true, UID: uid,
				Metadata: map[string]string{"settle_id": st.ID, "payment_flow": "settle"}})
			if err != nil || pi.Status != stripe.PaymentIntentStatusSucceeded {
				t.Fatalf("the lost charge: %v", err)
			}
			s.settleSweep(ctx)
			again, err := s.collectOutstanding(ctx, uid, trigger, payContext{})
			got, _ := s.Store.GetSettle(ctx, st.ID)
			t.Logf("evidence: settle %s state=%s pi=%s (lost answer %s)", st.ID, got.State, got.PaymentIntentID, pi.ID)
			pis := stPIs(t, cus)
			if err != nil || !again.Nothing || got.State != store.SettlePaid || got.PaymentIntentID != pi.ID || countStatus(pis, stripe.PaymentIntentStatusSucceeded) != 1 {
				t.Fatalf("again %+v settle %s: charged %d times", again, got.State, countStatus(pis, stripe.PaymentIntentStatusSucceeded))
			}
		})
	}
}

// D1 regression on real Stripe: ios_settle on a 3184 default with a
// working backup still answers declined without a client secret and
// tries nothing else (the shipped app behaviour).
func TestStripeTestAppSettleUnchanged(t *testing.T) {
	s := stService(t)
	ctx := context.Background()
	uid, cus, _ := stCustomer(t, s, "ios-3184", "pm_card_authenticationRequired", "pm_card_mastercard")
	stOwedRun(t, s, uid, 1500)
	res, err := s.collectOutstanding(ctx, uid, settleIOS, payContext{})
	pis := stPIs(t, cus)
	if err != nil || res.Paid || !res.Declined || res.RequiresAction || len(pis) != 1 || pis[0].Status != stripe.PaymentIntentStatusRequiresPaymentMethod ||
		pis[0].PaymentMethodConfigurationDetails != nil && pis[0].PaymentMethodConfigurationDetails.ID == s.Cfg.StripePMCWeb {
		t.Fatalf("%v %+v PIs %d", err, res, len(pis))
	}
	_, _ = paymentintent.Cancel(pis[0].ID, nil) // tidy: the app path leaves it, as shipped
}

// The 48-hour sweep end to end: dues paid on the backup, then the account
// deleted.
func TestStripeTestDeletionSweep(t *testing.T) {
	s := stService(t)
	ctx := context.Background()
	uid, cus, _ := stCustomer(t, s, "sweep-0341-backup", "pm_card_chargeCustomerFail", "pm_card_mastercard")
	stOwedRun(t, s, uid, 1500)
	now := time.Now().UTC()
	if _, _, err := s.Store.ScheduleAccountDeletion(ctx, &store.AccountDeletion{UID: uid, RequestedAt: now.Add(-49 * time.Hour),
		DeleteAfter: now.Add(-time.Hour), Email: "probe.offsession+sweep@example.com", Source: "web"}); err != nil {
		t.Fatal(err)
	}
	out, err := s.processScheduledDeletion(ctx, uid, "sweep", false)
	c, _ := s.Store.GetCustomer(ctx, uid)
	pis := stPIs(t, cus)
	t.Logf("evidence: deletion outcome=%q err=%v deleted=%v", out, err, c.AccountDeleted)
	if err != nil || out != store.DeletionOutcomeDeleted || !c.AccountDeleted || countStatus(pis, stripe.PaymentIntentStatusSucceeded) != 1 {
		t.Fatalf("outcome %q %v", out, err)
	}
}

func stPrice(t *testing.T, lookup string) string {
	t.Helper()
	it := price.List(&stripe.PriceListParams{LookupKeys: stripe.StringSlice([]string{lookup})})
	for it.Next() {
		return it.Price().ID
	}
	t.Fatalf("no test price %s", lookup)
	return ""
}

// stPlan is a web Business plan (a real subscription on the clock) on the
// account, paid by its first method.
func stPlan(t *testing.T, s *Service, uid, cus, pm string) string {
	t.Helper()
	p := &stripe.SubscriptionParams{Customer: stripe.String(cus), DefaultPaymentMethod: stripe.String(pm), OffSession: stripe.Bool(true),
		Items: []*stripe.SubscriptionItemsParams{{Price: stripe.String(stPrice(t, "svs_web_business_monthly"))}}}
	for k, v := range map[string]string{"product": "svs-web", "env": stEnv, "user_id": uid, "plan": "business", "probe": "offsession"} {
		p.AddMetadata(k, v)
	}
	sub, err := subscription.New(p)
	if err != nil || sub.Status != stripe.SubscriptionStatusActive {
		t.Fatalf("subscription: %v", err)
	}
	start, end := time.Unix(sub.CurrentPeriodStart, 0), time.Unix(sub.CurrentPeriodEnd, 0)
	if _, err := s.Store.UpdateCustomer(context.Background(), uid, func(c *store.Customer) error {
		c.Plan = &store.Plan{Tier: "business", SubscriptionID: sub.ID, Status: "active", CurrentPeriodStart: &start, CurrentPeriodEnd: &end,
			PeriodPaidCents: 29900}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	t.Logf("evidence: subscription %s", sub.ID)
	return sub.ID
}

// #3 on real Stripe: a step-down waits; a step-up on a card that declines
// (0341) fails 402 and the step-down is scheduled again.
func TestStripeTestStepUpFailureRestoresStepDown(t *testing.T) {
	s := stService(t)
	ctx := context.Background()
	uid, cus, ids := stCustomer(t, s, "stepup-restore", "pm_card_visa", "pm_card_chargeCustomerFail")
	sub := stPlan(t, s, uid, cus, ids[0])
	call := func(body string) (int, map[string]any) {
		return callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandlePlanChange(w, r, &AuthedUser{UID: uid}) }, "POST", body)
	}
	if code, out := call(`{"to":"pro_monthly","confirm":true}`); code != 200 {
		t.Fatalf("step-down %d %v", code, out)
	}
	c, _ := s.Store.GetCustomer(ctx, uid)
	first := c.Plan.ScheduleID
	if _, err := subscription.Update(sub, &stripe.SubscriptionParams{DefaultPaymentMethod: stripe.String(ids[1])}); err != nil {
		t.Fatal(err)
	}
	code, out := call(`{"to":"studio","confirm":true}`)
	c, _ = s.Store.GetCustomer(ctx, uid)
	got, _ := subscription.Get(sub, nil)
	gotSchedule := ""
	if got.Schedule != nil {
		gotSchedule = got.Schedule.ID
	}
	t.Logf("evidence: step-up %d %v; schedule %s → %s; subscription's schedule %s", code, out["error"], first, c.Plan.ScheduleID, gotSchedule)
	if code != 402 || c.Plan.Tier != "business" || c.Plan.ScheduledTo != "pro_monthly" || c.Plan.ScheduleID == "" || c.Plan.ScheduleID == first ||
		got.Schedule == nil || got.Schedule.ID != c.Plan.ScheduleID {
		t.Fatalf("not restored: %d %+v", code, c.Plan)
	}
	old, _ := subscriptionschedule.Get(first, nil)
	sch, _ := subscriptionschedule.Get(c.Plan.ScheduleID, nil)
	if old.Status != stripe.SubscriptionScheduleStatusReleased || len(sch.Phases) != 2 || sch.Phases[1].Items[0].Price.ID != stPrice(t, "svs_web_pro_monthly") {
		t.Fatalf("schedules: old %s new phases %d", old.Status, len(sch.Phases))
	}
	_, _ = subscriptionschedule.Release(sch.ID, nil)
	_, _ = subscription.Cancel(sub, nil)
}

// D6 on real Stripe: Make default moves the plan's own method.
func TestStripeTestMakeDefaultRepointsPlan(t *testing.T) {
	s := stService(t)
	uid, cus, ids := stCustomer(t, s, "make-default", "pm_card_visa", "pm_card_mastercard")
	sub := stPlan(t, s, uid, cus, ids[0])
	code, _ := callJSON(t, func(w http.ResponseWriter, r *http.Request) {
		s.HandleSetDefaultMethod(w, r, &AuthedUser{UID: uid}, ids[1])
	}, "POST", "")
	got, _ := subscription.Get(sub, nil)
	t.Logf("evidence: make default %d; subscription %s now charges %v", code, sub, got.DefaultPaymentMethod.ID)
	if got.DefaultPaymentMethod == nil || got.DefaultPaymentMethod.ID != ids[1] {
		t.Fatal("the plan still charges the old method")
	}
	_, _ = subscription.Cancel(sub, nil)
}

// ---------------------------------------------------------------- D2–D7

// stConfirmCheckout pays an open Checkout Session the way Stripe.js does
// (payment_pages with the publishable key and a test token), so a pay
// page can be completed without a browser. Skips without STRIPE_TEST_PK.
func stConfirmCheckout(t *testing.T, sessionID, token string) {
	t.Helper()
	pk := strings.TrimSpace(os.Getenv("STRIPE_TEST_PK"))
	if !strings.HasPrefix(pk, "pk_test_") {
		t.Skip("needs STRIPE_TEST_PK (pk_test_) to complete a Checkout Session")
	}
	post := func(path string, form url.Values) map[string]any {
		form.Set("key", pk)
		resp, err := http.PostForm("https://api.stripe.com"+path, form)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		if resp.StatusCode != 200 {
			t.Fatalf("%s: %d %v", path, resp.StatusCode, out["error"])
		}
		return out
	}
	init := post("/v1/payment_pages/"+sessionID+"/init", url.Values{"browser_locale": {"en-US"}, "eid": {"NA"}})
	pm := post("/v1/payment_methods", url.Values{"type": {"card"}, "card[token]": {token}, "billing_details[name]": {"Offsession Probe"},
		"billing_details[address][country]": {"US"}, "billing_details[email]": {fmt.Sprint(init["customer_email"])}})
	f := url.Values{"eid": {"NA"}, "payment_method": {pm["id"].(string)}, "expected_payment_method_type": {"card"},
		"init_checksum": {fmt.Sprint(init["init_checksum"])}}
	if ts, ok := init["total_summary"].(map[string]any); ok {
		f.Set("expected_amount", fmt.Sprint(int64(ts["due"].(float64))))
	}
	out := post("/v1/payment_pages/"+sessionID+"/confirm", f)
	t.Logf("evidence: checkout %s confirmed: %v / %v", sessionID, out["status"], out["payment_status"])
}

// D2/D3 on real Stripe: a soft decline (0341) fails the reload with no
// credit and auto-reload paused; the +24 h retry charges under its own key
// (still 0341: declined, PI cancelled); the account's card is replaced and
// the +72 h retry pays — credited once, the pause lifted.
func TestStripeTestReloadRetry(t *testing.T) {
	s := stService(t)
	ctx := context.Background()
	uid, cus, ids := stCustomer(t, s, "reload-retry", "pm_card_chargeCustomerFail")
	id := stReload(t, s, uid)
	s.runReload(ctx, id)
	tp, _ := s.Store.GetTopup(ctx, id)
	b, _ := s.Store.GetBalance(ctx, uid)
	if tp.Retry == nil || tp.Retry.State != store.RetryPending || b.BalanceCents != 0 || b.AutoReload.PausedReason != "declined" {
		t.Fatalf("first failure %+v %+v", tp.Retry, b.AutoReload)
	}
	due := func() {
		past := time.Now().Add(-time.Second)
		s.Store.UpdateTopup(ctx, id, func(x *store.Topup) error { x.Retry.NextAttemptAt = &past; return nil })
		s.reloadRetrySweep(ctx, time.Now())
	}
	due()
	tp, _ = s.Store.GetTopup(ctx, id)
	if tp.Retry.Attempts != 2 || tp.Retry.State != store.RetryPending {
		t.Fatalf("second try %+v", tp.Retry)
	}
	visa, err := paymentmethod.Attach("pm_card_visa", &stripe.PaymentMethodAttachParams{Customer: stripe.String(cus)})
	if err != nil {
		t.Fatal(err)
	}
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error { c.DefaultPaymentMethod = visa.ID; return nil })
	due()
	tp, _ = s.Store.GetTopup(ctx, id)
	b, _ = s.Store.GetBalance(ctx, uid)
	pis := stPIs(t, cus)
	t.Logf("evidence: topup %s retry %s attempts %d pi %s (first method %s)", id, tp.Retry.State, tp.Retry.Attempts, tp.PaymentIntentID, ids[0])
	if tp.State != store.TopupPaid || tp.Retry.State != store.RetryPaid || b.BalanceCents != 2000 || b.AutoReload.PausedReason != "" ||
		countStatus(pis, stripe.PaymentIntentStatusSucceeded) != 1 || len(pis) != 3 {
		t.Fatalf("after the third try: %s %+v balance %d PIs %d", tp.State, tp.Retry, b.BalanceCents, len(pis))
	}
}

// D7 on real Stripe: a failed reload's pay link opens a Checkout Session
// for exactly its amount (pmc_web, Adaptive Pricing on); paid, the
// balance is credited once and the link closes.
func TestStripeTestPayLinkTopup(t *testing.T) {
	s := stService(t)
	ctx := context.Background()
	uid, cus, _ := stCustomer(t, s, "paylink-topup", "pm_card_chargeCustomerFail")
	id := stReload(t, s, uid)
	s.runReload(ctx, id)
	tp, _ := s.Store.GetTopup(ctx, id)
	tok := tp.Retry.PayRequestID
	code, out := payCall(t, s.HandlePayRequestCheckout, "POST", tok, `{"ui":"elements"}`)
	if code != 200 {
		t.Fatalf("checkout %d %v", code, out)
	}
	pr, _ := s.Store.GetPayRequest(ctx, tok)
	stConfirmCheckout(t, pr.CheckoutID, "tok_visa")
	if err := s.applyTopupSessionEvent(ctx, "checkout.session.completed", pr.CheckoutID, pr.TopupID); err != nil {
		t.Fatal(err)
	}
	pr, _ = s.Store.GetPayRequest(ctx, tok)
	b, _ := s.Store.GetBalance(ctx, uid)
	stPIs(t, cus)
	t.Logf("evidence: pay link %s… session %s topup %s state %s balance %d", tok[:10], pr.CheckoutID, pr.TopupID, pr.State, b.BalanceCents)
	if pr.State != store.PayPaid || b.BalanceCents != 2000 {
		t.Fatalf("link %s balance %d", pr.State, b.BalanceCents)
	}
	if code, _ := payCall(t, s.HandlePayRequestCheckout, "POST", tok, `{}`); code != 409 {
		t.Fatal("a paid link took another payment")
	}
}

// #2 on real Stripe: the sweep's dues charge on 0341 fails; the 6-hourly
// check charges nothing; the retry charges a new settle under a new key.
func TestStripeTestDeletionDuesRetry(t *testing.T) {
	s := stService(t)
	ctx := context.Background()
	uid, cus, _ := stCustomer(t, s, "dues-retry", "pm_card_chargeCustomerFail")
	stOwedRun(t, s, uid, 1500)
	now := time.Now().UTC()
	s.Store.ScheduleAccountDeletion(ctx, &store.AccountDeletion{UID: uid, RequestedAt: now.Add(-49 * time.Hour), DeleteAfter: now.Add(-time.Hour),
		Email: "probe.offsession+dues-retry@example.com", Source: "web"})
	run := func(retryDue bool) {
		past := time.Now().UTC().Add(-time.Second)
		s.Store.UpdateAccountDeletion(ctx, uid, func(d *store.AccountDeletion) error {
			d.NextAttemptAt = &past
			if retryDue && d.DuesRetry != nil && d.DuesRetry.NextAttemptAt != nil {
				d.DuesRetry.NextAttemptAt = &past
			}
			return nil
		})
		s.processScheduledDeletion(ctx, uid, "sweep", false)
	}
	run(false)
	run(false)
	if n := len(stPIs(t, cus)); n != 1 {
		t.Fatalf("charged between retries: %d PIs", n)
	}
	run(true)
	d, _ := s.Store.GetAccountDeletion(ctx, uid)
	pis := stPIs(t, cus)
	t.Logf("evidence: dues retry %s attempts %d", d.DuesRetry.State, d.DuesRetry.Attempts)
	if len(pis) != 2 || d.DuesRetry.Attempts != 2 || d.State != store.DeletionStatePending {
		t.Fatalf("PIs %d retry %+v", len(pis), d.DuesRetry)
	}
	for _, pi := range pis {
		if pi.Status != stripe.PaymentIntentStatusCanceled {
			t.Fatalf("PI %s left %s", pi.ID, pi.Status)
		}
	}
}

// D4 on real Stripe: a step-up on a card that always asks for the bank's
// check (3184) answers 402 with a pay link; the pay page is paid
// on-session with another card; the change is made with that payment as
// its invoice's credit (the invoice settles at $0, nothing charged twice).
// The same quote's retry after a decline isn't Stripe's cached 402.
func TestStripeTestStepUpPayLink(t *testing.T) {
	s := stService(t)
	ctx := context.Background()
	uid, cus, ids := stCustomer(t, s, "stepup-paylink", "pm_card_authenticationRequired", "pm_card_visa")
	sub := stPlan(t, s, uid, cus, ids[1])
	if _, err := subscription.Update(sub, &stripe.SubscriptionParams{DefaultPaymentMethod: stripe.String(ids[0])}); err != nil {
		t.Fatal(err)
	}
	call := func(body string) (int, map[string]any) {
		return callJSON(t, func(w http.ResponseWriter, r *http.Request) { s.HandlePlanChange(w, r, &AuthedUser{UID: uid}) }, "POST", body)
	}
	code, out := call(`{"to":"studio","confirm":true}`)
	d, _ := out["details"].(map[string]any)
	if code != 402 || d["requires_action"] != true || d["pay_url"] == nil {
		t.Fatalf("step-up %d %v", code, out)
	}
	tok := tokenOf(t, d["pay_url"].(string))
	code, co := payCall(t, s.HandlePayRequestCheckout, "POST", tok, `{}`)
	if code != 200 {
		t.Fatalf("pay page %d %v", code, co)
	}
	pr, _ := s.Store.GetPayRequest(ctx, tok)
	stConfirmCheckout(t, pr.CheckoutID, "tok_visa")
	sess, err := s.Stripe.GetCheckoutSession(pr.CheckoutID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.applyStepUpSession(ctx, "checkout.session.completed", pr.CheckoutID, sess.Metadata); err != nil {
		t.Fatal(err)
	}
	got, _ := subscription.Get(sub, &stripe.SubscriptionParams{Params: stripe.Params{Expand: []*string{stripe.String("latest_invoice")}}})
	c, _ := s.Store.GetCustomer(ctx, uid)
	pis := stPIs(t, cus)
	t.Logf("evidence: subscription %s price %s latest invoice %s %s total %d", sub, got.Items.Data[0].Price.ID, got.LatestInvoice.ID, got.LatestInvoice.Status, got.LatestInvoice.Total)
	if got.Items.Data[0].Price.ID != stPrice(t, "svs_web_studio_yearly") || got.LatestInvoice.Total != 0 || got.LatestInvoice.Status != stripe.InvoiceStatusPaid ||
		c.Plan.Tier != "studio" || countStatus(pis, stripe.PaymentIntentStatusSucceeded) != 2 { // the plan's first month + the pay page
		t.Fatalf("after paying: tier %s invoice %d", c.Plan.Tier, got.LatestInvoice.Total)
	}
	_, _ = subscription.Cancel(sub, nil)
}

// D5 on real Stripe: a renewal on 0341 fails at the cycle (test clock);
// its invoice.payment_failed (read back from Stripe: the TEST gateway gets
// the webhook, not this test) puts the plan past_due with the hosted
// invoice as its pay link.
func TestStripeTestRenewalDunning(t *testing.T) {
	s := stService(t)
	ctx := context.Background()
	uid, cus, ids := stCustomer(t, s, "renewal-dunning", "pm_card_visa", "pm_card_chargeCustomerFail")
	sub := stPlan(t, s, uid, cus, ids[0])
	if _, err := subscription.Update(sub, &stripe.SubscriptionParams{DefaultPaymentMethod: stripe.String(ids[1])}); err != nil {
		t.Fatal(err)
	}
	cu, _ := customer.Get(cus, nil)
	clk := cu.TestClock.ID
	ck, _ := testclock.Get(clk, nil)
	if _, err := testclock.Advance(clk, &stripe.TestHelpersTestClockAdvanceParams{FrozenTime: stripe.Int64(ck.FrozenTime + 32*86400)}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 60; i++ {
		time.Sleep(3 * time.Second)
		if ck, _ = testclock.Get(clk, nil); ck.Status == stripe.TestHelpersTestClockStatusReady {
			break
		}
	}
	got, _ := subscription.Get(sub, &stripe.SubscriptionParams{Params: stripe.Params{Expand: []*string{stripe.String("latest_invoice")}}})
	inv := got.LatestInvoice
	raw, _ := json.Marshal(map[string]any{"id": inv.ID, "status": inv.Status, "amount_due": inv.AmountDue, "currency": inv.Currency,
		"attempt_count": inv.AttemptCount, "next_payment_attempt": inv.NextPaymentAttempt, "hosted_invoice_url": inv.HostedInvoiceURL,
		"billing_reason": inv.BillingReason, "subscription": sub})
	s.handlePlanInvoiceFailed(ctx, "invoice.payment_failed", raw)
	plan := s.planJSON(ctx, uid)
	t.Logf("evidence: clock %s subscription %s %s invoice %s %s attempts %d next %d", clk, sub, got.Status, inv.ID, inv.Status, inv.AttemptCount, inv.NextPaymentAttempt)
	if got.Status != stripe.SubscriptionStatusPastDue || plan["past_due"] != true || plan["pay_url"] == nil || plan["active"] != true {
		t.Fatalf("plan %v", plan)
	}
	code, out := payCall(t, s.HandlePayRequestCheckout, "POST", tokenOf(t, plan["pay_url"].(string)), `{}`)
	if u, _ := out["url"].(string); code != 200 || !strings.HasPrefix(u, "https://invoice.stripe.com/i/") || out["amount_cents"] != float64(inv.AmountDue) {
		t.Fatalf("pay link %d %v", code, out)
	}
	_, _ = subscription.Cancel(sub, nil)
}
