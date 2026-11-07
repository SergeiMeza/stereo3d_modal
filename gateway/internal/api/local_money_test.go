package api

import (
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func TestFormatMinor(t *testing.T) {
	for _, c := range []struct {
		amount int64
		cur    string
		want   string
	}{
		{1648, "jpy", "¥1,648"}, {1648, "JPY", "¥1,648"}, {7077, "krw", "₩7,077"}, {68060, "krw", "₩68,060"},
		{2795, "eur", "€27.95"}, {5, "eur", "€0.05"}, {31700, "twd", "NT$317"}, {31750, "twd", "NT$317.50"},
		{1799, "sar", "SAR 17.99"}, {1499, "aed", "AED 14.99"}, {24999, "try", "₺249.99"}, {-659, "jpy", "-¥659"},
		{123456789, "usd", "US$1,234,567.89"}, {39900, "huf", "HUF 399"},
	} {
		if got := formatMinor(c.amount, c.cur); got != c.want {
			t.Fatalf("%d %s: %q, want %q", c.amount, c.cur, got, c.want)
		}
	}
	jpy := &store.Presentment{AmountMinor: 1648, Currency: "jpy"}
	if got := paidMemo(jpy, 1000); got != "Paid ¥1,648 (US$10.00)" {
		t.Fatal(got)
	}
	if paidMemo(nil, 1000) != "" || localAndUSD(nil, 1000) != "$10.00" {
		t.Fatal("usd")
	}
}

// Receipt mails (E1, E13) say what the card was charged locally, right
// after their first line; a USD payment reads as before.
func TestReceiptCardLine(t *testing.T) {
	jpy := &store.Presentment{AmountMinor: 1648, Currency: "jpy"}
	m := withCardLine(orderConfirmationMail("Beach · 4K", 1000, "https://site/p", true), jpy, 1000)
	if len(m.Lines) < 3 || m.Lines[0] != "Beach · 4K · $10.00, charged now." || m.Lines[1] != "Your card was charged ¥1,648 (US$10.00)." {
		t.Fatalf("%q", m.Lines)
	}
	plain := orderConfirmationMail("Beach · 4K", 1000, "https://site/p", true)
	if got := withCardLine(plain, nil, 1000); len(got.Lines) != len(plain.Lines) {
		t.Fatalf("usd %q", got.Lines)
	}
}
