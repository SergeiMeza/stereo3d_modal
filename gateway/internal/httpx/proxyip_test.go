package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWithTrustedProxy(t *testing.T) {
	var got struct {
		ip    string
		relay bool
		ok    bool
		left  string
	}
	h := WithTrustedProxy("k3y", http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		got.ip, got.relay, got.ok = TrustedClientIP(r.Context())
		got.left = r.Header.Get(HeaderProxyKey) + r.Header.Get(HeaderClientIP) + r.Header.Get(HeaderClientVia)
	}))
	call := func(key, ip, via string) {
		got.ip, got.relay, got.ok, got.left = "", false, false, ""
		r := httptest.NewRequest("POST", "/v1/auth/passkey/options", nil)
		if key != "" {
			r.Header.Set(HeaderProxyKey, key)
		}
		if ip != "" {
			r.Header.Set(HeaderClientIP, ip)
		}
		if via != "" {
			r.Header.Set(HeaderClientVia, via)
		}
		h.ServeHTTP(httptest.NewRecorder(), r)
	}
	call("k3y", "203.0.113.7", "relay")
	if !got.ok || got.ip != "203.0.113.7" || !got.relay || got.left != "" {
		t.Fatalf("trusted %+v", got)
	}
	call("wrong", "203.0.113.7", "")
	if got.ok || got.left != "" {
		t.Fatalf("wrong key must not be trusted, headers dropped: %+v", got)
	}
	call("", "203.0.113.7", "relay")
	if got.ok || got.left != "" {
		t.Fatalf("no key: %+v", got)
	}
	call("k3y", "not-an-ip", "")
	if got.ok {
		t.Fatalf("bad address: %+v", got)
	}
	// no key configured: nobody is trusted
	h2 := WithTrustedProxy("", http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, _, got.ok = TrustedClientIP(r.Context())
	}))
	r := httptest.NewRequest("POST", "/", nil)
	r.Header.Set(HeaderProxyKey, "")
	r.Header.Set(HeaderClientIP, "203.0.113.7")
	h2.ServeHTTP(httptest.NewRecorder(), r)
	if got.ok {
		t.Fatal("unconfigured key trusts nobody")
	}
}
