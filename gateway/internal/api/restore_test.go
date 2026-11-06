package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// restoreStripe adds the restore's reads to fakeStripe: a subscription's
// paid invoices and the customer search on firebase_uid. Every call that
// isn't a read is recorded: a restore makes none.
type restoreStripe struct {
	*fakeStripe
	mu       sync.Mutex
	invoices map[string][]map[string]any // subscription → paid invoices, newest first
	byUID    map[string][]string         // uid → customer ids
	writes   []string
}

var searchUID = regexp.MustCompile(`metadata\['firebase_uid'\]:'([^']+)'`)

func (f *restoreStripe) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	write := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	f.mu.Lock()
	if r.Method != http.MethodGet {
		f.writes = append(f.writes, r.Method+" "+r.URL.Path)
	}
	switch {
	case r.URL.Path == "/v1/invoices" && r.Method == http.MethodGet && r.URL.Query().Get("subscription") != "":
		data := f.invoices[r.URL.Query().Get("subscription")]
		f.mu.Unlock()
		if data == nil {
			data = []map[string]any{}
		}
		write(map[string]any{"data": data, "has_more": false})
		return
	case r.URL.Path == "/v1/customers/search":
		ids := []any{}
		if m := searchUID.FindStringSubmatch(r.URL.Query().Get("query")); m != nil && strings.Contains(r.URL.Query().Get("query"), "metadata['env']:'test'") {
			for _, id := range f.byUID[m[1]] {
				ids = append(ids, map[string]any{"id": id})
			}
		}
		f.mu.Unlock()
		write(map[string]any{"data": ids, "has_more": false})
		return
	}
	f.mu.Unlock()
	f.fakeStripe.ServeHTTP(w, r)
}

func restoreService(t *testing.T) (*Service, *restoreStripe, *fakeRC) {
	t.Helper()
	s, fake, rc, _ := promoService(t)
	rs := &restoreStripe{fakeStripe: fake, invoices: map[string][]map[string]any{}, byUID: map[string][]string{}}
	srv := httptest.NewServer(rs)
	t.Cleanup(srv.Close)
	stripex.UseTestServer(srv.URL)
	return s, rs, rc
}

// testIP is a valid address of its own (the per-address limit is
// process-wide).
func testIP() string { return fmt.Sprintf("198.51.%d.%d", rand.IntN(254)+1, rand.IntN(254)+1) }

func callRestore(t *testing.T, s *Service, uid string) (int, map[string]any) {
	t.Helper()
	ip := testIP()
	return callJSON(t, func(w http.ResponseWriter, r *http.Request) {
		r.Header.Set("X-Forwarded-For", ip)
		s.HandleRestore(w, r, &AuthedUser{UID: uid})
	}, "POST", "")
}

func repairedOf(out map[string]any) []string {
	var got []string
	for _, v := range out["repaired"].([]any) {
		got = append(got, v.(string))
	}
	return got
}

// planSubscription puts an active monthly subscription of ours for uid on
// customer cus in the fake, started a day ago.
func planSubscription(rs *restoreStripe, uid, cus, sub, tier string) (start, end time.Time) {
	start = time.Now().Add(-24 * time.Hour).Truncate(time.Second).UTC()
	end = start.AddDate(0, 1, 0)
	rs.fakeStripe.mu.Lock()
	rs.fakeStripe.subs[sub] = map[string]any{"id": sub, "status": "active", "customer": cus,
		"metadata":             map[string]string{"product": "svs-web", "env": "test", "user_id": uid, "plan": tier},
		"current_period_start": start.Unix(), "current_period_end": end.Unix()}
	rs.fakeStripe.mu.Unlock()
	return start, end
}

