package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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
