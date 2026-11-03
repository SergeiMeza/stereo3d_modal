package api

import (
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// C1: one rule per run, decided at start.
func TestDecideFlow(t *testing.T) {
	const th = 2500
	paid := &store.Customer{DefaultPaymentMethod: "pm_a", PaidMethods: []string{"pm_a"}, LastGoodMethod: "pm_a"}
	cases := []struct {
		name   string
		c      *store.Customer
		amount int64
		china  bool
		flow   string
		reason string
	}{
		{"nothing saved", &store.Customer{}, 100, false, store.FlowPayNow, "no_method"},
		{"no record", nil, 100, false, store.FlowPayNow, "no_method"},
		{"china", paid, 100, true, store.FlowChina, "china"},
		{"credit small", paid, 2500, false, store.FlowAfter, ""},
		{"credit large", paid, 2501, false, store.FlowPrecharge, ""},
		{"saved, never paid", &store.Customer{DefaultPaymentMethod: "pm_new"}, 100, false, store.FlowPrecharge, ""},
		{"portal card never paid, other paid", &store.Customer{DefaultPaymentMethod: "pm_new", PaidMethods: []string{"pm_old"}}, 100, false, store.FlowPrecharge, ""},
		{"all failed", &store.Customer{DefaultPaymentMethod: "pm_a", PaidMethods: []string{"pm_a"}, AllMethodsFailed: true}, 100, false, store.FlowPayNow, "all_methods_failed"},
		{"sheet only", &store.Customer{DefaultPaymentMethod: "pm_a", PaidMethods: []string{"pm_a"}, SheetOnly: true}, 100, false, store.FlowPayNow, "account_flag"},
		{"legacy payer (before backfill)", &store.Customer{DefaultPaymentMethod: "pm_a", LifetimePaidCents: 900}, 100, false, store.FlowAfter, ""},
	}
	for _, tc := range cases {
		flow, reason := decideFlow(tc.c, tc.amount, th, tc.china)
		if flow != tc.flow || reason != tc.reason {
			t.Errorf("%s: %s/%s, want %s/%s", tc.name, flow, reason, tc.flow, tc.reason)
		}
	}
}
