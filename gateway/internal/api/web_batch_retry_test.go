package api

import (
	"context"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// groupDueNow makes a group's next retry due.
func groupDueNow(t *testing.T, s *Service, batchID string) {
	t.Helper()
	past := time.Now().UTC().Add(-time.Second)
	if _, err := s.Store.TransitionBatch(context.Background(), batchID, []string{store.BatchFailed}, func(bb *store.Batch) error {
		if bb.Retry != nil && bb.Retry.NextAttemptAt != nil {
			bb.Retry.NextAttemptAt = &past
		}
		return nil
	}, nil, nil); err != nil {
		t.Fatal(err)
	}
}

func settleKeys(f *offFake) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var keys []string
	for _, c := range f.creates {
		if c["metadata[settle_id]"] != "" {
			keys = append(keys, c["key"])
		}
	}
	return keys
}

// D2 on a web group: a soft decline fails the group with a schedule
// (+24 h, +72 h) and a settle pay link, mailed (E2) and shown in Billing;
// each retry is a new settle under its own key (E3 each); the third
// failure is final and nothing is charged after it.
func TestWebGroupSoftDeclineRetriesTwiceThenStops(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_1", "decline:insufficient_funds"})
	b := offBatch(t, s, uid, "proj_1", 1000, 500)
	before := time.Now()
	got, err := s.chargeBatch(ctx, b)
	if err != nil || got.State != store.BatchFailed {
		t.Fatalf("%v %+v", err, got)
	}
	r := got.Retry
	if r == nil || r.State != store.RetryPending || r.Attempts != 1 || r.MaxAttempts != 3 || r.Reason != retrySoft ||
		r.PayRequestID == "" || r.NextAttemptAt.Sub(before) < 24*time.Hour-time.Minute || r.NextAttemptAt.Sub(before) > 24*time.Hour+time.Minute ||
		r.LastErrorMessage != "Your bank declined the payment: not enough funds." {
		t.Fatalf("schedule %+v", r)
	}
	if pr, err := s.Store.GetPayRequest(ctx, r.PayRequestID); err != nil || pr.Kind != store.PayKindSettle || pr.State != store.PayOpen {
		t.Fatalf("pay link %+v %v", pr, err)
	}
	if !mailed(s, "E2_"+b.ID) {
		t.Fatal("no E2")
	}
	cust, _ := s.Store.GetCustomer(ctx, uid)
	status, err := s.billingStatus(ctx, &AuthedUser{UID: uid}, cust)
	if err != nil {
		t.Fatal(err)
	}
	banner, _ := status["retry"].(map[string]any)
	unpaid, _ := status["unpaid"].([]map[string]any)
	if banner == nil || banner["state"] != store.RetryPending || banner["pay_url"] != s.payURL(r.PayRequestID) || banner["amount_cents"] != int64(1500) ||
		len(unpaid) != 1 || unpaid[0]["retry"] == nil {
		t.Fatalf("billing %v", status)
	}
	// Not due yet: the sweep charges nothing.
	s.settleSweep(ctx)
	if len(settleKeys(f)) != 0 {
		t.Fatal("charged before the retry was due")
	}
	for try := 2; try <= 3; try++ {
		groupDueNow(t, s, b.ID)
		s.settleSweep(ctx)
		got, _ = s.Store.GetBatch(ctx, b.ID)
		if got.State != store.BatchFailed || got.Retry.Attempts != try {
			t.Fatalf("try %d: %s %+v", try, got.State, got.Retry)
		}
	}
	r = got.Retry
	if r.State != store.RetryFinal || r.NextAttemptAt != nil || r.FinalAt == nil {
		t.Fatalf("after the third %+v", r)
	}
	keys := settleKeys(f)
	if len(keys) != 2 || keys[0] == keys[1] || !strings.HasPrefix(keys[0], "settle_test_") {
		t.Fatalf("retry keys %v", keys)
	}
	if !mailed(s, "E3_"+b.ID+"_2") || !mailed(s, "E3_"+b.ID+"_final") {
		t.Fatal("retry mails missing")
	}
	groupDueNow(t, s, b.ID)
	s.settleSweep(ctx)
	if len(settleKeys(f)) != 2 || s.owedCents(ctx, uid) != 1500 || f.succeeded() != 0 {
		t.Fatalf("charged after the final failure: %v", settleKeys(f))
	}
}

// The +24 h retry pays: the group is paid once, the schedule ends, the
// pay link closes.
func TestWebGroupRetryPays(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_1", "decline:insufficient_funds"})
	b := offBatch(t, s, uid, "proj_1", 1200)
	got, _ := s.chargeBatch(ctx, b)
	prID := got.Retry.PayRequestID
	f.mu.Lock()
	f.outcome["pm_1"] = ""
	f.mu.Unlock()
	groupDueNow(t, s, b.ID)
	s.settleSweep(ctx)
	s.settleSweep(ctx)
	got, _ = s.Store.GetBatch(ctx, b.ID)
	if got.State != store.BatchPaid || got.Retry.State != store.RetryPaid || got.Retry.Attempts != 2 || f.succeeded() != 1 || s.owedCents(ctx, uid) != 0 {
		t.Fatalf("%s %+v succeeded %d", got.State, got.Retry, f.succeeded())
	}
	if pr, _ := s.Store.GetPayRequest(ctx, prID); pr.State != store.PayPaid {
		t.Fatalf("pay link %s", pr.State)
	}
	cust, _ := s.Store.GetCustomer(ctx, uid)
	if status, _ := s.billingStatus(ctx, &AuthedUser{UID: uid}, cust); status["retry"] != nil {
		t.Fatalf("banner after paying: %v", status["retry"])
	}
}

