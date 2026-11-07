package api

import (
	"strings"
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
		// REV-04: Stripe's three-decimal currencies (1 KWD = 1000)
		{3070, "kwd", "KWD 3.070"}, {3770, "bhd", "BHD 3.770"}, {7090, "jod", "JOD 7.090"}, {3850, "omr", "OMR 3.850"},
		{31250, "tnd", "TND 31.250"}, {1234560, "KWD", "KWD 1,234.560"}, {-50, "bhd", "-BHD 0.050"},
	} {
		if got := formatMinor(c.amount, c.cur); got != c.want {
			t.Fatalf("%d %s: %q, want %q", c.amount, c.cur, got, c.want)
		}
	}
	for cur, want := range map[string]int{"jpy": 0, "krw": 0, "xof": 0, "kwd": 3, "BHD": 3, "jod": 3, "omr": 3, "tnd": 3, "eur": 2, "huf": 2, "twd": 2, "usd": 2} {
		if got := minorExponent(cur); got != want {
			t.Fatalf("exponent %s: %d, want %d", cur, got, want)
		}
	}
	if got := localAndUSD(&store.Presentment{AmountMinor: 3070, Currency: "kwd"}, 1000); got != "KWD 3.070 (US$10.00)" {
		t.Fatal(got)
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
	for cur, want := range map[string]int{"jpy": 0, "krw": 0, "xof": 0, "kwd": 3, "BHD": 3, "jod": 3, "omr": 3, "tnd": 3, "eur": 2, "huf": 2, "twd": 2, "usd": 2} {
		if got := minorExponent(cur); got != want {
			t.Fatalf("exponent %s: %d, want %d", cur, got, want)
		}
	}
	if got := localAndUSD(&store.Presentment{AmountMinor: 3070, Currency: "kwd"}, 1000); got != "KWD 3.070 (US$10.00)" {
		t.Fatal(got)
	}
	jpy := &store.Presentment{AmountMinor: 1648, Currency: "jpy"}
	// the local amount sits in the amount line itself
	run := runInfo{Name: "Beach", Res: "4K"}
	m := orderConfirmationMail(run, amountText(jpy, 1000), "https://site/p", true).layout("en")
	if paid := m.Rows[len(m.Rows)-1]; paid.Label != "Paid" || paid.Value != "¥1,648 (US$10.00)" || !paid.Total ||
		strings.Contains(m.Text(), "card") {
		t.Fatalf("%+v", m.Rows)
	}
	if plain := orderConfirmationMail(run, amountText(nil, 1000), "https://site/p", true).layout("en"); plain.Rows[len(plain.Rows)-1].Value != "$10.00" {
		t.Fatalf("usd %+v", plain.Rows)
	}
}
