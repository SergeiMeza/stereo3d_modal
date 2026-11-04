package api

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The RevenueCat webhook refreshes the accounts an event names (not the
// anonymous ones) so pro_state follows the app's stores; it needs the
// dashboard's Authorization header and is off without one.
func TestRevenueCatWebhook(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	s.RevenueCat = rcWith(t, "svs_pro_monthly", "app_store", "")
	uid := "u" + store.NewID()
	call := func(auth, body string) int {
		rec := httptest.NewRecorder()
		r := httptest.NewRequest("POST", "/webhooks/revenuecat", strings.NewReader(body))
		if auth != "" {
			r.Header.Set("Authorization", auth)
		}
		s.HandleRevenueCatWebhook(rec, r)
		return rec.Code
	}
	ev := `{"event":{"type":"RENEWAL","app_user_id":"$RCAnonymousID:abc","original_app_user_id":"$RCAnonymousID:abc","aliases":["` + uid + `"],"store":"APP_STORE"}}`
	if code := call("Bearer x", ev); code != 503 {
		t.Fatalf("off %d", code)
	}
	s.Cfg.RevenueCatWebhookAuth = "Bearer rc-hook"
	if code := call("Bearer wrong", ev); code != 401 {
		t.Fatalf("bad auth %d", code)
	}
	if code := call("Bearer rc-hook", ev); code != 200 {
		t.Fatalf("ok %d", code)
	}
	got, err := s.Store.SwapProState(ctx, uid, true, time.Now()) // read back by swapping the same value
	if err != nil || got == nil || !got.Pro || got.CheckedAt == nil {
		t.Fatalf("pro state %+v %v", got, err)
	}
	if ids := rcAccountIDs([]string{"$RCAnonymousID:1", "a", "a", "", "b"}); len(ids) != 2 {
		t.Fatalf("ids %v", ids)
	}
}

// pro_state moves checked_at on every look past its TTL, and at only on a
// change: "at" alone read as stale while nothing had changed.
func TestProStateCheckedAt(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.noteProSeen(ctx, uid, false)
	first, _ := s.Store.SwapProState(ctx, uid, false, time.Now())
	proSeen.Store(uid, proSeenEntry{pro: false, at: time.Now().Add(-proStateTTL - time.Second)})
	s.noteProSeen(ctx, uid, false)
	again, _ := s.Store.SwapProState(ctx, uid, false, time.Now())
	if first == nil || again == nil || !again.At.Equal(first.At) || again.CheckedAt == nil || !again.CheckedAt.After(*first.CheckedAt) {
		t.Fatalf("first %+v again %+v", first, again)
	}
}
