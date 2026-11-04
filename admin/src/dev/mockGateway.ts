import { casePage, casesResponse, disputes, mailPreviews } from "../test/fixtures";

/**
 * A canned gateway for `vite build --mode overlays` (scripts/overlay-bounds.mjs):
 * the console renders signed in, against fixtures, with no network and no
 * Firebase. Never part of a production build (main.tsx drops it).
 */

const account = {
  account: { uid: "uid_123", email: "jane@example.com", stripe_customer_id: "cus_1", blocked: false },
  billing_state: { flow_state: "outstanding", sheet_only: true, sheet_only_reason: "dispute", under_review: true, lifetime_paid_cents: 9000 },
  owed_cents: 125,
  balance: null,
  methods: [{ id: "pm_1", label: "Visa •••• 4242", type: "card" }],
  cases: [],
  charges: [],
  refunds: [],
  ledger: [],
  passkey_count: 2,
  grants: [
    {
      id: "gr_1",
      uid: "uid_123",
      entitlement: "pro",
      ends_at: "2026-12-04T10:00:00Z",
      granted_by: "owner@example.com",
      reason: "creator partnership",
      created_at: "2026-11-04T10:00:00Z",
      status: "active",
    },
  ],
  promo_regrants: [
    { id: "pr_2", event: "dispute:dp_1", status: "kept_removed", snapshot: [{ entitlement: "pro", expires_at: "2027-03-01T00:00:00Z" }], case_id: "CASE-0051", created_at: "2026-11-01T00:00:00Z" },
  ],
};

const passkeys = [
  { id: "pk_1", name: "Mac · Safari", created_at: "2026-11-01T10:00:00Z", last_used_at: "2026-11-04T09:00:00Z" },
  { id: "pk_2", name: "A passkey with a rather long name for the edge", created_at: "2026-11-02T10:00:00Z", last_used_at: null },
];

const ROUTES: Record<string, (path: string) => unknown> = {
  "GET /v1/admin/runs/c_7Hk2Qm": () => ({
    run: { id: "c_7Hk2Qm", uid: "uid_123", project_id: "p1", status: "SUCCEEDED", created_at: "2026-11-03T21:40:00Z", amount_cents: 4972, currency: "usd", kind: "lifelike", method: "card" },
  }),
  "GET /v1/admin/grants": () => ({
    grants: [
      { id: "gr_1", uid: "uid_123", email: "jane@example.com", kind: "pro", granted_by: "owner@example.com", start: "2026-11-04T10:00:00Z", end: "2026-12-04T10:00:00Z", status: "active", reason: "creator partnership" },
      { id: "gr_0", uid: "uid_456", email: "app.user@example.com", kind: "business", granted_by: "owner@example.com", start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z", status: "expired", reason: "conference speaker" },
    ],
  }),
  "GET /v1/admin/efws": () => ({
    efws: [
      { id: "issfr_1", uid: "uid_123", charge: "ch_1", payment_intent: "pi_1", amount_cents: 8900, created: "2026-11-04T01:00:00Z", case_id: "CASE-0042" },
      { id: "issfr_2", uid: "uid_456", charge: null, payment_intent: "pi_2", amount_cents: 1198800, created: "2026-11-03T01:00:00Z", case_id: null },
    ],
  }),
  "GET /v1/admin/accounts": () => ({ accounts: [{ uid: "uid_123", email: "jane@example.com", created_at: "2026-07-12T00:00:00Z", plan: "business" }] }),
  "GET /v1/admin/cases": () => casesResponse,
  "GET /v1/admin/cases/CASE-0042": () => casePage(),
  "GET /v1/admin/cases/CASE-0051": () => casePage({ max_refundable_cents: 0, actions: ["accept_dispute", "counter_dispute", "note", "close"] }, { id: "CASE-0051", type: "dispute", reason: "dispute" }),
  "GET /v1/admin/mail-previews": () => mailPreviews,
  "GET /v1/admin/disputes/summary": () => ({ ...disputes, open_efws: 1 }),
  "GET /v1/admin/accounts/uid_123": () => account,
  "GET /v1/admin/passkeys": () => ({ passkeys }),
  "GET /v1/admin/passkey-adoption": () => ({
    accounts_with_passkey: 41,
    passkeys: 57,
    sign_ins: { "7d": { passkey: 120, password: 30, google: 210 }, "30d": { passkey: 430, password: 160, google: 900 } },
    generated_at: "2026-11-04T00:00:00Z",
  }),
  "GET /v1/admin/plans/surfaces": () => ({
    days: 7,
    generated_at: "2026-11-04T00:00:00Z",
    placements: [],
    unattributed: { conversions: 2, by_product: { business: 1, pro: 1 } },
    by_reason: [],
    starts: [
      { uid: "uid_123", email: "jane@example.com", product: "business", plan: "business_monthly", source: "checkout", price_cents: 29900, started_at: "2026-11-04T08:00:00Z", placement: "quote" },
      { uid: "uid_456", email: "app.user@example.com", product: "pro", plan: null, source: "app_store", price_cents: null, started_at: "2026-11-03T08:00:00Z", placement: null },
    ],
  }),
  "GET /v1/admin/feedback": () => ({ days: 30, items: [] }),
  "GET /v1/admin/onboarding/headsets": () => ({ days: 90, generated_at: "2026-11-04T00:00:00Z" }),
  "GET /v1/admin/onboarding/business_funnel": () => ({ days: 90, generated_at: "2026-11-04T00:00:00Z" }),
};

export const mockFetch: typeof fetch = async (input, init) => {
  const u = new URL(String(input));
  const key = `${init?.method ?? "GET"} ${u.pathname}`;
  const h = ROUTES[key];
  await new Promise((r) => setTimeout(r, 30));
  if (!h) return new Response(JSON.stringify({ error: "not_found", message: `no mock for ${key}` }), { status: 404 });
  return new Response(JSON.stringify(h(u.pathname + u.search)), { status: 200, headers: { "Content-Type": "application/json" } });
};