func restoreRows(t *testing.T, s *Service, uid string) []*store.Restore {
	t.Helper()
	rows, err := s.Store.ListUserRestores(context.Background(), uid, 20)
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

// Nothing anywhere: "We didn't find any purchases", nothing repaired, one
// audit row, no Stripe write.
func TestRestoreNothingFound(t *testing.T) {
	s, rs, _ := restoreService(t)
	uid := "u" + store.NewID()
	code, out := callRestore(t, s, uid)
	if code != 200 || out["restored"] != false || out["message"] != "We didn't find any purchases" || len(repairedOf(out)) != 0 || out["plan"] != nil {
		t.Fatalf("%d %v", code, out)
	}
	rows := restoreRows(t, s, uid)
	if len(rows) != 1 || rows[0].Kind != "resync" || rows[0].Restored || rows[0].Customers != 0 {
		t.Fatalf("audit %+v", rows)
	}
	if len(rs.writes) != 0 {
		t.Fatalf("stripe writes %v", rs.writes)
	}
}

// A missed customer.subscription.created: the plan is mirrored again,
// "Your purchases are restored"; a plan cancelled in Stripe but still
// shown as renewing is set right the same way.
func TestRestoreMissedWebhook(t *testing.T) {
	s, rs, _ := restoreService(t)
	ctx := context.Background()
	uid, sub := "u"+store.NewID(), "sub_"+store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_r1"})
	planSubscription(rs, uid, "cus_r1", sub, "business")
	code, out := callRestore(t, s, uid)
	if code != 200 || out["restored"] != true || out["message"] != "Your purchases are restored" || !slices.Contains(repairedOf(out), "plan") {
		t.Fatalf("%d %v", code, out)
	}
	c, _ := s.Store.GetCustomer(ctx, uid)
	if c.Plan == nil || c.Plan.SubscriptionID != sub || c.Plan.Tier != "business" || !c.Plan.Active(time.Now()) {
		t.Fatalf("plan %+v", c.Plan)
	}
	if p, _ := out["plan"].(map[string]any); p["plan"] != "business" {
		t.Fatalf("plan json %v", out["plan"])
	}
	// cancelled in Stripe, the update missed
	rs.fakeStripe.mu.Lock()
	rs.fakeStripe.subs[sub]["cancel_at_period_end"] = true
	rs.fakeStripe.mu.Unlock()
	_, out = callRestore(t, s, uid)
	c, _ = s.Store.GetCustomer(ctx, uid)
	if !c.Plan.CancelAtPeriodEnd || !slices.Contains(repairedOf(out), "plan") || out["restored"] != true {
		t.Fatalf("cancel %+v %v", c.Plan, out)
	}
	// in step: restored, nothing repaired
	_, out = callRestore(t, s, uid)
	if out["restored"] != true || len(repairedOf(out)) != 0 {
		t.Fatalf("in step %v", out)
	}
	if len(rs.writes) != 0 {
		t.Fatalf("stripe writes %v", rs.writes)
	}
}

// A missed invoice.paid: the period's credit and the app's entitlements
// come once; a second restore grants nothing again.
func TestRestoreMissedInvoiceOnce(t *testing.T) {
	s, rs, rc := restoreService(t)
	ctx := context.Background()
	uid, sub, inv := "u"+store.NewID(), "sub_"+store.NewID(), "in_"+store.NewID()
	start, end := planSubscription(rs, uid, "cus_r2", sub, "business")
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_r2", Plan: &store.Plan{Tier: "business", SubscriptionID: sub,
		Status: "active", CurrentPeriodStart: &start, CurrentPeriodEnd: &end}})
	rs.invoices[sub] = []map[string]any{{"id": inv, "object": "invoice", "status": "paid", "created": start.Unix(),
		"billing_reason": "subscription_create", "subscription": sub,
		"lines": map[string]any{"data": []any{map[string]any{"amount": 29900}}}}}
	def, _ := pricing.DefaultsFor("test").Plan("business")

	code, out := callRestore(t, s, uid)
	got := repairedOf(out)
	if code != 200 || out["restored"] != true || !slices.Contains(got, "monthly_usage") || !slices.Contains(got, "app_access") || !slices.Contains(got, "plan") {
		t.Fatalf("%d %v", code, out)
	}
	b, _ := s.Store.GetBalance(ctx, uid)
	c, _ := s.Store.GetCustomer(ctx, uid)
	if b.PlanCreditCents() != def.CreditCents || c.Plan.LastInvoiceID != inv || c.Plan.RCGrantInvoice != inv {
		t.Fatalf("credit %d plan %+v", b.PlanCreditCents(), c.Plan)
	}
	if len(rc.ends(uid, "business")) != 1 || len(rc.ends(uid, "pro")) != 1 {
		t.Fatalf("grants %v", rc.grants[uid])
	}
	posts := rc.posts

	code, out = callRestore(t, s, uid)
	if code != 200 || out["restored"] != true || len(repairedOf(out)) != 0 {
		t.Fatalf("again %d %v", code, out)
	}
	b, _ = s.Store.GetBalance(ctx, uid)
	if b.PlanCreditCents() != def.CreditCents || rc.posts != posts {
		t.Fatalf("granted twice: credit %d posts %d→%d", b.PlanCreditCents(), posts, rc.posts)
	}
	rows := restoreRows(t, s, uid)
	if len(rows) != 2 {
		t.Fatalf("audit %d", len(rows))
	}
	applied := 0
	for _, r := range rows {
		applied += len(r.Invoices)
	}
	if applied != 1 {
		t.Fatalf("invoice applied %d times", applied)
	}
	if len(rs.writes) != 0 {
		t.Fatalf("stripe writes %v", rs.writes)
	}
}