// A hard decline: final at once (no retry), still a pay link and E2.
func TestWebGroupHardDeclineNoRetry(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_1", "decline:expired_card"})
	b := offBatch(t, s, uid, "proj_1", 800)
	got, _ := s.chargeBatch(ctx, b)
	if got.Retry == nil || got.Retry.State != store.RetryFinal || got.Retry.Reason != retryHard || got.Retry.PayRequestID == "" || !mailed(s, "E2_"+b.ID) {
		t.Fatalf("%+v", got.Retry)
	}
	old := time.Now().Add(-25 * time.Hour)
	s.Store.TransitionBatch(ctx, b.ID, []string{store.BatchFailed}, func(bb *store.Batch) error { bb.FailedAt = &old; return nil }, nil, nil)
	s.settleSweep(ctx)
	if len(settleKeys(f)) != 0 {
		t.Fatal("a hard decline was retried")
	}
}

// Paid another way (here a settle the customer started): the store ends
// the schedule, so no retry charges on top.
func TestWebGroupPaidElsewhereEndsSchedule(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_1", "decline:insufficient_funds"})
	b := offBatch(t, s, uid, "proj_1", 900)
	s.chargeBatch(ctx, b)
	f.mu.Lock()
	f.outcome["pm_1"] = ""
	f.mu.Unlock()
	if res, err := s.collectOutstanding(ctx, uid, settleDelete, payContext{}); err != nil || !res.Paid {
		t.Fatalf("%v %+v", err, res)
	}
	got, _ := s.Store.GetBatch(ctx, b.ID)
	if got.State != store.BatchPaid || got.Retry.State != store.RetryPaid || got.Retry.NextAttemptAt != nil {
		t.Fatalf("%s %+v", got.State, got.Retry)
	}
}

// No saved method on a web group: final, with the pay link and E2.
func TestWebGroupNoMethodGetsPayLink(t *testing.T) {
	s, _ := offService(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{Email: uid + "@example.com"})
	b := offBatch(t, s, uid, "proj_1", 700)
	got, err := s.chargeBatch(ctx, b)
	if err != nil || got.State != store.BatchFailed || got.Retry == nil || got.Retry.State != store.RetryFinal || got.Retry.PayRequestID == "" ||
		got.Retry.LastErrorMessage != "There's no payment method saved." || !mailed(s, "E2_"+b.ID) {
		t.Fatalf("%v %s %+v", err, got.State, got.Retry)
	}
}

// D1 regression: an app group keeps its shipped path: no schedule, no
// pay link, the old E2, one 24 h retry (soft_retry) and no "retry" in
// Billing.
func TestAppGroupRetryUnchanged(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_1", "decline:insufficient_funds"})
	b := offBatch(t, s, uid, "", 1000)
	got, _ := s.chargeBatch(ctx, b)
	if got.State != store.BatchFailed || got.Retry != nil || !got.SoftDecline || got.SoftRetried || !mailed(s, "E2_"+b.ID) {
		t.Fatalf("%+v", got)
	}
	if prs, _ := s.Store.ListPayRequests(ctx, uid, "", 10); len(prs) != 0 {
		t.Fatalf("pay links on an app group: %d", len(prs))
	}
	cust, _ := s.Store.GetCustomer(ctx, uid)
	status, _ := s.billingStatus(ctx, &AuthedUser{UID: uid}, cust)
	unpaid, _ := status["unpaid"].([]map[string]any)
	if _, ok := status["retry"]; ok || len(unpaid) != 1 {
		t.Fatalf("billing %v", status)
	}
	if _, ok := unpaid[0]["retry"]; ok {
		t.Fatal("retry on an app group's entry")
	}
	old := time.Now().Add(-25 * time.Hour)
	s.Store.TransitionBatch(ctx, b.ID, []string{store.BatchFailed}, func(bb *store.Batch) error { bb.FailedAt = &old; return nil }, nil, nil)
	s.settleSweep(ctx)
	s.settleSweep(ctx)
	got, _ = s.Store.GetBatch(ctx, b.ID)
	keys := settleKeys(f)
	if !got.SoftRetried || got.Retry != nil || len(keys) != 1 {
		t.Fatalf("%+v settle charges %v", got, keys)
	}
	for _, c := range f.creates {
		if c["payment_method_configuration"] != "" {
			t.Fatalf("app charge under a PMC: %v", c)
		}
	}
}
