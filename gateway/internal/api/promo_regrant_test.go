package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/notify"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/revenuecat"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// fakeRC keeps promotional grants per uid the way RevenueCat reports
// them: one subscriptions entry per product (the latest expiry wins).
type fakeRC struct {
	mu        sync.Mutex
	grants    map[string][]store.PromoGrant
	posts     int
	failGrant bool
}

func (f *fakeRC) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	path := strings.TrimPrefix(r.URL.Path, "/v1/subscribers/")
	parts := strings.Split(path, "/")
	uid := parts[0]
	if r.Method == http.MethodGet {
		subs, ents := map[string]any{}, map[string]any{}
		latest := map[string]store.PromoGrant{}
		for _, g := range f.grants[uid] {
			if cur, ok := latest[g.Product]; !ok || later(g.ExpiresAt, cur.ExpiresAt) {
				latest[g.Product] = g
			}
		}
		best := map[string]store.PromoGrant{}
		for p, g := range latest {
			subs[p] = map[string]any{"store": "promotional", "expires_date": g.ExpiresAt, "purchase_date": time.Now().UTC()}
			if cur, ok := best[g.Entitlement]; !ok || later(g.ExpiresAt, cur.ExpiresAt) {
				best[g.Entitlement] = g
			}
		}
		for e, g := range best {
			ents[e] = map[string]any{"expires_date": g.ExpiresAt, "product_identifier": g.Product}
		}
		json.NewEncoder(w).Encode(map[string]any{"subscriber": map[string]any{"entitlements": ents, "subscriptions": subs}})
		return
	}
	f.posts++
	ent, action := parts[2], parts[3]
	switch action {
	case "revoke_promotionals":
		kept := f.grants[uid][:0]
		for _, g := range f.grants[uid] {
			if g.Entitlement != ent {
				kept = append(kept, g)
			}
		}
		f.grants[uid] = kept
	case "promotional":
		if f.failGrant {
			w.WriteHeader(http.StatusForbidden)
			io.WriteString(w, `{"message":"nope"}`)
			return
		}
		var body struct {
			End      int64  `json:"end_time_ms"`
			Duration string `json:"duration"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		g := store.PromoGrant{Entitlement: ent, Product: "rc_promo_" + ent + "_custom"}
		if body.Duration == "lifetime" {
			g.Product = "rc_promo_" + ent + "_lifetime"
		} else {
			t := time.UnixMilli(body.End).UTC()
			g.ExpiresAt = &t
		}
		f.grants[uid] = append(f.grants[uid], g)
	}
	w.Write([]byte(`{}`))
}

func later(a, b *time.Time) bool {
	if a == nil {
		return b != nil
	}
	return b != nil && a.After(*b)
}

// active: uid's grants of ent RevenueCat would show, by end.
func (f *fakeRC) ends(uid, ent string) []time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []time.Time
	for _, g := range f.grants[uid] {
		if g.Entitlement == ent && g.ExpiresAt != nil && g.ExpiresAt.After(time.Now()) {
			out = append(out, *g.ExpiresAt)
		}
	}
	return out
}

func (f *fakeRC) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.posts
}

type slackSink struct {
	mu   sync.Mutex
	msgs []string
}

func (k *slackSink) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var b map[string]string
	json.NewDecoder(r.Body).Decode(&b)
	k.mu.Lock()
	k.msgs = append(k.msgs, b["text"])
	k.mu.Unlock()
}

func (k *slackSink) has(kind string) bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	for _, m := range k.msgs {
		if strings.Contains(m, "] "+kind) {
			return true
		}
	}
	return false
}

func promoService(t *testing.T) (*Service, *fakeStripe, *fakeRC, *slackSink) {
	s, fake := e0Service(t)
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	rc := &fakeRC{grants: map[string][]store.PromoGrant{}}
	rcSrv := httptest.NewServer(rc)
	t.Cleanup(rcSrv.Close)
	s.RevenueCat = revenuecat.New("sk_test_fake").WithBase(rcSrv.URL, time.Now)
	sink := &slackSink{}
	slackSrv := httptest.NewServer(sink)
	t.Cleanup(slackSrv.Close)
	s.Slack = notify.NewSlack(slackSrv.URL, "test")
	return s, fake, rc, sink
}

func ms(t time.Time) time.Time { return time.UnixMilli(t.UnixMilli()).UTC() }

// A business plan with its grants in RevenueCat (ours: business and pro
// until the period end + 3 days), plus an app campaign's Pro (30 days
// left), the free two weeks (trial, 5 days left) and an expired grant.
func promoAccount(t *testing.T, s *Service, rc *fakeRC) (uid string, ours, campaign, trial time.Time) {
	ctx := context.Background()
	uid = "u" + store.NewID()
	ours = ms(time.Now().Add(20 * 24 * time.Hour))
	campaign = ms(time.Now().Add(30 * 24 * time.Hour))
	trial = ms(time.Now().Add(5 * 24 * time.Hour))
	expired := ms(time.Now().Add(-2 * 24 * time.Hour))
	end := ours.Add(-planEntitlementGrace)
	if err := s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1", Plan: &store.Plan{Tier: "business", SubscriptionID: "sub_" + uid,
		Status: "active", CurrentPeriodEnd: &end, RCGrantInvoice: "in_" + uid, RCGrantedUntil: &ours}}); err != nil {
		t.Fatal(err)
	}
	rc.mu.Lock()
	rc.grants[uid] = []store.PromoGrant{
		{Entitlement: "business", Product: "rc_promo_business_custom", ExpiresAt: &ours},
		{Entitlement: "pro", Product: "rc_promo_pro_custom", ExpiresAt: &ours},
		{Entitlement: "pro", Product: "rc_promo_pro_monthly", ExpiresAt: &campaign},
		{Entitlement: "trial", Product: "rc_promo_trial_weekly", ExpiresAt: &trial},
		{Entitlement: "pro", Product: "rc_promo_pro_weekly", ExpiresAt: &expired},
	}
	rc.mu.Unlock()
	return
}

func sameTimes(got []time.Time, want ...time.Time) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if !got[i].Equal(want[i]) {
			return false
		}
	}
	return true
}

// Refund: the refunded purchase's business and pro go; the app
// campaign's Pro comes back to its original end, the expired one
// doesn't, the trial entitlement is never touched; a second delivery
// does nothing.
func TestPromoRefundRegrant(t *testing.T) {
	s, _, rc, _ := promoService(t)
	ctx := context.Background()
	uid, _, campaign, trial := promoAccount(t, s, rc)
	s.revokeRefundedPlan(ctx, uid, "in_r1")
	if got := rc.ends(uid, "pro"); !sameTimes(got, campaign) {
		t.Fatalf("pro after the refund %v, want only the campaign's %v", got, campaign)
	}
	if got := rc.ends(uid, "business"); len(got) != 0 {
		t.Fatalf("business %v", got)
	}
	if got := rc.ends(uid, "trial"); !sameTimes(got, trial) {
		t.Fatalf("trial %v", got)
	}
	rec, err := s.Store.GetPromoRegrant(ctx, "refund:in_r1")
	if err != nil || rec.Status != "done" || len(rec.Snapshot) != 5 || len(rec.Regranted) != 1 || rec.Uncertain {
		t.Fatalf("record %v %+v", err, rec)
	}
	cust, _ := s.Store.GetCustomer(ctx, uid)
	if cust.Plan.RCRevokedAt == nil {
		t.Fatal("the plan's revoke recorded")
	}
	n := rc.count()
	s.revokeRefundedPlan(ctx, uid, "in_r1")
	if rc.count() != n {
		t.Fatal("a second delivery called RevenueCat")
	}
}

// Snapshot exclusion: when the only promotional entry of an entitlement
// is ours, nothing is given back and the record is marked uncertain.
func TestPromoRefundOnlyOurs(t *testing.T) {
	s, _, rc, _ := promoService(t)
	ctx := context.Background()
	uid, ours, _, _ := promoAccount(t, s, rc)
	rc.mu.Lock()
	rc.grants[uid] = []store.PromoGrant{{Entitlement: "business", Product: "rc_promo_business_custom", ExpiresAt: &ours},
		{Entitlement: "pro", Product: "rc_promo_pro_custom", ExpiresAt: &ours}}
	rc.mu.Unlock()
	s.revokeRefundedPlan(ctx, uid, "in_r2")
	rec, _ := s.Store.GetPromoRegrant(ctx, "refund:in_r2")
	if rec == nil || rec.Status != "done" || len(rec.Regranted) != 0 || !rec.Uncertain || len(rc.ends(uid, "pro")) != 0 {
		t.Fatalf("record %+v pro %v", rec, rc.ends(uid, "pro"))
	}
}

// A re-grant RevenueCat refuses alerts Slack; the nightly job gives it
// back once RevenueCat takes it.
func TestPromoRegrantFailureRetries(t *testing.T) {
	s, _, rc, sink := promoService(t)
	ctx := context.Background()
	uid, _, campaign, _ := promoAccount(t, s, rc)
	rc.failGrant = true
	s.revokeRefundedPlan(ctx, uid, "in_r3")
	rec, _ := s.Store.GetPromoRegrant(ctx, "refund:in_r3")
	if rec == nil || rec.Status != "regrant_failed" || len(rec.ToGrant) != 1 || !sink.has("promo_regrant_failed") {
		t.Fatalf("record %+v slack %v", rec, sink.msgs)
	}
	rc.failGrant = false
	defer func(d time.Duration) { promoRetryAfter = d }(promoRetryAfter)
	promoRetryAfter = 0
	rep := &M3Report{Counts: map[string]int{}}
	s.m3PromoRegrants(ctx, rep, false)
	rec, _ = s.Store.GetPromoRegrant(ctx, "refund:in_r3")
	if rec.Status != "done" || rep.Counts["promo_regrant_retry"] != 1 || !sameTimes(rc.ends(uid, "pro"), campaign) {
		t.Fatalf("after the retry %+v %v", rec, rc.ends(uid, "pro"))
	}
}

// planDisputeFixture: the account's plan invoice paid by pi (for the
// dispute webhooks).
func planDisputeFixture(fake *fakeStripe, uid string) (pi string) {
	pi, inv, sub := "pi_"+uid, "in_"+uid, "sub_"+uid
	fake.invPays[pi] = inv
	fake.invs[inv] = map[string]any{"id": inv, "amount_paid": 29900, "parent": map[string]any{"subscription_details": map[string]any{"subscription": sub}}}
	fake.pis[pi] = map[string]any{"status": "succeeded", "amount_received": 29900}
	fake.subs[sub] = map[string]any{"id": sub, "status": "active", "metadata": map[string]string{"product": "svs-web", "env": "test", "user_id": uid, "plan": "business"}}
	return pi
}

// Dispute opened: every promotional Pro goes (ours, the campaign's, the
// trial); won → all of it back to its original end (the expired one
// skipped); redeliveries do nothing.
func TestPromoDisputeWon(t *testing.T) {
	s, fake, rc, sink := promoService(t)
	ctx := context.Background()
	uid, ours, campaign, trial := promoAccount(t, s, rc)
	pi := planDisputeFixture(fake, uid)
	dp := "du_" + store.NewID()
	opened := []byte(`{"id":"` + dp + `","amount":29900,"status":"needs_response","payment_intent":"` + pi + `"}`)
	s.handleDisputeEvent(ctx, "charge.dispute.created", opened)
	for _, e := range []string{"pro", "business", "trial"} {
		if got := rc.ends(uid, e); len(got) != 0 {
			t.Fatalf("%s still granted: %v", e, got)
		}
	}
	rec, _ := s.Store.GetPromoRegrant(ctx, "dispute:"+dp)
	if rec == nil || rec.Status != "held" || len(rec.Snapshot) != 5 || rec.AmountCents != 29900 || !sink.has("promo_grants_removed") {
		t.Fatalf("hold %+v", rec)
	}
	cs := s.disputeCase(ctx, pi, dp) // a plan dispute gets a review case with the snapshot
	if cs == nil || cs.Type != store.CaseDispute || cs.Mode != "manual" || cs.Promo == nil || len(cs.Promo.Snapshot) != 5 || cs.Promo.Status != "held" {
		t.Fatalf("plan dispute case %+v", cs)
	}
	n := rc.count()
	s.handleDisputeEvent(ctx, "charge.dispute.created", opened)
	if rc.count() != n {
		t.Fatal("a second created delivery called RevenueCat")
	}
	closed := []byte(`{"id":"` + dp + `","amount":29900,"status":"won","payment_intent":"` + pi + `"}`)
	s.handleDisputeEvent(ctx, "charge.dispute.closed", closed)
	if !sameTimes(rc.ends(uid, "business"), ours) || !sameTimes(rc.ends(uid, "trial"), trial) || len(rc.ends(uid, "pro")) != 2 {
		t.Fatalf("after won: business %v trial %v pro %v", rc.ends(uid, "business"), rc.ends(uid, "trial"), rc.ends(uid, "pro"))
	}
	if pro := rc.ends(uid, "pro"); !(pro[0].Equal(ours) && pro[1].Equal(campaign)) && !(pro[1].Equal(ours) && pro[0].Equal(campaign)) {
		t.Fatalf("pro ends %v", pro)
	}
	rec, _ = s.Store.GetPromoRegrant(ctx, "dispute:"+dp)
	if rec.Status != "done" || rec.Outcome != "won" || len(rec.Regranted) != 4 || len(rec.Skipped) != 1 || !sink.has("promo_grants_restored") {
		t.Fatalf("after won %+v", rec)
	}
	if cust, _ := s.Store.GetCustomer(ctx, uid); cust.Plan.RCRevokedAt != nil {
		t.Fatal("M3 looks after the plan's grant again")
	}
	if cs = s.disputeCase(ctx, pi, dp); cs.Open || cs.Result != "dispute_won" || cs.Promo.Status != "done" {
		t.Fatalf("case after won %+v", cs)
	}
	n = rc.count()
	s.handleDisputeEvent(ctx, "charge.dispute.closed", closed)
	if rc.count() != n {
		t.Fatal("a second closed delivery called RevenueCat")
	}
}

// Dispute lost: everything stays removed; the owner's restore (with a
// reason, fresh sign-in) gives it back.
func TestPromoDisputeLostAndRestore(t *testing.T) {
	s, fake, rc, sink := promoService(t)
	ctx := context.Background()
	uid, _, campaign, _ := promoAccount(t, s, rc)
	pi := planDisputeFixture(fake, uid)
	dp := "du_" + store.NewID()
	s.handleDisputeEvent(ctx, "charge.dispute.created", []byte(`{"id":"`+dp+`","amount":29900,"status":"needs_response","payment_intent":"`+pi+`"}`))
	s.handleDisputeEvent(ctx, "charge.dispute.closed", []byte(`{"id":"`+dp+`","amount":29900,"status":"lost","payment_intent":"`+pi+`"}`))
	rec, _ := s.Store.GetPromoRegrant(ctx, "dispute:"+dp)
	if rec.Status != "kept_removed" || len(rc.ends(uid, "pro")) != 0 || !sink.has("promo_grants_kept_removed") {
		t.Fatalf("lost %+v pro %v", rec, rc.ends(uid, "pro"))
	}
	act := func(body string) int {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/v1/admin/accounts/"+uid+"/actions", strings.NewReader(body))
		s.HandleAdminAccountAction(w, r, &AdminUser{UID: "admin", Email: "owner@x", Method: "passkey", AssertedAt: time.Now()}, uid)
		return w.Code
	}
	if code := act(`{"action":"restore_promo_grants"}`); code != http.StatusBadRequest {
		t.Fatalf("no reason: %d", code)
	}
	if code := act(`{"action":"restore_promo_grants","note":"customer explained, bank error"}`); code != http.StatusOK {
		t.Fatalf("restore: %d", code)
	}
	rec, _ = s.Store.GetPromoRegrant(ctx, "dispute:"+dp)
	if rec.Status != "done" || rec.Outcome != "restored" || rec.RestoredBy != "owner@x" || len(rc.ends(uid, "pro")) != 2 {
		t.Fatalf("restored %+v pro %v (campaign %v)", rec, rc.ends(uid, "pro"), campaign)
	}
	if code := act(`{"action":"restore_promo_grants","note":"again"}`); code != http.StatusConflict {
		t.Fatalf("nothing left to restore: %d", code)
	}
	// The closed case got the restore as its one extra event, and stays
	// closed; nothing else writes to it.
	cs := s.disputeCase(ctx, pi, dp)
	if cs == nil || cs.Open || cs.Status != store.CaseClosed || cs.Result != "dispute_lost" {
		t.Fatalf("case %+v", cs)
	}
	evs, _ := s.Store.ListCaseEvents(ctx, cs.ID, 50)
	var restored []store.CaseEvent
	for _, e := range evs {
		if e.Kind == store.CaseEventPromoRestored {
			restored = append(restored, e)
		}
	}
	if len(restored) != 1 || restored[0].Who != "owner@x" || restored[0].Data["reason"] != "customer explained, bank error" ||
		len(restored[0].Data["regranted"].([]any)) != 4 || len(restored[0].Data["skipped"].([]any)) != 1 || restored[0].Data["type"] != "promo_restored" {
		t.Fatalf("restore event %+v", restored)
	}
	if _, err := s.Store.UpdateCase(ctx, cs.ID, "system", func(c *store.Case) error { c.Status = store.CaseOpen; return nil }); !errors.Is(err, store.ErrStateConflict) {
		t.Fatalf("closed case written: %v", err)
	}
	if ok, err := s.Store.AppendClosedCaseEvent(ctx, cs.ID, "x"+store.NewID(), store.CaseEvent{Kind: "note", Text: "hi"}); ok || !errors.Is(err, store.ErrStateConflict) {
		t.Fatalf("other event on a closed case: %v %v", ok, err)
	}
	rec, _ = s.Store.GetPromoRegrant(ctx, "dispute:"+dp)
	s.casePromoRestored(ctx, rec, "owner@x", "again", time.Now()) // the same restore again: no second event
	evs, _ = s.Store.ListCaseEvents(ctx, cs.ID, 50)
	n := 0
	for _, e := range evs {
		if e.Kind == store.CaseEventPromoRestored {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("%d restore events", n)
	}
	if got, _ := s.Store.GetCase(ctx, cs.ID); got.Status != store.CaseClosed || got.Open {
		t.Fatal("still closed")
	}
}

// Early fraud warning: everything removed and stored on the case; a
// cleared review gives it back. A second dispute still open keeps the
// first one's grants held.
func TestPromoEFWAndOverlap(t *testing.T) {
	s, _, rc, _ := promoService(t)
	ctx := context.Background()
	uid, _, campaign, _ := promoAccount(t, s, rc)
	cs, _, err := s.Store.CreateCase(ctx, &store.Case{UID: uid, Type: store.CaseEFW, Reason: ReasonEFW, Mode: "manual", Status: store.CaseOpen, DedupeKey: "efw:w1" + uid}, "system", "efw")
	if err != nil {
		t.Fatal(err)
	}
	s.promoHold(ctx, uid, "efw:w1"+uid, "early fraud warning", 29900, cs.ID)
	got, _ := s.Store.GetCase(ctx, cs.ID)
	if got.Promo == nil || got.Promo.Status != "held" || len(got.Promo.Snapshot) != 5 {
		t.Fatalf("case snapshot %+v", got.Promo)
	}
	s.promoHold(ctx, uid, "dispute:d2"+uid, "dispute", 1000, "") // its snapshot is empty: all removed already
	s.promoResolveEFWs(ctx, uid)
	if len(rc.ends(uid, "pro")) != 0 {
		t.Fatal("the open dispute keeps everything removed")
	}
	if r, _ := s.Store.GetPromoRegrant(ctx, "efw:w1"+uid); r.Status != "merged" || r.MergedInto != "dispute:d2"+uid {
		t.Fatalf("merged %+v", r)
	}
	s.promoResolve(ctx, "dispute:d2"+uid, "won")
	if pro := rc.ends(uid, "pro"); len(pro) != 2 || !(pro[0].Equal(campaign) || pro[1].Equal(campaign)) {
		t.Fatalf("after both: pro %v", pro)
	}
}

func grantCall(s *Service, method, uid, id, body string, fresh bool) (int, map[string]any) {
	at := time.Now()
	if !fresh {
		at = at.Add(-time.Hour)
	}
	a := &AdminUser{UID: "admin", Email: "owner@x", Method: "passkey", AssertedAt: at}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(method, "/v1/admin/accounts/"+uid+"/grants", strings.NewReader(body))
	switch method {
	case http.MethodPost:
		s.HandleAdminGrantPro(w, r, a, uid)
	case http.MethodDelete:
		s.HandleAdminRevokeGrant(w, r, a, uid, id)
	default:
		s.HandleAdminGrants(w, r, a, uid)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

// Admin → Grant Pro: a record, then a RevenueCat grant to ends_at. A
// refund's snapshot adds the record RevenueCat's collapsed view hides
// (no longer uncertain); a revoke gives every other grant back.
func TestAdminGrantPro(t *testing.T) {
	s, _, rc, _ := promoService(t)
	ctx := context.Background()
	uid, _, campaign, _ := promoAccount(t, s, rc)
	support := ms(time.Now().Add(10 * 24 * time.Hour)) // ends before the plan's pro: hidden under it
	body := `{"entitlement":"pro","ends_at":"` + support.Format(time.RFC3339Nano) + `","reason":"app crash on export, goodwill"}`
	if code, out := grantCall(s, http.MethodPost, uid, "", body, false); code != http.StatusUnauthorized || out["error"] != "reauth_required" {
		t.Fatalf("stale sign-in %d %v", code, out)
	}
	if code, _ := grantCall(s, http.MethodPost, uid, "", `{"entitlement":"trial","ends_at":"`+support.Format(time.RFC3339)+`","reason":"x"}`, true); code != 400 {
		t.Fatalf("entitlement %d", code)
	}
	if code, _ := grantCall(s, http.MethodPost, "u"+store.NewID(), "", body, true); code != 404 {
		t.Fatalf("unknown account %d", code)
	}
	code, out := grantCall(s, http.MethodPost, uid, "", body, true)
	g, _ := out["grant"].(map[string]any)
	if code != http.StatusCreated || g["status"] != "active" || g["granted_by"] != "owner@x" {
		t.Fatalf("grant %d %v", code, out)
	}
	gid := g["id"].(string)
	found := false
	for _, e := range rc.ends(uid, "pro") {
		found = found || e.Equal(support)
	}
	if !found {
		t.Fatalf("RevenueCat grant to ends_at: %v", rc.ends(uid, "pro"))
	}
	// A refund of the plan: its pro goes; the campaign's and the support
	// grant (from its record) come back.
	s.revokeRefundedPlan(ctx, uid, "in_g1")
	pro := rc.ends(uid, "pro")
	has := func(want time.Time) bool {
		for _, e := range pro {
			if e.Equal(want) {
				return true
			}
		}
		return false
	}
	if len(pro) != 2 || !has(campaign) || !has(support) {
		t.Fatalf("after the refund pro %v (campaign %v support %v)", pro, campaign, support)
	}
	rec, _ := s.Store.GetPromoRegrant(ctx, "refund:in_g1")
	if rec.Uncertain || len(rec.Regranted) != 2 {
		t.Fatalf("record %+v", rec)
	}
	// Revoke: a reason is required; the campaign's Pro stays.
	if code, _ := grantCall(s, http.MethodDelete, uid, gid, `{}`, true); code != 400 {
		t.Fatalf("no reason %d", code)
	}
	code, out = grantCall(s, http.MethodDelete, uid, gid, `{"reason":"granted to the wrong account"}`, true)
	if g, _ := out["grant"].(map[string]any); code != 200 || g["status"] != "revoked" || g["revoke_reason"] != "granted to the wrong account" {
		t.Fatalf("revoke %d %v", code, out)
	}
	if pro = rc.ends(uid, "pro"); len(pro) != 1 || !pro[0].Equal(campaign) {
		t.Fatalf("after the revoke pro %v", pro)
	}
	if code, _ := grantCall(s, http.MethodDelete, uid, gid, `{"reason":"again"}`, true); code != http.StatusConflict {
		t.Fatalf("second revoke %d", code)
	}
	if code, out := grantCall(s, http.MethodGet, uid, "", "", false); code != 200 || len(out["grants"].([]any)) != 1 {
		t.Fatalf("list %d %v", code, out)
	}
}