// The plan's entitlement missing in RevenueCat (a failed grant): granted
// again until the period end + the grace.
func TestRestoreMissingEntitlement(t *testing.T) {
	s, rs, rc := restoreService(t)
	ctx := context.Background()
	uid, sub := "u"+store.NewID(), "sub_"+store.NewID()
	start, end := planSubscription(rs, uid, "cus_r3", sub, "studio")
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_r3", Plan: &store.Plan{Tier: "studio", SubscriptionID: sub,
		Status: "active", CurrentPeriodStart: &start, CurrentPeriodEnd: &end, LastInvoiceID: "in_x", RCGrantInvoice: "in_x",
		RCGrantError: "revenuecat 503"}})
	code, out := callRestore(t, s, uid)
	if code != 200 || out["restored"] != true || !slices.Contains(repairedOf(out), "app_access") {
		t.Fatalf("%d %v", code, out)
	}
	if ends := rc.ends(uid, "studio"); len(ends) != 1 || !ends[0].Equal(end.Add(planEntitlementGrace)) {
		t.Fatalf("studio %v", ends)
	}
	if len(rc.ends(uid, "pro")) != 1 {
		t.Fatal("pro with it")
	}
	if out["pro"] != true {
		t.Fatalf("pro %v", out["pro"])
	}
}

// Another Stripe customer made for the same uid (an old mapping): its
// subscription is found and mirrored; the owner hears of the customer.
func TestRestoreOtherCustomer(t *testing.T) {
	s, rs, _ := restoreService(t)
	ctx := context.Background()
	uid, sub := "u"+store.NewID(), "sub_"+store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_now"})
	planSubscription(rs, uid, "cus_old", sub, "business")
	rs.byUID[uid] = []string{"cus_now", "cus_old"}
	_, out := callRestore(t, s, uid)
	if out["restored"] != true || !slices.Contains(repairedOf(out), "plan") {
		t.Fatalf("%v", out)
	}
	rows := restoreRows(t, s, uid)
	if len(rows) != 1 || rows[0].Customers != 2 || rows[0].OtherCustomers != 1 || rows[0].Subscriptions != 1 {
		t.Fatalf("audit %+v", rows[0])
	}
}

// A deleted account (or one waiting for its closure case) is refused,
// and nothing is looked at or written.
func TestRestoreDeletedRefused(t *testing.T) {
	s, rs, _ := restoreService(t)
	ctx := context.Background()
	uid, sub := "u"+store.NewID(), "sub_"+store.NewID()
	now := time.Now().UTC()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_d", AccountDeleted: true, DeletedAt: &now})
	planSubscription(rs, uid, "cus_d", sub, "business")
	code, out := callRestore(t, s, uid)
	if code != 403 || out["error"] != "account_deleted" {
		t.Fatalf("%d %v", code, out)
	}
	c, _ := s.Store.GetCustomer(ctx, uid)
	if c.Plan != nil || len(restoreRows(t, s, uid)) != 0 {
		t.Fatalf("touched %+v", c.Plan)
	}
	uid2 := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid2, &store.Customer{StripeCustomerID: "cus_p", DeletionPending: true})
	if code, out := callRestore(t, s, uid2); code != 403 {
		t.Fatalf("pending %d %v", code, out)
	}
	if len(rs.writes) != 0 {
		t.Fatalf("stripe writes %v", rs.writes)
	}
}

// Five an hour per account; the sixth waits.
func TestRestoreRateLimited(t *testing.T) {
	s, _, _ := restoreService(t)
	uid := "u" + store.NewID()
	for i := 0; i < restorePerAccountHour; i++ {
		if code, out := callRestore(t, s, uid); code != 200 {
			t.Fatalf("try %d: %d %v", i+1, code, out)
		}
	}
	code, out := callRestore(t, s, uid)
	if d, _ := out["details"].(map[string]any); code != 429 || out["error"] != "rate_limited" || d["retry_after_s"] == nil {
		t.Fatalf("%d %v", code, out)
	}
	if len(restoreRows(t, s, uid)) != restorePerAccountHour {
		t.Fatal("a refused try writes no row")
	}
	// one address, many accounts: 20 an hour
	ip := testIP()
	codes := map[int]int{}
	for i := 0; i < restorePerIPHour+1; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/", nil)
		req.Header.Set("X-Forwarded-For", ip)
		s.HandleRestore(rec, req, &AuthedUser{UID: "u" + store.NewID()})
		codes[rec.Code]++
	}
	if codes[200] != restorePerIPHour || codes[429] != 1 {
		t.Fatalf("by address %v", codes)
	}
}

// Under a restore nothing collects: no debt paid from the balance, no
// collectOutstanding.
func TestRestoreNeverSettles(t *testing.T) {
	s, _, _ := restoreService(t)
	ctx := withoutSettle(context.Background())
	if s.payDebtsFromBalance(ctx, "u"+store.NewID()) {
		t.Fatal("paid")
	}
	if _, err := s.collectOutstanding(ctx, "u"+store.NewID(), settleBalance, payContext{}); err != errSettleHeld {
		t.Fatalf("collect: %v", err)
	}
	if settleHeld(context.Background()) {
		t.Fatal("held without the mark")
	}
}
