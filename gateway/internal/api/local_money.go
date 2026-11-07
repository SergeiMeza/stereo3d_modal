package api

import (
	"strconv"
	"strings"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Local amounts under Adaptive Pricing: what the customer saw and paid,
// written beside our USD amount on invoices, credit notes and receipt
// mails ("¥1,648 (US$10.00)"). Our mails and invoices are English, so the
// figures are too: grouped with commas, a dot before decimals.

// zeroDecimal: currencies Stripe counts in whole units (¥1, ₩1).
var zeroDecimal = map[string]bool{"bif": true, "clp": true, "djf": true, "gnf": true, "jpy": true, "kmf": true, "krw": true,
	"mga": true, "pyg": true, "rwf": true, "ugx": true, "vnd": true, "vuv": true, "xaf": true, "xof": true, "xpf": true}

// wholeShown: two-decimal in Stripe but shown in whole units when there
// are no cents (NT$317, not NT$317.00).
var wholeShown = map[string]bool{"twd": true, "huf": true, "isk": true}

// currencySign: how an amount in each currency is written; others are
// "SEK 120.00".
var currencySign = map[string]string{"jpy": "¥", "krw": "₩", "eur": "€", "cny": "CN¥", "twd": "NT$", "hkd": "HK$", "gbp": "£",
	"aud": "A$", "mxn": "MX$", "try": "₺", "cad": "CA$", "nzd": "NZ$", "sgd": "S$", "inr": "₹", "brl": "R$", "ils": "₪",
	"thb": "฿", "php": "₱", "vnd": "₫", "usd": "US$"}

func groupDigits(d string) string {
	for i := len(d) - 3; i > 0; i -= 3 {
		d = d[:i] + "," + d[i:]
	}
	return d
}

// formatMinor writes amount (the currency's smallest unit) in currency:
// "¥1,648", "€27.95", "NT$317", "SAR 17.99". Negative amounts keep a
// leading minus.
func formatMinor(amount int64, currency string) string {
	cur := strings.ToLower(currency)
	sign := ""
	if amount < 0 {
		sign, amount = "-", -amount
	}
	var num string
	switch {
	case zeroDecimal[cur]:
		num = groupDigits(strconv.FormatInt(amount, 10))
	case wholeShown[cur] && amount%100 == 0:
		num = groupDigits(strconv.FormatInt(amount/100, 10))
	default:
		frac := strconv.FormatInt(amount%100, 10)
		if len(frac) < 2 {
			frac = "0" + frac
		}
		num = groupDigits(strconv.FormatInt(amount/100, 10)) + "." + frac
	}
	if s, ok := currencySign[cur]; ok {
		return sign + s + num
	}
	return sign + strings.ToUpper(cur) + " " + num
}

// localAndUSD: "¥1,648 (US$10.00)"; just "$10.00" without a presentment.
func localAndUSD(p *store.Presentment, usdCents int64) string {
	if p == nil {
		return money(usdCents)
	}
	return formatMinor(p.AmountMinor, p.Currency) + " (US" + money(usdCents) + ")"
}

// paidMemo is the invoice memo for a payment presented locally: "Paid
// ¥1,648 (US$10.00)". The invoice itself stays USD.
func paidMemo(p *store.Presentment, usdCents int64) string {
	if p == nil {
		return ""
	}
	return "Paid " + localAndUSD(p, usdCents)
}
