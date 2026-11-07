/** Browser-side MSW worker — the dev-preview gateway. Enabled when
 * NEXT_PUBLIC_API_MOCK=1 (see MswProvider). */
import { setupWorker } from "msw/browser";

import { balanceDialogAtom, settleOpenAtom } from "@/components/pay/payAtoms";
import { openProCheckout } from "@/lib/pro/checkoutStore";
import { plansFromPricing } from "@/lib/pro/plans";
import { appStore } from "@/lib/state/stores";

import { handlers, MOCK_PRO_PLANS, mockDb } from "./handlers";

// A fresh browser session starts WITHOUT a saved card, exactly like a
// brand-new account against the real gateway — so local dev exercises the
// onboarding gate end-to-end instead of hiding it (the missing-profile bug
// shipped to staging because the old mock auto-passed the billing check).
mockDb.billing.hasPaymentMethod = false;
mockDb.billing.card = undefined;

// S3D-67: the dev preview prices as a non-member (the "Pro members save"
// link shows); window.__mockDb lets a screenshot script flip it
mockDb.pro = false;
(globalThis as { __mockDb?: typeof mockDb }).__mockDb = mockDb;

/* Screenshot deep links (owner 2026-11-07, the iPhone Duo pass): ?mock=
 * a comma list, read once when the mock starts. This file loads only in
 * the mock (NEXT_PUBLIC_API_MOCK=1), never in a production build.
 *   returning  the welcome, tips and hints already seen
 *   card       a saved Visa •••• 4242 (pay-first runs pay now)
 *   onetap     card + one-tap offered (BUX-20)
 *   owed       $3.75 owed (Billing's banner; /account/billing?settle=1
 *              opens the payment sheet) */
const asked = new Set(
  (new URLSearchParams(window.location.search).get("mock") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
if (asked.has("returning") || asked.has("onetap") || asked.has("owed") || asked.has("card")) {
  mockDb.accountSettings.onboarding = { welcome_done: true, tips_done: true, checklist_hidden: true };
  mockDb.accountSettings.hints_seen = ["billing", "usage", "invoices", "plans", "pricing", "pro", "account", "devices", "scenes"];
}
if (asked.has("card") || asked.has("onetap") || asked.has("owed")) {
  mockDb.billing.hasPaymentMethod = true;
  mockDb.billing.card = { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 };
}
if (asked.has("onetap")) mockDb.oneTap = { ...mockDb.oneTap, enabled: true };
if (asked.has("owed")) {
  mockDb.billing.unpaid.push({ conversion_id: "cowedmock001", amount_cents: 375, currency: "usd", needs_action: false });
}
/*   runpay     the sample project's Lifelike run waits for its payment
 *              (/projects/<id>?mock=runpay&mockOpen=pay#tab=make opens it)
 *   paylink    a pay link /pay/tok_mock_pay ($25 top-up; &mockOpen=form
 *              opens its form) */
if (asked.has("runpay")) {
  const pid = [...mockDb.projects.keys()][0];
  const p = mockDb.projects.get(pid);
  if (p) {
    p.method = "lifelike";
    const now = new Date().toISOString();
    const run = {
      conversion_id: "crunpaymock1",
      state: "created" as const,
      kind: "video" as const,
      method: "lifelike" as const,
      project_id: pid,
      step: "production" as const,
      params: { preset: "4k", formats: ["mvhevc"] },
      quote: { amount_cents: 930, currency: "usd" },
      progress: 0,
      charge_timing: "before" as const,
      billing: { status: "requires_payment" as const, reason: "no_method" as const },
      publishable_key: "pk_test_mock",
      created_at: now,
      updated_at: now,
    };
    mockDb.conversions.set(run.conversion_id, run as never);
    p.conversions = [...(p.conversions ?? []), run as never];
  }
}
if (asked.has("paylink")) {
  mockDb.payRequests.set("tok_mock_pay", { label: "Balance top-up · $25.00", amount_cents: 2500, currency: "usd", state: "open", flow: "checkout", kind: "topup" });
}
/* ?mockOpen=<sheet> opens a sheet on load: topup (Add funds), settle (the
 * payment for what's owed), pro_weekly | pro_monthly | pro_yearly (the Pro
 * checkout); business | studio | business_yearly on /pricing, pay on a
 * project's Make 3D and form on /pay/<token> are read by their screens */
const open = new URLSearchParams(window.location.search).get("mockOpen");
if (open === "topup") appStore.set(balanceDialogAtom, "funds");
if (open === "settle") appStore.set(settleOpenAtom, true);
const pro = plansFromPricing(MOCK_PRO_PLANS).find((p) => p.id === open);
if (pro) void openProCheckout(pro);

export const worker = setupWorker(...handlers);
