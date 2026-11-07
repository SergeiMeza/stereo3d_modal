package api

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func TestHandoffCodes(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		c := newHandoffCode()
		if len(c) != 8 {
			t.Fatalf("code %q", c)
		}
		for _, r := range c {
			if !containsRune(crockford, r) {
				t.Fatalf("code %q has %q", c, r)
			}
		}
		seen[c] = true
		if normalizeCode(displayCode(c)) != c {
			t.Fatalf("round trip %q", c)
		}
	}
	if len(seen) < 195 {
		t.Fatalf("codes repeat: %d unique of 200", len(seen))
	}
	// Typed codes: case, dashes, spaces, O/I/L read as 0/1.
	if got := normalizeCode(" ab1o-il2z "); got != "AB10112Z" {
		t.Fatalf("normalize: %q", got)
	}
}

func containsRune(s string, r rune) bool {
	for _, x := range s {
		if x == r {
			return true
		}
	}
	return false
}

func TestHandoffLimiter(t *testing.T) {
	l := &handoffLimiter{hits: map[string][]time.Time{}}
	now := time.Now()
	for i := 0; i < 5; i++ {
		if !l.allow("1.2.3.4", now) {
			t.Fatalf("try %d refused", i+1)
		}
	}
	if l.allow("1.2.3.4", now) {
		t.Fatal("sixth try in a minute allowed")
	}
	if !l.allow("5.6.7.8", now) {
		t.Fatal("another IP refused")
	}
	if !l.allow("1.2.3.4", now.Add(61*time.Second)) {
		t.Fatal("not allowed again after a minute")
	}
}

func TestFlowState(t *testing.T) {
	cases := []struct {
		c    *store.Customer
		want string
	}{
		{nil, "sheet"},
		{&store.Customer{}, "sheet"},
		{&store.Customer{DefaultPaymentMethod: "pm", UnderReview: true}, "under_review"},
		{&store.Customer{DefaultPaymentMethod: "pm", SheetOnly: true}, "sheet"},
		{&store.Customer{DefaultPaymentMethod: "pm", AllMethodsFailed: true}, "sheet"},
		{&store.Customer{DefaultPaymentMethod: "pm"}, "saved"},
	}
	for _, tc := range cases {
		if got := flowState(tc.c); got != tc.want {
			t.Errorf("%+v: %s, want %s", tc.c, got, tc.want)
		}
	}
}

func TestLimitsApply(t *testing.T) {
	if !limitsApply(&store.Customer{}) || !limitsApply(nil) {
		t.Fatal("a new account is limited")
	}
	for _, c := range []*store.Customer{
		{DefaultPaymentMethod: "pm"}, {PaidMethods: []string{"pm"}}, {LifetimePaidCents: 1}, {PaidOnce: true},
	} {
		if limitsApply(c) {
			t.Fatalf("%+v still limited", c)
		}
	}
	l := accountLimits{Limited: true, ProjectsLeft: 0, BytesLeft: 5}
	if !l.Reached() || l.JSON()["reached"] != true {
		t.Fatal("no projects left must read reached")
	}
	if (accountLimits{}).JSON()["limited"] != false {
		t.Fatal("unlimited JSON")
	}
}

// C10: an account that owes money can't download; paying (or nothing
// owed) unlocks it.
func TestOutstandingLock(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	if err := s.outstandingLock(ctx, uid); err != nil {
		t.Fatalf("nothing owed: %v", err)
	}
	c := &store.Conversion{ID: store.NewID(), UID: uid, State: store.StateSucceeded, Kind: "video",
		Quote: store.Quote{AmountCents: 1234, Currency: "usd"}}
	c.Stripe.PIStatus = store.PIChargeFailed
	if err := s.Store.CreateConversion(ctx, c); err != nil {
		t.Fatal(err)
	}
	err := s.outstandingLock(ctx, uid)
	var apiErr *httpx.APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusPaymentRequired {
		t.Fatalf("owed: %v", err)
	}
	if d := apiErr.Details; d["amount_cents"] != int64(1234) {
		t.Fatalf("details: %+v", apiErr.Details)
	}
}
