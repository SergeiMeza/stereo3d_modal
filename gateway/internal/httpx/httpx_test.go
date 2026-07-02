package httpx

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func corsHandler(origins ...string) http.Handler {
	return WithCORS(origins, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
}

func TestCORSPreflightAllowedOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "/v1/projects", nil)
	req.Header.Set("Origin", "https://studio.example.com")
	rec := httptest.NewRecorder()
	corsHandler("https://studio.example.com").ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status: want 204, got %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://studio.example.com" {
		t.Errorf("allow-origin: got %q", got)
	}
	for _, h := range []string{"Authorization", "Idempotency-Key"} {
		if !contains(rec.Header().Get("Access-Control-Allow-Headers"), h) {
			t.Errorf("allow-headers missing %s: %q", h, rec.Header().Get("Access-Control-Allow-Headers"))
		}
	}
	if !contains(rec.Header().Get("Access-Control-Allow-Methods"), "PATCH") {
		t.Errorf("allow-methods missing PATCH: %q", rec.Header().Get("Access-Control-Allow-Methods"))
	}
}

func TestCORSDisallowedOriginGetsNoHeadersAndReachesMux(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/v1/projects", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	rec := httptest.NewRecorder()
	corsHandler("https://studio.example.com").ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("allow-origin for disallowed origin: got %q, want empty", got)
	}
	if rec.Code != http.StatusTeapot {
		t.Errorf("disallowed origin must still reach the handler (server-to-server safety net), got %d", rec.Code)
	}
}

func TestCORSWildcardReflectsOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	rec := httptest.NewRecorder()
	corsHandler("*").ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Errorf("wildcard should reflect the origin, got %q", got)
	}
	if got := rec.Header().Get("Access-Control-Expose-Headers"); !contains(got, "X-Request-Id") {
		t.Errorf("expose-headers missing X-Request-Id: %q", got)
	}
}

func TestCORSNoOriginHeaderIsUntouched(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	corsHandler("*").ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("no Origin: allow-origin should be absent, got %q", got)
	}
	if rec.Code != http.StatusTeapot {
		t.Errorf("no Origin: handler should run, got %d", rec.Code)
	}
}

func contains(haystack, needle string) bool { return strings.Contains(haystack, needle) }
