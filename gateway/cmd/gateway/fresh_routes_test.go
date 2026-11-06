package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The sensitive routes (owner 2026-11-06) are wrapped in api.Fresh; reads,
// quotes, runs, checkout and top-ups aren't.
func TestSensitiveRoutesNeedFreshSignIn(t *testing.T) {
	raw, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	route := func(pattern string) string {
		re := regexp.MustCompile(`mux\.HandleFunc\("` + regexp.QuoteMeta(pattern) + `", [^\n]*`)
		m := re.FindString(src)
		if m == "" {
			t.Fatalf("route %q not found", pattern)
		}
		return m
	}
	for _, p := range []string{
		"POST /v1/account/identities/link", "DELETE /v1/account/identities/{provider}",
		"DELETE /v1/account/passkeys/{id}",
		"POST /v1/account/delete",
		"POST /v1/plans/change", "POST /v1/billing/plan/cancel", "DELETE /v1/plans/scheduled-change",
		"POST /v1/account/plan/cancel", "POST /v1/account/plan/resume",
		"POST /v1/billing/methods/setup", "POST /v1/billing/methods/{id}/default", "PUT /v1/billing/methods/order",
		"DELETE /v1/billing/methods/{id}", "POST /v1/billing/portal",
		"POST /v1/support/refund-requests",
	} {
		if !strings.Contains(route(p), "api.Fresh(") {
			t.Errorf("%s: no fresh sign-in check", p)
		}
	}
	for _, p := range []string{
		"GET /v1/account/delete", "GET /v1/account/identities", "GET /v1/billing/methods", "POST /v1/plans/preview-change",
		"POST /v1/billing/plan", "POST /v1/billing/restore", "GET /v1/support/refund-options", "GET /v1/support/requests",
		"POST /v1/support/requests/{id}/reply", "GET /v1/projects", "POST /v1/projects/{id}/quotes", "POST /v1/projects/{id}/conversions",
	} {
		if strings.Contains(route(p), "api.Fresh(") {
			t.Errorf("%s: shouldn't need a fresh sign-in", p)
		}
	}
	// passkey registration keeps its own check (customer_passkeys.go)
	if !strings.Contains(route("POST /v1/account/passkeys/register/options"), "HandleCustomerPasskeyRegisterOptions") {
		t.Error("register route moved")
	}
}
