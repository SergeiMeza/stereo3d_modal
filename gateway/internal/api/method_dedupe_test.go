package api

import (
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// The same card (fingerprint and expiry), Link account or PayPal account
// saved twice is one method: the one just saved stays (else the newest),
// the others go; different cards stay apart.
func TestDedupePlan(t *testing.T) {
	ms := []*stripex.CardInfo{
		{PaymentMethodID: "pm_link_old", Type: "link", Email: "J@gmail.com", Created: 10},
		{PaymentMethodID: "pm_link_new", Type: "link", Email: "j@gmail.com", Created: 20},
		{PaymentMethodID: "pm_visa_a", Type: "card", Fingerprint: "fpA", ExpMonth: 4, ExpYear: 2030, Created: 5},
		{PaymentMethodID: "pm_visa_b", Type: "card", Fingerprint: "fpA", ExpMonth: 4, ExpYear: 2030, Created: 30},
		{PaymentMethodID: "pm_visa_renewed", Type: "card", Fingerprint: "fpA", ExpMonth: 4, ExpYear: 2033, Created: 40},
		{PaymentMethodID: "pm_apple", Type: "card", Fingerprint: "fpA", ExpMonth: 4, ExpYear: 2030, Wallet: "apple_pay", Created: 41},
		{PaymentMethodID: "pm_other", Type: "card", Fingerprint: "fpB", ExpMonth: 1, ExpYear: 2031, Created: 50},
		{PaymentMethodID: "pm_paypal", Type: "paypal", Email: "p@x.com", Created: 60},
	}
	drop := dedupePlan(ms, "pm_link_new")
	if len(drop) != 2 || drop["pm_link_old"] != "pm_link_new" || drop["pm_visa_a"] != "pm_visa_b" {
		t.Fatalf("drop %v", drop)
	}
	// the method just saved wins even when older
	if drop := dedupePlan(ms, "pm_visa_a"); drop["pm_visa_b"] != "pm_visa_a" {
		t.Fatalf("prefer %v", drop)
	}
	// the list shows one per account, the default kept
	shown := uniqueMethods(ms, "pm_link_old")
	ids := map[string]bool{}
	for _, m := range shown {
		ids[m.PaymentMethodID] = true
	}
	if len(shown) != 6 || !ids["pm_link_old"] || ids["pm_link_new"] || ids["pm_visa_a"] {
		t.Fatalf("shown %v", ids)
	}
	if methodKey(&stripex.CardInfo{Type: "card"}) != "" {
		t.Fatal("a card without a fingerprint can't be matched")
	}
}
