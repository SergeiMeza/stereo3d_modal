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
		"POST /v1/account/delete", "POST /v1/account/delete/cancel",
		"POST /v1/plans/change", "POST /v1/billing/plan/cancel", "DELETE /v1/plans/scheduled-change",
		"POST /v1/account/plan/cancel", "POST /v1/account/plan/resume",
		"POST /v1/billing/methods/setup", "POST /v1/billing/methods/{id}/default", "PUT /v1/billing/methods/order",
		"DELETE /v1/billing/methods/{id}", "POST /v1/billing/portal",
		"POST /v1/support/refund-requests",
		"POST /v1/account/emails", "POST /v1/account/emails/{id}/main", "DELETE /v1/account/emails/{id}",
		"POST /v1/billing/restore/move", "POST /v1/support/plan-moves/{id}/accept",
	} {
		if !strings.Contains(route(p), "api.Fresh(") {
			t.Errorf("%s: no fresh sign-in check", p)
		}
	}
	for _, p := range []string{
		"GET /v1/account/delete", "GET /v1/account/identities", "GET /v1/account/emails", "POST /v1/account/emails/start",
		"POST /v1/billing/restore/find", "POST /v1/billing/restore/find/verify", "GET /v1/support/plan-moves", "GET /v1/billing/methods", "POST /v1/plans/preview-change",
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

// A pending deletion (the 48-hour wait, owner 2026-11-07) freezes new runs
// and previews, paying a waiting run, top-ups, plan purchases and moves,
// sign-in methods and emails; reads, the delete and its cancel stay open.
func TestRoutesFrozenWhileDeleting(t *testing.T) {
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
		"POST /v1/conversions", "POST /v1/projects/{id}/conversions", "POST /v1/runs/{id}/formats",
		"POST /v1/conversions/{id}/pay-now", "POST /v1/conversions/{id}/handoff",
		"POST /v1/billing/balance/topup", "POST /v1/billing/plan", "POST /v1/plans/change", "POST /v1/billing/restore",
		"POST /v1/billing/restore/move", "POST /v1/support/plan-moves/{id}/accept",
		"POST /v1/account/identities/link", "DELETE /v1/account/identities/{provider}",
		"POST /v1/account/passkeys/register/options", "POST /v1/account/passkeys/register/verify", "DELETE /v1/account/passkeys/{id}",
		"POST /v1/account/emails/start", "POST /v1/account/emails", "POST /v1/account/emails/{id}/main", "DELETE /v1/account/emails/{id}",
	} {
		if !strings.Contains(route(p), "FrozenWhileDeleting(") {
			t.Errorf("%s: not frozen while a deletion is pending", p)
		}
	}
	for _, p := range []string{
		"POST /v1/account/delete", "POST /v1/account/delete/cancel", "GET /v1/account/delete", "GET /v1/billing", "GET /v1/limits",
		"DELETE /v1/conversions/{id}", "POST /v1/billing/settle", "POST /v1/billing/plan/cancel", "POST /v1/account/plan/cancel",
	} {
		if strings.Contains(route(p), "FrozenWhileDeleting(") {
			t.Errorf("%s: shouldn't be frozen", p)
		}
	}
}
