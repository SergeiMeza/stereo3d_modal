package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/identity"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The 2026-11-08 security fix: clientIP no longer trusts a caller's
// X-Client-IP (or a forged first X-Forwarded-For hop). Only the relay's
// X-Client-IP counts, and only when the relay is the hop that reached the
// load balancer.

const lbIP, relayIP = "34.117.11.37", "101.47.76.86"

// spoofed is a request through the load balancer from real (not the
// relay) that claims to be fake in X-Client-IP and a forged first hop.
func spoofed(method, body, real, fake string) *http.Request {
	r := httptest.NewRequest(method, "/", strings.NewReader(body))
	r.RemoteAddr = "169.254.8.1:443"
	r.Header.Set("X-Forwarded-For", fake+", "+real+", "+lbIP)
	r.Header.Set("X-Client-IP", fake)
	return r
}

func fakeIP(i int) string { return fmt.Sprintf("10.66.%d.%d", i/250, i%250+1) }

func TestClientIPPolicy(t *testing.T) {
	real := testIP()
	if got := clientIP(spoofed("GET", "", real, "10.9.9.9")); got != real {
		t.Fatalf("through the LB with a claimed X-Client-IP: %s, want %s", got, real)
	}
	// the relay: its X-Client-IP is the caller
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("X-Forwarded-For", "203.0.113.9, "+relayIP+", "+lbIP)
	r.Header.Set("X-Client-IP", "203.0.113.9")
	if got := clientIP(r); got != "203.0.113.9" {
		t.Fatalf("through the relay: %s", got)
	}
	// straight to run.app: Google appends the caller last
	r = httptest.NewRequest("GET", "/", nil)
	r.Header.Set("X-Forwarded-For", "10.1.1.1, "+real)
	r.Header.Set("X-Client-IP", "10.1.1.1")
	if got := clientIP(r); got != real {
		t.Fatalf("direct with forged hops: %s", got)
	}
	// a policy set at start is used
	SetClientIPPolicy(identity.NewIPPolicy("192.0.2.1", relayIP))
	t.Cleanup(func() { SetClientIPPolicy(identity.NewIPPolicy("", "")) })
	r = httptest.NewRequest("GET", "/", nil)
	r.Header.Set("X-Forwarded-For", "10.2.2.2, "+real+", 192.0.2.1")
	r.Header.Set("X-Client-IP", "10.2.2.2")
	if got := clientIP(r); got != real {
		t.Fatalf("configured LB: %s", got)
	}
}

// Passkeys: the per-address bucket trips however the header varies.
func TestSpoofPasskeyLimit(t *testing.T) {
	real := testIP()
	for i := 0; i < cpkPerIPHour; i++ {
		if !cpkAllowed(spoofed("POST", "", real, fakeIP(i)), "") {
			t.Fatalf("refused early at %d", i)
		}
	}
	if cpkAllowed(spoofed("POST", "", real, fakeIP(999)), "") {
		t.Fatal("a fresh X-Client-IP got past the passkey limit")
	}
}

// Identity links (Apple/Google/email): the same.
func TestSpoofIdentityLimit(t *testing.T) {
	real := testIP()
	for i := 0; i < identityCallsPerIPHour; i++ {
		if !identityAllowed(spoofed("POST", "", real, fakeIP(i)), "u"+store.NewID()) {
			t.Fatalf("refused early at %d", i)
		}
	}
	if identityAllowed(spoofed("POST", "", real, fakeIP(999)), "u"+store.NewID()) {
		t.Fatal("a fresh X-Client-IP got past the identity limit")
	}
}

// Feedback: five an hour from one address, whatever it claims.
func TestSpoofFeedbackLimit(t *testing.T) {
	s, _ := e0Service(t)
	real := testIP()
	codes := map[int]int{}
	for i := 0; i < feedbackPerHour+1; i++ {
		rec := httptest.NewRecorder()
		s.HandleFeedback(rec, spoofed("POST", `{"kind":"idea","message":"hi"}`, real, fakeIP(i)), &AuthedUser{UID: "u" + store.NewID()})
		codes[rec.Code]++
	}
	if codes[429] != 1 {
		t.Fatalf("feedback by address %v", codes)
	}
}

// Restore: the address limit across accounts.
func TestSpoofRestoreLimit(t *testing.T) {
	s, _ := e0Service(t)
	real := testIP()
	codes := map[int]int{}
	for i := 0; i < restorePerIPHour+1; i++ {
		rec := httptest.NewRecorder()
		s.HandleRestore(rec, spoofed("POST", "", real, fakeIP(i)), &AuthedUser{UID: "u" + store.NewID()})
		codes[rec.Code]++
	}
	if codes[429] != 1 {
		t.Fatalf("restore by address %v", codes)
	}
}

// Restore-find (the email code for a restore): the address limit.
func TestSpoofRestoreFindLimit(t *testing.T) {
	s, _ := identityService(t)
	real := testIP()
	codes := map[int]int{}
	for i := 0; i < restoreFindPerIPHour+1; i++ {
		rec := httptest.NewRecorder()
		s.HandleRestoreFind(rec, spoofed("POST", `{"email":"someone`+fmt.Sprint(i)+`@example.com"}`, real, fakeIP(i)), &AuthedUser{UID: "u" + store.NewID()})
		codes[rec.Code]++
	}
	if codes[429] != 1 {
		t.Fatalf("restore-find by address %v", codes)
	}
}

// Refund requests: ten an hour from one address.
func TestSpoofRefundRequestLimit(t *testing.T) {
	s, fake, _, _ := promoService(t)
	real := supportIP()
	codes := map[int]int{}
	for i := 0; i < refundRequestsPerIPHour+1; i++ {
		uid := "u" + store.NewID()
		run := paidRun(t, s, fake, uid, store.StateSucceeded, 500, time.Hour)
		rec := httptest.NewRecorder()
		s.HandleRefundRequest(rec, spoofed("POST", `{"conversion_ids":["`+run.ID+`"]}`, real, fakeIP(i)), &AuthedUser{UID: uid, AuthTime: time.Now()})
		codes[rec.Code]++
	}
	if codes[429] != 1 {
		t.Fatalf("refund requests by address %v", codes)
	}
}

// Hand-off codes (public): five tries a minute from one address.
func TestSpoofHandoffLimit(t *testing.T) {
	s, _ := e0Service(t)
	real := testIP()
	codes := map[int]int{}
	for i := 0; i < 6; i++ {
		rec := httptest.NewRecorder()
		r := spoofed("GET", "", real, fakeIP(i))
		r.SetPathValue("code", "ZZZZ-ZZZZ")
		s.HandleGetHandoff(rec, r)
		codes[rec.Code]++
	}
	if codes[429] != 1 || codes[404] != 5 {
		t.Fatalf("hand-off by address %v", codes)
	}
}
