import { describe, expect, it } from "vitest";

import { makeTr } from "@/lib/i18n/t";

import { formatCents, formatMoney, formatUsdLabeled, groupMoney, localAmount, paidLocal } from "./money";
import { LOCALES } from "@/lib/i18n/locales";

describe("formatCents", () => {
  it("formats cents as $X.XX (never dollar floats)", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(50)).toBe("$0.50");
    expect(formatCents(1234)).toBe("$12.34");
    expect(formatCents(100000)).toBe("$1,000.00");
  });

  it("formats negatives (discount lines) with a minus sign", () => {
    expect(formatCents(-50)).toBe("−$0.50");
    expect(formatCents(-100)).toBe("−$1.00");
  });
});

describe("groupMoney (owner 2026-11-05: every Billing amount groups its thousands)", () => {
  it("rewrites the gateway's amounts in text, and leaves grouped ones", () => {
    expect(groupMoney("Usage credit added · $1500.00")).toBe("Usage credit added · $1,500.00");
    expect(groupMoney("Balance top-up · $25.00")).toBe("Balance top-up · $25.00");
    expect(groupMoney("Studio plan $11988.00 − $1000.00")).toBe("Studio plan $11,988.00 − $1,000.00");
    expect(groupMoney("Usage credit added · $1,500.00")).toBe("Usage credit added · $1,500.00");
    expect(groupMoney("Credit -$1200")).toBe("Credit −$1,200");
    expect(groupMoney("Business plan · monthly")).toBe("Business plan · monthly");
  });
});

describe("formatMoney (owner 2026-11-07, Option B): any currency in its own minor units", () => {
  const LRI = "⁦";
  const PDI = "⁩";
  it("JPY and KRW have no minor unit; EUR and USD have two", () => {
    expect(formatMoney(1234, "jpy", "en-US")).toBe("¥1,234");
    expect(formatMoney(12345, "krw", "en-US")).toBe("₩12,345");
    expect(formatMoney(123456, "eur", "en-US")).toBe("€1,234.56");
    expect(formatMoney(825, "usd", "en-US")).toBe("$8.25");
  });

  it("counts minor units as Stripe does, not Intl (REV-02)", () => {
    // Intl says 0 for these; Stripe sends 2
    expect(formatMoney(399000, "huf", "en-US")).toBe("HUF\u00a03,990");
    expect(formatMoney(399050, "huf", "en-US")).toBe("HUF\u00a03,990.50");
    expect(formatMoney(15900000, "idr", "en-US")).toBe("IDR\u00a0159,000.00");
    expect(formatMoney(139000, "isk", "en-US")).toBe("ISK\u00a01,390");
    expect(formatMoney(400000, "cop", "en-US")).toBe("COP\u00a04,000.00");
    expect(formatMoney(280000, "pkr", "en-US")).toBe("PKR\u00a02,800.00");
    // three decimals
    expect(formatMoney(3050, "kwd", "en-US")).toBe("KWD\u00a03.050");
    expect(formatMoney(3050, "bhd", "en-US")).toBe("BHD\u00a03.050");
    // whole units
    expect(formatMoney(1648, "jpy", "en-US")).toBe("¥1,648");
    expect(formatMoney(1838, "usd", "en-US")).toBe("$18.38");
  });

  it("each language writes them its own way", () => {
    expect(formatMoney(1234, "jpy", "ja-JP")).toBe("￥1,234");
    expect(formatMoney(825, "usd", "ja-JP")).toBe("$8.25");
    expect(formatMoney(1234, "jpy", "de-DE")).toBe("1.234 ¥");
    expect(formatMoney(123456, "eur", "de-DE")).toBe("1.234,56 €");
    expect(formatMoney(12345, "krw", "ko-KR")).toBe("₩12,345");
    expect(formatMoney(825, "usd", "zh-CN")).toBe("US$8.25");
  });

  it("Arabic keeps Latin digits and the amount isolated inside a sentence", () => {
    const jpy = formatMoney(1234, "jpy", "ar-u-nu-latn");
    expect(jpy.startsWith(LRI) && jpy.endsWith(PDI)).toBe(true);
    expect(jpy).toContain("1,234");
    expect(jpy).toMatch(/JP¥|¥/);
    expect(formatMoney(123456, "eur", "ar-u-nu-latn")).toContain("1,234.56");
    expect(formatMoney(825, "usd", "ar-u-nu-latn")).toContain("8.25");
    expect(formatMoney(825, "usd", "ar-u-nu-latn")).not.toMatch(/[٠-٩]/);
  });

  it("paidLocal: \"Paid ¥1,234 (US$8.25)\" with a presentment, null for US dollars or none", () => {
    expect(paidLocal({ amount_minor: 1234, currency: "jpy" }, 825)).toBe("Paid ¥1,234 (US$8.25)");
    expect(paidLocal({ amount_minor: 760, currency: "eur" }, 825)).toBe("Paid €7.60 (US$8.25)");
    expect(paidLocal({ amount_minor: 11000, currency: "krw" }, 825)).toBe("Paid ₩11,000 (US$8.25)");
    expect(paidLocal(null, 825)).toBeNull();
    expect(paidLocal(undefined, 825)).toBeNull();
    expect(paidLocal({ amount_minor: 825, currency: "usd" }, 825)).toBeNull();
    const ja = makeTr("ja", null);
    expect(paidLocal({ amount_minor: 1234, currency: "jpy" }, 825, ja)).toBe("Paid ￥1,234 (USD\u00a08.25)");
    expect(localAmount({ amount_minor: 1234, currency: "jpy" }, ja)).toBe("￥1,234");
    expect(localAmount(null, ja)).toBeNull();
  });
});

describe("formatUsdLabeled: US dollars beside another currency always say US (owner 2026-11-07)", () => {
  it.each(LOCALES.map((l) => [l.code, l.intl]))("%s", (_code, intl) => {
    const usd = formatUsdLabeled(825, intl);
    expect(usd).toMatch(/US/);
    expect(usd).toMatch(/8[.,]25/);
    expect(usd).not.toMatch(/[٠-٩]/);
    // a US dollar amount on its own keeps "$" as today
    expect(formatMoney(825, "usd", intl)).toMatch(/\$|USD/);
  });

  it("the language's own US$ where it has one (English like the invoices), Intl's code otherwise", () => {
    expect(formatUsdLabeled(825, "en-US")).toBe("US$8.25");
    expect(formatUsdLabeled(123450, "en-US")).toBe("US$1,234.50");
    expect(formatUsdLabeled(825, "ja-JP")).toBe("USD\u00a08.25");
    expect(formatUsdLabeled(825, "zh-CN")).toBe("US$8.25");
    expect(formatUsdLabeled(825, "ko-KR")).toBe("US$8.25");
    expect(formatUsdLabeled(825, "fr-FR")).toBe("8,25\u00a0$US");
    expect(formatUsdLabeled(825, "de-DE")).toBe("8,25\u00a0USD");
    expect(formatCents(825)).toBe("$8.25");
  });
});
