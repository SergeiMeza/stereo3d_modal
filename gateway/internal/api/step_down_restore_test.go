package api

import (
	"context"
	"net/http"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// A step-up releases a waiting step-down; when its payment fails, the
// step-down is scheduled again (same target, a new schedule) and the
// account shows it. Before the fix it was lost and the plan renewed at the
// higher price.
func TestStepUpFailureRestoresStepDown(t *testing.T) {
	f := newPlanFixture(t, "business", "business", 29900, 5, 30)
	ctx := context.Background()
	if code, out := f.post(f.s.HandlePlanChange, `{"to":"pro_monthly","confirm":true}`); code != 200 {
		t.Fatalf("step-down %d %v", code, out)
	}
	c, _ := f.s.Store.GetCustomer(ctx, f.uid)
	if c.Plan.ScheduleID != "sub_sched_1" || c.Plan.ScheduledTo != "pro_monthly" || c.Plan.ScheduledAt == nil {
		t.Fatalf("scheduled %+v", c.Plan)
	}
	at := *c.Plan.ScheduledAt

	f.fake.failNextChange = true
	if code, out := f.post(f.s.HandlePlanChange, `{"to":"studio","confirm":true}`); code != 402 || out["error"] != "payment_failed" {
		t.Fatalf("failed step-up %d %v", code, out)
	}
	if f.fake.schedules["sub_sched_1"]["released"] != "true" {
		t.Fatal("the old schedule wasn't released")
	}
	re := f.fake.schedules["sub_sched_2"]
	if re == nil || re["released"] == "true" || re["phases[1][metadata][plan_id]"] != "pro_monthly" ||
		re["phases[1][metadata][change_kind]"] != "step_down" || re["phases[1][metadata][changed_from]"] != "business" ||
		re["phases[0][end_date]"] != "2000" || re["end_behavior"] != "release" {
		t.Fatalf("step-down not scheduled again: %v", re)
	}
	c, _ = f.s.Store.GetCustomer(ctx, f.uid)
	if c.Plan.Tier != "business" || c.Plan.ScheduleID != "sub_sched_2" || c.Plan.ScheduledTo != "pro_monthly" ||
		c.Plan.ScheduledAt == nil || !c.Plan.ScheduledAt.Equal(at) {
		t.Fatalf("account after the failed step-up %+v", c.Plan)
	}
	// "Keep Business" still takes the restored one back.
	if code, kept := callJSON(t, func(w http.ResponseWriter, r *http.Request) {
		f.s.HandleCancelScheduledChange(w, r, &AuthedUser{UID: f.uid})
	}, "DELETE", ""); code != 200 || kept["scheduled_change"] != nil || f.fake.schedules["sub_sched_2"]["released"] != "true" {
		t.Fatalf("keep %d %v", code, kept)
	}
}

// A step-up that succeeds leaves the step-down released and nothing
// scheduled; one with no step-down waiting creates no schedule.
func TestStepUpSuccessKeepsStepDownReleased(t *testing.T) {
	f := newPlanFixture(t, "business", "business", 29900, 5, 30)
	ctx := context.Background()
	if code, _ := f.post(f.s.HandlePlanChange, `{"to":"pro_monthly","confirm":true}`); code != 200 {
		t.Fatal("step-down")
	}
	if code, out := f.post(f.s.HandlePlanChange, `{"to":"studio","confirm":true}`); code != 200 {
		t.Fatalf("step-up %d %v", code, out)
	}
	if len(f.fake.schedules) != 1 || f.fake.schedules["sub_sched_1"]["released"] != "true" {
		t.Fatalf("schedules %v", f.fake.schedules)
	}
	if c, _ := f.s.Store.GetCustomer(ctx, f.uid); c.Plan.ScheduleID != "" || c.Plan.ScheduledTo != "" {
		t.Fatalf("plan %+v", c.Plan)
	}

	g := newPlanFixture(t, "pro_monthly", "pro", 499, 5, 30)
	g.fake.failNextChange = true
	if code, _ := g.post(g.s.HandlePlanChange, `{"to":"pro_yearly","confirm":true}`); code != 402 {
		t.Fatal("failed step-up")
	}
	if len(g.fake.schedules) != 0 {
		t.Fatalf("a schedule appeared: %v", g.fake.schedules)
	}
}

// When the step-down can't be made again (its target is gone), the
// account stops showing a change Stripe no longer has.
func TestStepDownRestoreFailureClearsIt(t *testing.T) {
	f := newPlanFixture(t, "business", "business", 29900, 5, 30)
	ctx := context.Background()
	if code, _ := f.post(f.s.HandlePlanChange, `{"to":"pro_monthly","confirm":true}`); code != 200 {
		t.Fatal("step-down")
	}
	f.s.Store.UpdateCustomer(ctx, f.uid, func(c *store.Customer) error {
		c.Plan.ScheduledTo = "retired_plan"
		return nil
	})
	f.fake.failNextChange = true
	if code, _ := f.post(f.s.HandlePlanChange, `{"to":"studio","confirm":true}`); code != 402 {
		t.Fatal("failed step-up")
	}
	if len(f.fake.schedules) != 1 {
		t.Fatalf("schedules %v", f.fake.schedules)
	}
	if c, _ := f.s.Store.GetCustomer(ctx, f.uid); c.Plan.ScheduleID != "" || c.Plan.ScheduledTo != "" || c.Plan.ScheduledAt != nil {
		t.Fatalf("plan %+v", c.Plan)
	}
}
