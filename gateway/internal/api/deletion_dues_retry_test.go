package api

import (
	"context"
	"fmt"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func scheduleDue(t *testing.T, s *Service, uid string) time.Time {
	t.Helper()
	now := time.Now().UTC()
	req := now.Add(-49 * time.Hour)
	if _, _, err := s.Store.ScheduleAccountDeletion(context.Background(), &store.AccountDeletion{UID: uid, RequestedAt: req,
		DeleteAfter: now.Add(-time.Hour), Email: uid + "@example.com", Source: "web"}); err != nil {
		t.Fatal(err)
	}
	return req
}

// sweepAt makes the row (and, when retryDue, its dues retry) due and runs
// the sweep's processing for it.
func sweepAt(t *testing.T, s *Service, uid string, retryDue bool) (string, error) {
	t.Helper()
	past := time.Now().UTC().Add(-time.Second)
	s.Store.UpdateAccountDeletion(context.Background(), uid, func(d *store.AccountDeletion) error {
		d.NextAttemptAt = &past
		if retryDue && d.DuesRetry != nil && d.DuesRetry.NextAttemptAt != nil {
			d.DuesRetry.NextAttemptAt = &past
		}
		return nil
	})
	return s.processScheduledDeletion(context.Background(), uid, "sweep", false)
}

// #2 with D2: dues the 48-hour sweep can't collect are charged again only
// at +24 h and +72 h (each a new settle, a new key), never on the 6-hourly
// checks; then the deletion waits for the pay link. DL3 mails each step;
// the deletion state shows the retry. Paid another way, the next check
// deletes without charging.
func TestDeletionDuesRetryWindow(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_1", "decline:insufficient_funds"})
	owedConversion(t, s, uid, 1500)
	req := scheduleDue(t, s, uid)

	if _, err := s.processScheduledDeletion(ctx, uid, "sweep", false); err == nil {
		t.Fatal("deleted with dues unpaid")
	}
	d, _ := s.Store.GetAccountDeletion(ctx, uid)
	r := d.DuesRetry
	if len(f.creates) != 1 || r == nil || r.State != store.RetryPending || r.Attempts != 1 || r.AmountCents != 1500 ||
		d.State != store.DeletionStatePending || d.NextAttemptAt.Sub(time.Now()) > 6*time.Hour+time.Minute {
		t.Fatalf("first failure: creates %d row %+v retry %+v", len(f.creates), d, r)
	}
	if !mailed(s, fmt.Sprintf("DL3_%s_%d_1", uid, req.Unix())) {
		t.Fatal("no DL3")
	}
	st := s.deletionState(ctx, uid)["dues_retry"].(map[string]any)
	if st["state"] != "pending" || st["pay_url"] == nil || st["last_error_message"] == "" {
		t.Fatalf("deletion state %v", st)
	}
	// the 6-hourly checks between the retry times charge nothing
	for i := 0; i < 3; i++ {
		sweepAt(t, s, uid, false)
	}
	if len(f.creates) != 1 {
		t.Fatalf("charged between retries: %d", len(f.creates))
	}
	sweepAt(t, s, uid, true) // +24 h
	sweepAt(t, s, uid, true) // +72 h
	d, _ = s.Store.GetAccountDeletion(ctx, uid)
	if len(f.creates) != 3 || d.DuesRetry.State != store.RetryFinal || d.DuesRetry.Attempts != 3 {
		t.Fatalf("after the retries: creates %d retry %+v", len(f.creates), d.DuesRetry)
	}
	keys := map[string]bool{}
	for _, c := range f.creates {
		keys[c["key"]] = true
	}
	if len(keys) != 3 {
		t.Fatalf("a key was reused: %v", keys)
	}
	if !mailed(s, fmt.Sprintf("DL3_%s_%d_3", uid, req.Unix())) {
		t.Fatal("no final DL3")
	}
	for i := 0; i < 3; i++ {
		sweepAt(t, s, uid, true)
	}
	if len(f.creates) != 3 {
		t.Fatalf("charged after the last try: %d", len(f.creates))
	}
	// paid another way (the pay link's sheet): the next check deletes
	f.outcome["pm_1"] = ""
	if res, err := s.collectOutstanding(ctx, uid, settleDelete, payContext{}); err != nil || !res.Paid {
		t.Fatalf("%v %+v", err, res)
	}
	out, err := sweepAt(t, s, uid, false)
	c, _ := s.Store.GetCustomer(ctx, uid)
	if err != nil || out != store.DeletionOutcomeDeleted || !c.AccountDeleted || len(f.creates) != 4 {
		t.Fatalf("after paying: %q %v creates %d", out, err, len(f.creates))
	}
}

// A bank check on the dues: no retry, the pay link at once ("Confirm and
// pay").
func TestDeletionDuesBankCheckNoRetry(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_1", "auth"})
	owedConversion(t, s, uid, 1500)
	scheduleDue(t, s, uid)
	s.processScheduledDeletion(ctx, uid, "sweep", false)
	d, _ := s.Store.GetAccountDeletion(ctx, uid)
	if d.DuesRetry == nil || d.DuesRetry.State != store.RetryFinal || d.DuesRetry.Reason != retryAuth {
		t.Fatalf("%+v", d.DuesRetry)
	}
	sweepAt(t, s, uid, true)
	if len(f.creates) != 1 {
		t.Fatalf("retried a bank check: %d", len(f.creates))
	}
}
