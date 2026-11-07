/**
 * MSW handlers — a stateful in-memory gateway seeded from REAL API fixtures
 * (web/fixtures/, captured from the test deployment; see build_fixtures.py).
 *
 * The mock implements the same rules as the gateway (scene-cut validation,
 * version conflicts, step templates, quote math with the default rates) so
 * screen tests exercise real binding behavior, not happy-path stubs.
 *
 * Lifecycle simulation: conversions auto-advance one state per GET poll
 * (created→[after mock payment]→paid→processing→succeeded), so polling UIs
 * can be tested deterministically: each refetch moves the world forward.
 * Tests can also force any state via mockDb.setConversionState(). The free
 * profile job (POST .../profile) advances the same way: project GET #1
 * moves its progress, GET #2 completes it and folds a cuts-derived
 * scene_profile into the project.
 */

import { HttpResponse, http } from "msw";

import downloadsFixture from "../../fixtures/downloads_succeeded.json";
import projectFixture from "../../fixtures/project.json";
import sceneProfileFixture from "../../fixtures/scene_profile.json";
import { isTeamPlan } from "@/lib/api/types";
import type { CompanyDetails } from "@/lib/api/types";
import type {
  BillingCard,
  Format,
  SavedMethod,
  AccountPlan,
  Conversion,
  Method,
  Preset,
  ProfileShot,
  Project,
  SceneOverride,
  SceneProfile,
  ShotType,
  Step,
  StepConversionRequest,
  UnpaidCharge,
  PendingBatch,
} from "@/lib/api/types";
import { depthContentDims } from "@/lib/depthRes";
import { deriveCnGatewayUrl } from "@/lib/region";
import { POLL_INTERVAL_MS } from "@/components/steps/polling";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
/** China mode's gateway host (lib/region.ts); the auth routes answer on both. */
const GATEWAY_CN =
  process.env.NEXT_PUBLIC_GATEWAY_CN_URL ?? deriveCnGatewayUrl(GATEWAY);

// Default rates — keep in sync with gateway/internal/pricing/pricing.go.
// The per-minute tables are ≈1× BILLED Modal cost; every quote multiplies
// by costMarginMultiplier (the ONE margin knob — 3× so failed/canceled
// runs, which are never charged, don't eat the margin).
const RATES = {
  costMarginMultiplier: 3,
  centsPerMinute: { draft: 120, "1080p": 150, qhd: 210, "3k": 240, "4k": 300 },
  stepCentsPerMinute: { depth_preview: 75 },
  // per-preset stereo preview COST (splatted baseline; ×1.6 inpaint on
  // top) — mirrors the gateway's StereoPreviewCentsPerMinute map
  stereoPreviewCentsPerMinute: {
    draft: 90,
    "1080p": 120,
    qhd: 160,
    "3k": 200,
    "4k": 250,
  } as Record<string, number>,
  /** S3D-17: every paid run costs at least $1, previews included */
  minimumCents: 100,
  previewMinimumCents: 100,
  discountThresholdCents: 1000,
  discountPct: 0.1,
  stageShares: { depth: 0.35, preprocess: 0.05 },
  analyzeCreditCents: 0, // analysis is free outright (gateway default 0 since 2026-08-31)
  depthResBase: 980,
  depthFactorCeiling: 5.0,
  fpsBase: 24,
};

/** Lifelike's own PRICE table (not cost × margin), per output minute at
 * 24 fps — mirrors the gateway's lifelike_price_cents_per_minute. No depth,
 * edge or reuse factors; the bulk discount and the minimum still apply.
 * lifelike_preview is priced from the same table. */
const LIFELIKE = {
  // S3D-11 final owner prices (the gateway's table is authoritative)
  priceCentsPerMinute: {
    "1080p": 300,
    qhd: 450,
    "3k": 700,
    "4k": 850,
    "5k": 1300,
    "6k": 1600,
    "8k": 2200,
  } as Record<
    string,
    number
  >,
  /** short side per eye of each preset; above the source → 400 */
  presetShortSide: {
    "1080p": 1080,
    qhd: 1440,
    "3k": 1620,
    "4k": 2160,
    "5k": 2880,
    "6k": 3240,
    "8k": 4320,
  } as Record<
    string,
    number
  >,
  formats: ["mvhevc", "sbs", "half_sbs"],
  /** Classic-only knobs → 400 on lifelike requests */
  classicOnly: [
    "depth_res",
    "depth_scale",
    "inpaint",
    "warp",
    "scene_overrides",
    "use_uploaded_depth",
    "displacement",
  ],
  maxPreviewSeconds: 10,
  /** split_suggested above this output length */
  splitSuggestSeconds: 900,
  /** ETA model: (530 × output minutes) / gpus + encode tail + 45 */
  etaSecondsPerOutputMinute: 530,
  gpus: 4,
  encodeTailPerFrame: { "1080p": 0.035, qhd: 0.067, "3k": 0.087, "4k": 0.13 } as Record<
    string,
    number
  >,
};

/** Pay-as-you-go billing state, mirroring the gateway's GET /v1/billing.
 * Seeded WITH a card for tests (an already-onboarded user); the browser
 * worker boots without one so local dev exercises the onboarding flow. */
interface MockBilling {
  hasPaymentMethod: boolean;
  card?: BillingCard;
  /** S3D-60/62: saved payment methods; the default card mirrors `card` */
  methods: SavedMethod[];
  /** succeeded conversions whose automatic charge failed (delinquency) */
  unpaid: UnpaidCharge[];
  /** what the next POST /v1/billing/settle attempt does (tests) */
  settleOutcome: "success" | "requires_action" | "declined";
  /** when true, the NEXT conversion success fails its automatic charge —
   * exercising the delinquency banner/settle flow end-to-end */
  nextChargeFails: boolean;
  /** quotes at/above this get an up-front hold, mirroring the gateway's
   * holdThresholdCents (api/billing.go). Tests lower it to force the hold
   * path on cheap fixtures. */
  holdThresholdCents: number;
  /** the NEXT hold demands 3DS: conversion returns state=created +
   * requires_action; __mock__/complete-3ds flips it to paid */
  nextHoldRequiresAction: boolean;
  /** the NEXT hold is declined: create 402s with card_declined */
  nextHoldFails: boolean;
  /** the open billing batch (succeeded cheap steps accumulate here and
   * are charged as one payment at the cap or via pay-now) */
  pending: PendingBatch | null;
  /** batch cap for this account, mirroring the gateway's base tier */
  batchCapCents: number;
  /** spec v6 C13: the account is under review (P9) */
  underReview: boolean;
  /** spec v6 C10: a settle payment is in progress (P9 "Confirming…") */
  settling: boolean;
  /** spec v6: open payments for our sheet, by client_secret */
  checkouts: Map<string, MockCheckout>;
  /** what the next sheet confirm does (tests and the dev preview) */
  nextConfirm: "paid" | "declined" | "processing" | "too_many";
  /** spec v6 B14: an account that hasn't saved or paid (P11) */
  limits?: { projects_left: number; bytes_left: number; reached?: boolean };
  /** spec v6.2 P16 */
  company: CompanyDetails;
  /** gateway ffac292: plan invoices, plan changes and usage credit rows
   * (merged into GET /v1/billing/history) */
  planHistory: Record<string, unknown>[];
  /** tests: extra fields on GET /v1/billing's balance block */
  balanceExtra: Record<string, unknown>;
  /** owner 2026-11-07 (D): what the account owes, being retried */
  duesRetry: import("@/lib/api/types").PaymentRetry | null;
  /** ffa5785: the banner's retry of a failed web group (the groups'
   * own sit on unpaid[].retry) */
  batchRetry: import("@/lib/api/types").PaymentRetry | null;
  /** what the next add-method confirm does */
  nextSetup: "saved" | "declined" | "too_many";
  /** spec v6 F hand-off codes (P7/P8) */
  handoffs: Map<string, { conversion_id: string; state: "open" | "paying" | "paid" | "expired"; expires_at: string }>;
  /** the next GET /v1/handoff answers 429 */
  handoffRateLimited: boolean;
  /** spec v7 N: the prepaid balance */
  prepaid: MockPrepaid;
  /** pricing 2026-11: Business or Studio */
  plan: AccountPlan | null;
  /** 00081: deletion waits for a balance refund; runs and top-ups 403 */
  deletionPending: boolean;
  /** gateway 00166: the 48-hour deletion, when one waits */
  accountDeletion: { delete_after: string; requested_at: string } | null;
  /** 00083: another reason auto-reload can't be turned on */
  autoReloadBlocked: "" | "dispute" | "payment_failed";
  /** 00083: what was added today, against the daily top-up cap */
  topupDayCents: number;
}

/** spec v7 N1, the mock's ledger summary. */
interface MockPrepaid {
  balance_cents: number;
  /** conversion_id → held cents */
  holds: Map<string, number>;
  frozen_cents: number;
  last_topup_at: string | null;
  expired: boolean;
  auto_reload: { enabled: boolean; below_cents: number; add_cents: number; paused_reason?: string };
  spend_limit_cents: number | null;
  month_spent_cents: number;
  low_balance_cents: number;
  entries: { id: string; kind: string; cents: number; at: string; detail?: string; topup_id?: string }[];
  topups: number;
  /** what the next top-up does */
  nextTopup: "paid" | "declined";
}

const BALANCE_LIMITS = { min: 1000, max: 50000, first_max: 10000, day_cap: 100000 };

function prepaidAvailable(): number {
  const pp = mockDb.billing.prepaid;
  let held = 0;
  for (const v of pp.holds.values()) held += v;
  return pp.balance_cents - held - pp.frozen_cents;
}

function prepaidSummary() {
  const pp = mockDb.billing.prepaid;
  let held = 0;
  for (const v of pp.holds.values()) held += v;
  const expires = pp.last_topup_at
    ? new Date(new Date(pp.last_topup_at).setFullYear(new Date(pp.last_topup_at).getFullYear() + 1)).toISOString()
    : null;
  return {
    balance_cents: pp.balance_cents,
    held_cents: held,
    held_runs: pp.holds.size,
    frozen_cents: pp.frozen_cents,
    available_cents: pp.balance_cents - held - pp.frozen_cents,
    expires_at: expires,
    expired: pp.expired,
    never_topped_up: pp.topups === 0,
    auto_reload: pp.auto_reload,
    spend_limit_cents: pp.spend_limit_cents,
    month_spent_cents: pp.month_spent_cents,
    low_balance_cents: pp.low_balance_cents,
    // tests: fields a newer gateway adds (a0efcfa prepaid_*)
    ...mockDb.billing.balanceExtra,
  };
}

/** spec v7 N5/N6: what the balance says about a quote of this amount. */
/** gateway 00166: a quote's pay_split when the account holds credit
 * (tests set mockDb.quoteCreditCents). */
function mockPaySplit(amountCents: number): Record<string, unknown> {
  const credit = mockDb.quoteCreditCents;
  if (credit === null || amountCents <= 0) return {};
  const fromCredit = Math.min(credit, amountCents);
  const card = amountCents - fromCredit;
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  return {
    pay_split: {
      credit_cents: fromCredit,
      balance_cents: 0,
      card_cents: card,
      covered_cents: fromCredit,
      text: card > 0 ? `${usd(fromCredit)} from credit · ${usd(card)} to your card` : `${usd(fromCredit)} from credit`,
    },
  };
}

function balanceQuote(amountCents: number): Record<string, unknown> {
  const pp = mockDb.billing.prepaid;
  const out: Record<string, unknown> = {};
  if (pp.spend_limit_cents !== null && pp.month_spent_cents + amountCents > pp.spend_limit_cents) {
    out.spend_limit_reached = true;
  }
  if (pp.topups === 0 && pp.balance_cents === 0) return out;
  const available = prepaidAvailable();
  if (available >= amountCents) {
    return { ...out, payment_flow: "balance", balance: { available_cents: available, enough: true } };
  }
  if (pp.auto_reload.enabled && !pp.auto_reload.paused_reason && mockDb.billing.hasPaymentMethod) {
    const short = Math.ceil((amountCents - available) / 100) * 100;
    return {
      ...out,
      payment_flow: "balance",
      balance: { available_cents: available, enough: false, reload_cents: Math.max(pp.auto_reload.add_cents, short, 1000) },
    };
  }
  return { ...out, balance: { available_cents: available, enough: false } };
}

/** BUX-25 (proposal): Business billed yearly at 10× its month. */
function businessYearlyMock() {
  const m = TIERS.plans.business;
  return { ...m, interval: "year", price_cents: m.monthly_cents * 10 };
}

/** BUX-23 (gateway 7ab83ee): the bonus a top-up gets, as the gateway
 * reckons it (the highest tier it reaches, pct in (0, 0.5], rounded
 * down); 0 while off ([]). */
function mockTopupBonus(cents: number): number {
  const tier = mockDb.topupBonus
    .filter((x) => cents >= x.min_cents && x.pct > 0 && x.pct <= 0.5)
    .sort((a, b) => b.min_cents - a.min_cents)[0];
  return tier ? Math.floor(cents * tier.pct) : 0;
}

function addTopup(cents: number, kind: "topup" | "auto_reload", detail?: string, topupId?: string) {
  const pp = mockDb.billing.prepaid;
  pp.balance_cents += cents;
  pp.topups += 1;
  pp.expired = false;
  pp.last_topup_at = new Date().toISOString();
  if (pp.auto_reload.paused_reason === "declined") delete pp.auto_reload.paused_reason;
  // REV-14 (gateway 988d6c5): a top-up row names its top-up
  pp.entries.unshift({ id: `be_${pp.entries.length + 1}`, kind, cents, at: pp.last_topup_at, detail, ...(topupId ? { topup_id: topupId } : {}) });
  // N9: what's owed is paid from the balance first
  const b = mockDb.billing;
  const owed = b.unpaid.reduce((n, u) => n + u.amount_cents, 0);
  if (owed > 0 && prepaidAvailable() >= owed) {
    pp.balance_cents -= owed;
    pp.entries.unshift({ id: `be_${pp.entries.length + 1}`, kind: "debt_payment", cents: -owed, at: new Date().toISOString() });
    b.unpaid = [];
  }
}

/** spec v6: one open payment (a run's, or the settle's). */
interface MockCheckout {
  kind: "run" | "settle" | "setup" | "topup" | "plan" | "pay_request";
  /** kind "pay_request": its token */
  token?: string;
  /** kind "plan": business | studio */
  plan?: "business" | "studio";
  /** BUX-25: the yearly Business (plan "business" billed yearly) */
  yearly?: boolean;
  conversion_id?: string;
  /** kind "topup": its top-up (REV-14) */
  topup_id?: string;
  amount_cents: number;
  state: "open" | "paid" | "expired";
  expires_at: string;
}

/** "4K" for the mock's hand-off label. */
function qualityNameMock(preset: string | undefined): string {
  const names: Record<string, string> = { "1080p": "1080p", qhd: "1440p", "3k": "3K", "4k": "4K", "5k": "5K", "6k": "6K", "8k": "8K" };
  return names[preset ?? ""] ?? preset ?? "";
}

/** GET /v1/billing/methods (spec v6.2): backup order, removability. */
function methodsBody() {
  const b = mockDb.billing;
  const lastAndOwed = b.methods.length === 1 && b.unpaid.length > 0;
  return {
    methods: b.methods.map((m) => ({
      ...m,
      removable: !lastAndOwed,
      ...(lastAndOwed
        ? {
            remove_blocked_reason:
              "You can't remove your only payment method while a payment is pending. Pay it or add another one first.",
          }
        : {}),
    })),
    max: 5,
  };
}

/** spec v6 C1: how a run of this price would be paid now. */
function paymentFlow(amountCents: number): {
  payment_flow: "after" | "precharge" | "paynow";
  pay_now_reason?: "no_method";
} {
  if (!mockDb.billing.hasPaymentMethod) return { payment_flow: "paynow", pay_now_reason: "no_method" };
  // the gateway's decideFlow: with deferred payments off, a card pays now
  if (!mockDb.deferredPayments) return { payment_flow: "paynow" };
  return { payment_flow: chargeTiming(amountCents) === "before" ? "precharge" : "after" };
}

/** BUX-20: the mock's one-tap settings (mockDb.oneTap). */
interface MockOneTap {
  enabled: boolean;
  /** over the default card's offer (a Link or wallet default) */
  offer: Partial<import("@/lib/api/types").OneTapOffer>;
  /** what the next tap answers */
  outcome: "succeeded" | "processing" | "requires_action" | "declined";
  /** the next tap answers 409 with this code instead (once) */
  error: { code: string; details?: Record<string, unknown> } | null;
  /** the server's amount when it differs from the run's (amount_changed) */
  serverAmountCents: number | null;
  /** what the bank's check (handleNextAction) answers */
  actionOutcome: "succeeded" | "processing" | "failed";
  /** taps received (no double submit) */
  taps: number;
  /** answer like gateways before one_tap_state (the tap in `state`) */
  legacyState: boolean;
  /** a bank check waiting: on a run or the settle */
  pending: { kind: "run" | "settle"; id: string; amount: number } | null;
}

/** BUX-20: the one-tap offer for an amount, when allowed. */
function oneTapOffer(amountCents: number): import("@/lib/api/types").OneTapOffer | null {
  const o = mockDb.oneTap;
  const card = mockDb.billing.card;
  if (!o.enabled || !mockDb.billing.hasPaymentMethod || amountCents <= 0) return null;
  return {
    brand: card?.brand ?? "visa",
    last4: card?.last4 ?? "4242",
    type: "card",
    ...o.offer,
    amount_cents: amountCents,
    currency: "usd",
  };
}

/** BUX-20: a pay-now quote's offer (the card's part of a split). */
function oneTapQuote(amountCents: number): Record<string, unknown> {
  const flow = { ...paymentFlow(amountCents), ...balanceQuote(amountCents) } as { payment_flow?: string };
  if (flow.payment_flow !== "paynow") return {};
  const split = (mockPaySplit(amountCents).pay_split as { card_cents?: number } | undefined)?.card_cents;
  return { one_tap: oneTapOffer(split ?? amountCents) };
}

/** BUX-20: how the answer says the tap went: one_tap_state (the run's or
 * settle's own state kept), or `state` like gateways before it. */
function tapFields(tap: string, own?: string): Record<string, string> {
  if (mockDb.oneTap.legacyState) return { state: tap };
  return { one_tap_state: tap, ...(own ? { state: own } : {}) };
}

/** BUX-20: a one-tap refusal, like the gateway's (409). */
function oneTapRefusal(): Response | null {
  const e = mockDb.oneTap.error;
  if (!e) return null;
  mockDb.oneTap.error = null;
  return HttpResponse.json({ success: false, error: e.code, message: e.code.replace(/_/g, " "), ...(e.details ? { details: e.details } : {}) }, { status: 409 });
}

/** BUX-20: the run or the settle once a tap (or its bank check) paid. */
function oneTapPaid(kind: "run" | "settle", id: string, amount: number): void {
  if (kind === "run") {
    const c = mockDb.conversions.get(id);
    if (c) {
      c.state = "paid";
      c.billing = { status: "charged", charged_cents: amount };
      c.updated_at = new Date().toISOString();
    }
    return;
  }
  for (const u of mockDb.billing.unpaid) {
    const c = u.conversion_id ? mockDb.conversions.get(u.conversion_id) : undefined;
    if (c) c.billing = { status: "charged", charged_cents: u.amount_cents };
  }
  mockDb.billing.unpaid = [];
}

function openCheckout(c: Omit<MockCheckout, "state" | "expires_at"> & { kind: "run" | "settle" }): {
  client_secret: string;
  expires_at: string;
} {
  const secret = `cs_mock_${c.kind}_${c.conversion_id ?? "settle"}_${Math.random().toString(36).slice(2, 8)}`;
  const expires_at = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  mockDb.billing.checkouts.set(secret, { ...c, state: "open", expires_at });
  return { client_secret: secret, expires_at };
}

/** The live open payment for a run, if one exists. */
function liveCheckout(conversionId: string): string | undefined {
  for (const [secret, c] of mockDb.billing.checkouts) {
    if (c.conversion_id === conversionId && c.state === "open") return secret;
  }
  return undefined;
}

const MOCK_CARD: BillingCard = {
  brand: "visa",
  last4: "4242",
  exp_month: 12,
  exp_year: 2034,
};

/** The mock keeps soft-deleted projects (S3D-24) with this flag. */
type MockProject = Project & { deleted?: boolean };

interface DB {
  projects: Map<string, MockProject>;
  conversions: Map<string, Conversion>;
  idem: Map<string, string>; // Idempotency-Key → conversion_id
  /** per-project analyze lifecycle position (one stage per GET poll) */
  analyzeTicks: Map<string, number>;
  /** per-project free-profile lifecycle position (advances per GET poll) */
  profileTicks: Map<string, number>;
  /** tests: a running free profile stays at 60% until this is false again
   * (several GETs in one poll could otherwise skip the 60% state) */
  profileHold: boolean;
  billing: MockBilling;
  /** per-method source caps (GET /v1/limits methods; 0 = unlimited) */
  methodMaxDurationS: Record<Method, number>;
  /** quotes above this are charged when the run starts (charge_timing
   * "before"), mirroring the gateway's LL-D8 threshold */
  chargeBeforeCents: number;
  /** deferred payments (gateway deferred_payments_enabled): off in the
   * dev mock like staging and prod (every card-paid run pays before it
   * starts, through the pay-now sheet); on in unit tests, which cover the
   * charged-after path */
  deferredPayments: boolean;
  /** GET /v1/pricing adaptive_pricing (owner 2026-11-07): off like prod at
   * launch; tests turn it on */
  adaptivePricing: boolean;
  /** BUX-20 one-tap (gateway one_tap_enabled, off like prod): the offer on
   * pay-now quotes, runs and settles, and what the next tap does */
  oneTap: MockOneTap;
  /** D7 pay requests by token (tests add them); flow: what POST checkout
   * answers */
  payRequests: Map<string, import("@/lib/api/types").PayRequest & { flow: "checkout" | "url"; inProgress?: boolean; todayCents?: number }>;
  /** GET /v1/pricing china_payments: off in the dev mock like the gateway
   * at launch ("coming soon"), on in unit tests (the Alipay paths) */
  chinaPayments: boolean;
  /** GET /v1/pricing web_pro_weekly_hidden (BUX-24 proposal): off
   * everywhere, the mock included; tests turn it on */
  webProWeeklyHidden: boolean;
  /** GET /v1/pricing topup_bonus (BUX-23 proposal): off (null) everywhere,
   * the mock included; tests set the tiers */
  topupBonus: import("@/lib/api/types").TopupBonusTier[];
  /** GET /v1/pricing business_yearly (BUX-25 proposal): off everywhere, the
   * mock included; on, plans.business_yearly is sold at 10× the month */
  businessYearly: boolean;
  /** the NEXT conversion's first poll waits for a free GPU (Classic runs;
   * Lifelike runs always wait one poll) */
  nextWaitsForGpu: boolean;
  /** polls a waiting run stays waiting for a GPU (tests raise it to hold
   * the waiting state, then lower it to let the run go) */
  gpuWaitPolls: number;
  /** GET /v1/limits methods.<m>.available; false → method_unavailable */
  methodAvailable: Record<Method, boolean>;
  /** GET /v1/pricing classic_new_projects (owner 2026-11-04: false) */
  classicNewProjects: boolean;
  /** GET /v1/limits methods.lifelike.foveation (Foveated Detail) */
  lifelikeFoveation: boolean;
  /** S3D-67: quotes say pro true/false; null = the gateway says nothing */
  pro: boolean | null;
  /** tests: GET /v1/billing pro_credit as given (undefined = derived) */
  proCredit?: import("@/lib/api/types").ProCreditStatus | null;
  /** pricing 2026-11 (tiers, add-ons, free previews); off in unit tests
   * so the older price assertions keep their numbers */
  tierPricing: boolean;
  /** the launch offer (gateway 00175): on in the dev mock like TEST, off
   * in unit tests so the older price assertions keep their numbers */
  campaign: boolean;
  /** the methods /v1/pricing's campaign lists (null: no list, Lifelike only) */
  campaignMethods: string[] | null;
  /** tests: fixed alt_prices on every Lifelike quote (null = priced) */
  altPricesFixed: Partial<Record<"pro" | "business" | "studio", number>> | null;
  /** tests: usage credit a quote is paid from first (gateway 00166 pay_split) */
  quoteCreditCents: number | null;
  /** owner 2026-11-04: above 30 fps needs Business or Studio (gateway
   * max_fps / fps_capped / 422 plan_required_fps); off in unit tests */
  fpsCap: boolean;
  /** BL-25: account settings (lifelike_intro_editable follows the plan) */
  accountSettings: {
    lifelike_intro: boolean;
    locale: string | null;
    headsets: string[] | null;
    hints_seen: string[];
    onboarding: { welcome_done?: boolean; checklist_hidden?: boolean; tips_done?: boolean; app_pro_welcome_done?: boolean };
    /** plans surfaces dismissed: placement → time (gateway 00093) */
    dismissed: Record<string, string>;
    /** test only: act as an app Pro subscriber (onboarding variant app_pro) */
    simulate_app_pro?: boolean;
    /** the Business setup's optional answers */
    business_setup?: { team_size?: string; main_use?: string; headsets?: string[] };
  };
  /** the next settings save fails with a 500 */
  nextSettingsFails: boolean;
  /** onboarding (owner 2026-11-04): the sample project for new accounts
   * (seeded on the first project list; off in unit tests) */
  sampleSeeding: boolean;
  sampleSeeded: boolean;
  /** POST /v1/events, newest last */
  events: { name: string; props: Record<string, unknown>; at: string }[];
  /** POST /v1/feedback, newest last (signed_in: a token came with it) */
  feedback: { body: Record<string, unknown>; signed_in: boolean; at: string }[];
  /** GET /v1/pro as the browser mock reports it (null = the default) */
  proStatus: {
    pro: boolean;
    known: boolean;
    source?: string;
    management_url?: string;
    via?: string;
    plan_id?: string;
    scheduled_change?: { to: string; effective_at: string } | null;
  } | null;
  /** the next POST /v1/plans/change answers 409 quote_expired */
  nextChangeExpired: boolean;
  /** ADR 0136: the account's passkeys (cred id = the browser's credential id) */
  passkeys: { id: string; name: string; device_hint: string | null; created_at: string; last_used_at: string | null }[];
  /** ADR 0136: adding a passkey answers 401 reauth_required (sign-in too old) */
  passkeyReauthNeeded: boolean;
  /** owner 2026-11-06: refund requests (gateway efa1856) — what can be
   * asked for, and the account's requests */
  refundOptions: import("@/lib/api/client").RefundOptions;
  /** a gateway before the 2026-11-07 refund policy: deletion refunds the
   * balance first (409 balance_remaining until balance_confirmed) */
  oldDeleteRefund: boolean;
  supportRequests: import("@/lib/api/client").SupportRequest[];
  /** gateway 00152: the account's emails, and addresses other accounts hold */
  accountEmails: import("@/lib/api/client").AccountEmails;
  emailsTakenBy: Map<string, string[]>;
  /** gateway 00152: deleted accounts' plans waiting to be restored, by
   * the email or sign-in that finds them */
  restoreOffers: { emails: string[]; own: boolean; offer: import("@/lib/api/client").RestoreOffer; elsewhere?: string[] }[];
  restoreMoved: string[];
  /** gateway 00155: plans support offered to move to this account */
  planMoves: (import("@/lib/api/client").PlanMoveOffer & { blocker?: string; expired?: boolean })[];
  /** EM-02: GET /v1/account/identities for the mock account */
  identities: { providers: string[]; email: string; password: boolean; other_account?: { email_masked: string; providers: string[]; sign_in_with: string } | null };
  /** EM-02: the next Apple or Google link belongs to another account
   * (409 credential_in_use with these providers) */
  identityInUse: string[] | null;
  /** ADR 0136: refusals the next passkey sign-in checks answer, in order */
  passkeyVerifyErrors: { status: number; code: string }[];
  /** ADR 0137: another format for a finished run: jobs per run, the GETs
   * a job takes to finish, and whether the next ones fail */
  formatJobs: Map<string, Partial<Record<string, { job_id: string; status: string; polls: number; requested_at: string; finished_at: string | null; error?: string; estimated_seconds?: number }>>>;
  formatJobPolls: number;
  formatJobsFail: boolean;
  formatServiceDown: boolean;
  /** GET /v1/events answers 503 (the stream is down; the slow poll fills in) */
  eventsDown: boolean;
  /** status streams open now: while one is, the stream advances runs,
   * analyses and profile jobs, not each GET */
  openStreams: number;
  /** the last event id sent */
  eventSeq: number;
  /** POST /v1/plans/change received */
  planChanges: string[];
  /** the next feedback post fails with this status */
  nextFeedbackStatus: number | null;
  /** 00081: POST /v1/conversions/{id}/plays received */
  plays: { conversion_id: string; file: string; kind: string }[];
  /** free previews used: this period, today, and the intro one */
  freePreviews: { used: number; dayUsed: number; introUsed: boolean };
}

/** Pricing 2026-11 (owner-approved for test, BL-19): per output minute at
 * 24 fps per tier, Classic's tier shares, add-ons, plans, allowances. */
const TIERS = {
  lifelike: {
    // gateway 00166: the Lifelike list prices; Pro 15%, Business 20%,
    // Studio 25% off (the gateway's tables rule)
    list: { "1080p": 400, qhd: 700, "3k": 900, "4k": 1600, "5k": 2800, "6k": 3600, "8k": 6400 },
    pro: { "1080p": 340, qhd: 595, "3k": 765, "4k": 1360, "5k": 2380, "6k": 3060, "8k": 5440 },
    business: { "1080p": 320, qhd: 560, "3k": 720, "4k": 1280, "5k": 2240, "6k": 2880, "8k": 5120 },
    studio: { "1080p": 300, qhd: 525, "3k": 675, "4k": 1200, "5k": 2100, "6k": 2700, "8k": 4800 },
  } as Record<string, Record<string, number>>,
  pct: { pro: 0.15, business: 0.2, studio: 0.25 } as Record<string, number>,
  // gateway 00172: High +30%, Master +50% (File quality, owner 2026-11-07)
  addons: { foveated: 0.3, high: 0.3, master: 0.5, express: 0.5 } as Record<string, number>,
  bulk: { threshold_cents: 5000, pct: 0.1 },
  plans: {
    business: { name: "Business", monthly_cents: 29900, credit_cents: 40000, max_active_runs: 3, free_previews_per_period: 50, express_included: true, max_fps: 120, interval: "month", price_cents: 29900, credit_interval: "month" },
    studio: { name: "Studio", monthly_cents: 99900, credit_cents: 150000, max_active_runs: 8, free_previews_per_period: 200, express_included: true, max_fps: 120, interval: "year", price_cents: 1198800, credit_interval: "month" },
  },
  allowances: { pro_weekly: 5, pro_monthly: 20, pro_yearly: 240, pro_pass_3m: 60, pro_pass_6m: 120, pro_lifetime: 20, business: 50, studio: 200, intro: 1 } as Record<string, number>,
  dailyCap: 20,
  expressMaxWaitS: 420,
};

/** Pricing 2026-11 extras on a Lifelike quote (mirrors projects.go). */
function tierQuoteExtras(
  req: StepConversionRequest,
  q: { quote: Conversion["quote"]; eta: number; outputSeconds: number },
): Record<string, unknown> {
  const bd = (q.quote.breakdown ?? {}) as Record<string, unknown>;
  const tier = mockTier();
  const out: Record<string, unknown> = { tier, discount: bd.discount ?? null };
  if (tier) out.tier_label = TIER_LABEL[tier];
  // projects.go sends free_previews on every quote (units 0 off previews);
  // the intro's free says the first preview is free, whatever the step
  out.free_previews = freePreviewState(req.step === "lifelike_preview" ? ((bd.free_preview_units as number) ?? 1) : 0);
  if (bd.free_preview === true) {
    out.payment_flow = "free_preview";
    out.charge_timing = "before";
    delete out.pay_now_reason;
  }
  if (req.step === "production") {
    // Express: about a minute faster on short clips, up to ~2× on long ones
    const standard = q.eta;
    const express = Math.round(q.outputSeconds >= 180 ? standard * 0.55 : Math.max(standard - 60, standard * 0.7));
    out.express_eta = { eta_seconds: express, standard_eta_seconds: standard, max_wait_seconds: TIERS.expressMaxWaitS };
  }
  return out;
}

/** Plans from highest to lowest (owner 2026-11-04: lower = step-down). */
const PLAN_RANK: Record<string, number> = {
  studio: 40, business_yearly: 35, business: 30, pro_yearly: 23, pro_monthly: 22, pro_weekly: 21, pay_per_video: 0,
};

/** BUX-24/25: a plan its flag doesn't offer now answers 409
 * plan_unavailable {plan}, like the gateway. */
function planUnavailable(plan: string | undefined): Response | null {
  const off = (plan === "pro_weekly" && mockDb.webProWeeklyHidden) || (plan === "business_yearly" && !mockDb.businessYearly);
  if (!off) return null;
  return HttpResponse.json(
    { success: false, error: "plan_unavailable", message: "that plan isn't offered here", details: { plan } },
    { status: 409 },
  );
}

function planTarget(to: string | undefined): { id: string; price: number; interval?: string } | null {
  if (!to) return null;
  if (to === "pay_per_video") return { id: to, price: 0 };
  const pro = MOCK_PRO_PLANS.find((p) => p.id === to);
  if (pro) return { id: to, price: pro.price_cents, interval: pro.interval };
  if (to === "business" || to === "studio") {
    const d = TIERS.plans[to] as { price_cents?: number; monthly_cents: number; interval?: string };
    return { id: to, price: d.price_cents ?? d.monthly_cents, interval: d.interval };
  }
  if (to === "business_yearly") {
    const d = businessYearlyMock();
    return { id: to, price: d.price_cents, interval: "year" };
  }
  return null;
}

/** gateway 00102: web Pro on Stripe has a /v1/billing plan block, and
 * GET /v1/pro says source "plan" with its plan_id. */
function startMockPro(planId: string): void {
  const def = MOCK_PRO_PLANS.find((p) => p.id === planId)!;
  const end = new Date();
  if (def.interval === "year") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else if (def.interval === "week") end.setUTCDate(end.getUTCDate() + 7);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  const name = `Pro ${def.interval === "week" ? "Weekly" : def.interval === "year" ? "Yearly" : "Monthly"}`;
  mockDb.pro = true;
  mockDb.proStatus = {
    pro: true,
    known: true,
    source: "plan",
    plan_id: planId,
    via: planId,
    scheduled_change: null,
  };
  mockDb.billing.plan = {
    plan: "pro",
    plan_id: planId,
    name,
    status: "active",
    active: true,
    cancel_at_period_end: false,
    current_period_end: end.toISOString(),
    interval: def.interval,
    price_cents: def.price_cents,
    scheduled_change: null,
  };
}

/** What the current Business/Studio plan has left (owner 2026-11-04):
 * the share of the period and of this month's usage. */
function creditBasis(): { time_share: number; usage_share: number; paid_cents: number } | null {
  const p = mockDb.billing.plan;
  if (!p?.active || (p.plan !== "business" && p.plan !== "studio")) return null;
  const def = TIERS.plans[p.plan] as { price_cents?: number; monthly_cents: number; interval?: string };
  const paid = def.price_cents ?? def.monthly_cents;
  const end = p.current_period_end ? Date.parse(p.current_period_end) : Date.now();
  const days = def.interval === "year" ? 365 : 30;
  const time = Math.max(0, Math.min(1, (end - Date.now()) / (days * 86_400_000)));
  const usage = p.credit_cents ? Math.max(0, Math.min(1, (p.credit_left_cents ?? 0) / p.credit_cents)) : 1;
  return { time_share: Math.round(time * 10000) / 10000, usage_share: Math.round(usage * 10000) / 10000, paid_cents: paid };
}

/** The account's plan now: Business/Studio, else its web Pro, else none. */
function currentPlanKey(): string {
  if (mockDb.billing.plan?.active)
    return mockDb.billing.plan.plan_id ?? mockDb.billing.plan.plan;
  const via = mockDb.proStatus?.via;
  if (via && via in PLAN_RANK) return via;
  return "pay_per_video";
}

function currentPeriodEnd(): string {
  const end = mockDb.billing.plan?.current_period_end;
  if (end) return end;
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

/** gateway 00101: 409 project_has_active_run */
const ARCHIVE_BLOCKED =
  "This project has a run in progress. Wait for it to finish, or cancel it, before archiving.";

/** Web Pro on Stripe: Weekly $3.99, Monthly $4.99, Yearly $49.99, no
 * intro offers, and $20 of usage credit once when you join (owner
 * 2026-11-07, gateway 00166). */
export const MOCK_PRO_PLANS: {
  id: string;
  interval: "week" | "month" | "year";
  price_cents: number;
  intro: { price_cents: number; cycles: number } | null;
  credit_cents: number;
  credit_interval: "once";
  credit_once: boolean;
}[] = [
  { id: "pro_weekly", interval: "week", price_cents: 399, intro: null, credit_cents: 2000, credit_interval: "once", credit_once: true },
  { id: "pro_monthly", interval: "month", price_cents: 499, intro: null, credit_cents: 2000, credit_interval: "once", credit_once: true },
  { id: "pro_yearly", interval: "year", price_cents: 4999, intro: null, credit_cents: 2000, credit_interval: "once", credit_once: true },
];

/** GET /v1/pricing pro_credit (gateway 00166): $20 once, used within 30
 * days. */
export const MOCK_PRO_CREDIT = {
  cents: 2000,
  cents_by_kind: {
    pro_weekly: 2000, pro_monthly: 2000, pro_yearly: 2000, pro_3m: 2000, pro_6m: 2000,
    pro_pass_3m: 2000, pro_pass_6m: 2000, pro_lifetime: 2000,
  } as Record<string, number>,
  once: true,
  expires_days: 30,
  rollover: false,
  paid_only: true,
  trial_counts: true,
  stacks_with_plan: false,
};

/** gateway 00094: the same Lifelike run on each tier, in cents, without
 * free previews applied. */
function altPrices(project: Project, req: StepConversionRequest): Record<"pro" | "business" | "studio", number> {
  const out = {} as Record<"pro" | "business" | "studio", number>;
  for (const t of ["pro", "business", "studio"] as const) {
    tierOverride = t;
    try {
      const q = lifelikeQuoteFor(project, req).quote;
      out[t] = (q.breakdown?.price_without_free_cents as number | undefined) ?? q.amount_cents;
    } finally {
      tierOverride = null;
    }
  }
  return { ...out, ...(mockDb.altPricesFixed ?? {}) };
}

/** GET /v1/pricing's 2026-11 keys (tiers.go publicTiers). */
function publicTiers(): Record<string, unknown> {
  const periods: Record<string, string> = {
    pro_weekly: "week", pro_monthly: "month", pro_yearly: "year", pro_pass_3m: "pass", pro_pass_6m: "pass",
    pro_lifetime: "month", business: "month", studio: "month",
  };
  return {
    pricing_model: "tiers",
    tiers: {
      order: ["studio", "business", "pro", "list"],
      lifelike_cents_per_minute: TIERS.lifelike,
      classic_pct: TIERS.pct,
    },
    addons: {
      foveated: {
        pct: TIERS.addons.foveated,
        methods: ["lifelike"],
        enabled: mockDb.lifelikeFoveation,
        included_presets: FOVEATION_INCLUDED,
      },
      master: { pct: TIERS.addons.master, methods: ["lifelike", "classic"], request: { quality: "master" } },
      high: { pct: TIERS.addons.high, methods: ["lifelike"], request: { quality: "high" } },
      express: { pct: TIERS.addons.express, methods: ["lifelike"], request: { express: true }, included_in: ["business", "studio"] },
    },
    // gateway 00172: the web's File quality tiers
    quality: {
      tiers: ["standard", "high", "master"],
      default: "standard",
      methods: ["lifelike"],
      standard: { mode: "crf_capped", price_pct: 0 },
      high: { mode: "target", price_pct: TIERS.addons.high },
      master: { mode: "target", price_pct: TIERS.addons.master, bit_depth: 10 },
    },
    discount: { ...TIERS.bulk, stacks_with_tier: false, rule: "a run gets the bigger of bulk and its tier price, never both" },
    // BUX-25 (proposal): Business yearly at 10× its month, only while on
    plans: mockDb.businessYearly ? { ...TIERS.plans, business_yearly: businessYearlyMock() } : TIERS.plans,
    business_yearly: mockDb.businessYearly,
    free_previews: {
      enabled: true,
      allowances: TIERS.allowances,
      periods,
      unit_seconds: 5,
      counts_double: ["5k", "6k", "8k", "60fps"],
      daily_cap: TIERS.dailyCap,
      rollover: false,
    },
  };
}

function accountSettings() {
  const own = [...mockDb.projects.values()].filter((p) => !p.sample);
  const ownIds = new Set(own.map((p) => p.project_id));
  const runs = [...mockDb.conversions.values()].filter(
    (c) => c.state === "succeeded" && c.project_id !== undefined && ownIds.has(c.project_id),
  );
  const st = mockDb.accountSettings;
  return {
    ...st,
    lifelike_intro_editable: isTeamPlan(mockDb.billing.plan),
    simulate_app_pro: st.simulate_app_pro === true,
    onboarding: {
      ...st.onboarding,
      // owner 2026-11-04: app Pro subscribers get their own welcome; the
      // app's headsets come along (the simulation says Vision Pro)
      variant: st.simulate_app_pro ? "app_pro" : "default",
      app_pro_welcome_done: st.onboarding.app_pro_welcome_done === true,
      headsets_from_app: st.simulate_app_pro ? ["avp"] : [],
      headsets_from_app_source: st.simulate_app_pro ? "app_answer" : null,
      app_viewing_device: st.simulate_app_pro ? "apple_vision_pro" : null,
      // the getting-started steps, as the gateway works them out
      steps: {
        first_video: own.length > 0,
        first_preview: runs.some((c) => c.step === "lifelike_preview"),
        first_3d: runs.some((c) => c.step === "production"),
        watched: mockDb.plays.length > 0,
      },
    },
  };
}

/** Onboarding: every new account gets a finished Lifelike sample (Sunset
 * session), never billed, archivable like any project. */
function seedSample(): void {
  if (!mockDb.sampleSeeding || mockDb.sampleSeeded) return;
  mockDb.sampleSeeded = true;
  const p = structuredClone(projectFixture) as unknown as Project;
  const id = "samplesunset";
  const fps = 25;
  const dur = 19.32;
  const poster = "/landing/samples/sunset-session-poster-1600.webp";
  const at = new Date(Date.now() - 3600_000).toISOString();
  Object.assign(p, {
    project_id: id,
    name: "Sunset session",
    sample: true,
    method: "lifelike",
    archived: false,
    created_at: at,
    updated_at: at,
    probe: { ...p.probe!, width: 3840, height: 2160, fps, fps_rational: "25/1", duration_s: dur, num_frames: Math.round(dur * fps) },
    scenes: { ...p.scenes!, cuts: [] },
    scene_thumbs: [{ frame: 0, url: poster }],
    poster: { frame: 0, url: poster },
    strip_thumbs: Array.from({ length: 30 }, (_, k) => ({ frame: Math.round((k * dur * fps) / 30), url: poster })),
    summary: { latest_state: "succeeded", latest_step: "production", spent_cents: 0 },
  });
  mockDb.projects.set(id, p);
  const conversion = {
    conversion_id: "samplesunset-3d",
    project_id: id,
    step: "production",
    method: "lifelike",
    state: "succeeded",
    params: { preset: "4k", formats: ["mvhevc", "sbs"] },
    quote: { amount_cents: 0, currency: "usd", breakdown: { billable_seconds: dur, billable_minutes: 1 } },
    outputs: ["mvhevc", "sbs"],
    created_at: at,
    updated_at: at,
    billing: { status: "not_charged" },
  } as unknown as Conversion;
  mockDb.conversions.set(conversion.conversion_id, conversion);
}

/** The account's tier: an active Business/Studio plan, else Pro, else list. */
/** The output frame rate this account may choose: 120 with Business or
 * Studio, 30 otherwise; null with the cap off (older gateways). */
function mockMaxFps(): number | null {
  if (!mockDb.fpsCap) return null;
  const t = mockTier();
  return t === "business" || t === "studio" ? 120 : 30;
}

/** The gateway's choices (fps_cap.go fpsChoices): whole divisions of the
 * source at or under max, down to about 10 fps, three decimals. */
function fpsDivisions(src: number, max = Infinity): number[] {
  const out: number[] = [];
  for (let n = 1; n <= 12; n++) {
    const v = Math.round((src / n) * 1000) / 1000;
    if (v > max * 1.0005) continue;
    if (v < 10 && out.length > 0) break;
    out.push(v);
  }
  return out;
}

/** The gateway's frame-rate fields for a quote (owner 2026-11-04). */
function fpsPolicy(p: Project, target: number | undefined) {
  const src = p.probe!.fps;
  const max = mockMaxFps();
  if (max === null) return { effective: target ?? src, extras: {} };
  const allowed = fpsDivisions(src, max);
  const capped = target === undefined && src > max * 1.0005;
  const effective = target ?? (capped ? (allowed[0] ?? max) : src);
  return {
    effective,
    capped,
    // the quote's frame-rate block (fps_cap.go fpsInfo)
    extras: {
      fps: {
        max_fps: max,
        source_fps: src,
        target_fps_choices: allowed,
        fps_capped: capped,
        ...(capped ? { reason: "plan_required_above_30fps" } : {}),
        target_fps: effective,
      },
    },
  };
}

/** set while pricing the same run on another tier (alt_prices) */
let tierOverride: "pro" | "business" | "studio" | null = null;

function mockTier(): "" | "pro" | "business" | "studio" {
  if (tierOverride) return tierOverride;
  const plan = mockDb.billing.plan;
  if (plan?.active) return plan.plan;
  return mockDb.pro ? "pro" : "";
}

const TIER_LABEL: Record<string, string> = { pro: "Pro", business: "Business", studio: "Studio" };

/** Free previews left (Lifelike previews), for a preview of `units`. */
function freePreviewState(units: number) {
  const fp = mockDb.freePreviews;
  const tier = mockTier();
  const key = tier === "business" || tier === "studio" ? tier : tier === "pro" ? "pro_monthly" : "intro";
  const allowance = TIERS.allowances[key];
  const dayLeft = Math.max(TIERS.dailyCap - fp.dayUsed, 0);
  if (key === "intro") {
    const used = fp.introUsed ? allowance : 0;
    const remaining = allowance - used;
    return { allowance, used, remaining, daily_left: dayLeft, units, free: remaining > 0 && dayLeft >= 1, intro: true, period: "first_project" };
  }
  const remaining = Math.max(allowance - fp.used, 0);
  const end = new Date();
  end.setUTCMonth(end.getUTCMonth() + 1, 1);
  end.setUTCHours(0, 0, 0, 0);
  return {
    allowance,
    used: fp.used,
    remaining,
    daily_left: dayLeft,
    units,
    free: units > 0 && remaining >= units && dayLeft >= units,
    intro: false,
    period: "month",
    resets_at: end.toISOString(),
  };
}

/** One per 5 s started, doubled for 5K-8K and 60 fps. */
function previewUnits(preset: string, seconds: number, fps: number): number {
  let n = Math.max(Math.ceil(seconds / 5 - 1e-9), 1);
  if (["5k", "6k", "8k"].includes(preset) || fps >= 50) n *= 2;
  return n;
}

/** The gateway's composeTier: add-ons on each base, the one discount
 * that gives the lowest price (tier or bulk, never both). */
function composeTier(listBase: number, tierBase: number, tier: string, addOns: string[], bulkAllowed: boolean) {
  const adds: Record<string, number> = {};
  let pct = 0;
  for (const a of addOns) {
    pct += TIERS.addons[a];
    adds[a] = Math.round(listBase * TIERS.addons[a]);
  }
  const withAdds = (b: number) => b + Math.round(b * pct);
  const listTotal = withAdds(listBase);
  let final = listTotal;
  let kind: "" | "tier" | "bulk" = "";
  let dpct = 0;
  if (tier && tierBase < listBase && withAdds(tierBase) < final) {
    final = withAdds(tierBase);
    kind = "tier";
    dpct = TIERS.pct[tier];
  }
  if (bulkAllowed && listTotal > TIERS.bulk.threshold_cents) {
    const b = listTotal - Math.round(listTotal * TIERS.bulk.pct);
    if (b < final) {
      final = b;
      kind = "bulk";
      dpct = TIERS.bulk.pct;
    }
  }
  return { adds, listTotal, final, kind, dpct, cents: listTotal - final };
}

/** S3D-67: the mock's Pro share (the gateway's config is authoritative). */
const MOCK_PRO = { pct: 0.2, applies_to: "production" };
/** the Pro share /v1/pricing reports: 15% under the 2026-11 tiers */
function mockProPct(): number {
  return mockDb.tierPricing ? TIERS.pct.pro : MOCK_PRO.pct;
}

/** gateway plans_surfaces.go plansPlacements */
const PLANS_PLACEMENTS = ["header", "projects_banner", "quote", "receipt", "plans_sheet", "business_note", "business_banner", "plans_hint"];

const VITEST_MOCK = typeof process !== "undefined" && !!process.env?.VITEST;
const ALL_HINTS = ["billing", "usage", "invoices", "plans", "pricing", "pro", "account", "devices", "scenes"];

function seed(): DB {
  const project = structuredClone(projectFixture) as unknown as Project;
  // real captures predate project management — the gateway now always sends
  // archived (and pinned when true), so default them here, not in fixtures
  project.archived = false;
  return {
    projects: new Map([[project.project_id, project]]),
    conversions: new Map(),
    idem: new Map(),
    analyzeTicks: new Map(),
    profileTicks: new Map(),
    profileHold: false,
    billing: {
      hasPaymentMethod: true,
      card: { ...MOCK_CARD },
      methods: [{ id: "pm_mock_4242", type: "card", ...MOCK_CARD, is_default: true }],
      unpaid: [],
      settleOutcome: "success",
      nextChargeFails: false,
      holdThresholdCents: 10000,
      nextHoldRequiresAction: false,
      nextHoldFails: false,
      pending: null,
      batchCapCents: 5000,
      underReview: false,
      settling: false,
      checkouts: new Map(),
      nextConfirm: "paid",
      company: {},
      planHistory: [],
      balanceExtra: {},
      duesRetry: null,
      batchRetry: null,
      nextSetup: "saved",
      handoffs: new Map(),
      handoffRateLimited: false,
      prepaid: {
        balance_cents: 0,
        holds: new Map(),
        frozen_cents: 0,
        last_topup_at: null,
        expired: false,
        auto_reload: { enabled: false, below_cents: 1000, add_cents: 2500 },
        spend_limit_cents: null,
        month_spent_cents: 0,
        low_balance_cents: 500,
        entries: [],
        topups: 0,
        nextTopup: "paid",
      },
      plan: null,
      deletionPending: false,
      accountDeletion: null,
      autoReloadBlocked: "",
      topupDayCents: 0,
    },
    methodMaxDurationS: { lifelike: 0, classic: 600 },
    chargeBeforeCents: 2500,
    deferredPayments: typeof process !== "undefined" && !!process.env?.VITEST,
    adaptivePricing: false,
    oneTap: {
      enabled: false,
      offer: {},
      outcome: "succeeded",
      error: null,
      serverAmountCents: null,
      actionOutcome: "succeeded",
      taps: 0,
      legacyState: false,
      pending: null,
    },
    payRequests: new Map(),
    chinaPayments: typeof process !== "undefined" && !!process.env?.VITEST,
    webProWeeklyHidden: false,
    topupBonus: [],
    businessYearly: false,
    nextWaitsForGpu: false,
    methodAvailable: { lifelike: true, classic: true },
    classicNewProjects: false,
    lifelikeFoveation: false,
    pro: null,
    proCredit: undefined,
    tierPricing: !(typeof process !== "undefined" && process.env?.VITEST),
    campaign: !(typeof process !== "undefined" && process.env?.VITEST),
    campaignMethods: null as string[] | null,
    altPricesFixed: null as Partial<Record<"pro" | "business" | "studio", number>> | null,
    quoteCreditCents: null as number | null,
    fpsCap: !(typeof process !== "undefined" && process.env?.VITEST),
    freePreviews: { used: 0, dayUsed: 0, introUsed: false },
    plays: [],
    // unit tests start as an account that has seen the welcome, tips and
    // hints (onboarding tests clear these); the browser mock starts new
    accountSettings: VITEST_MOCK
      ? { lifelike_intro: true, locale: null, headsets: null, hints_seen: ALL_HINTS, onboarding: { welcome_done: true, tips_done: true, checklist_hidden: true }, dismissed: {} }
      : { lifelike_intro: true, locale: null, headsets: null, hints_seen: [], onboarding: {}, dismissed: {} },
    nextSettingsFails: false,
    sampleSeeding: !(typeof process !== "undefined" && process.env?.VITEST),
    sampleSeeded: false,
    events: [],
    feedback: [],
    proStatus: null as typeof mockDb.proStatus,
    planChanges: [] as string[],
    nextChangeExpired: false,
    passkeys: [] as typeof mockDb.passkeys,
    passkeyReauthNeeded: false,
    identities: { providers: ["email"], email: "dev@example.com", password: false },
    refundOptions: { window_days: 30, plan: null, runs: [] } as import("@/lib/api/client").RefundOptions,
    oldDeleteRefund: false,
    accountEmails: {
      emails: [{ id: "em_dev", email: "dev@example.com", main: true, relay: false, added_at: "2026-10-01T00:00:00Z" }],
      plan_email_needed: false,
    } as import("@/lib/api/client").AccountEmails,
    emailsTakenBy: new Map<string, string[]>(),
    restoreOffers: [] as typeof mockDb.restoreOffers,
    restoreMoved: [] as string[],
    planMoves: [] as typeof mockDb.planMoves,
    supportRequests: [] as import("@/lib/api/client").SupportRequest[],
    identityInUse: null as string[] | null,
    passkeyVerifyErrors: [] as { status: number; code: string }[],
    formatJobs: new Map() as typeof mockDb.formatJobs,
    formatJobPolls: 1,
    formatJobsFail: false,
    formatServiceDown: false,
    eventsDown: false,
    openStreams: 0,
    eventSeq: 0,
    nextFeedbackStatus: null as number | null,
    gpuWaitPolls: 1,
  };
}

export const mockDb = {
  ...seed(),
  reset() {
    closeMockStreams();
    // every field the seed has (CI 2026-11-07: a hand-kept list missed
    // quoteCreditCents and proCredit, so a credit test leaked "Paid from
    // your credit" into the next test in shuffled order)
    Object.assign(this, seed());
    mockAuth.reset();
  },
  setConversionState(id: string, state: Conversion["state"]) {
    const c = this.conversions.get(id);
    if (!c) throw new Error(`no mock conversion ${id}`);
    c.state = state;
    if (state === "succeeded") {
      c.progress = 1;
      succeed(c);
    }
    if (
      (state === "failed" || state === "canceled") &&
      c.charge_timing === "before"
    ) {
      // pre-charged: a charged run is refunded in full, an unconfirmed one
      // was never charged
      c.billing = {
        status: c.billing?.status === "charged" ? "refund_pending" : "not_charged",
      };
    }
  },
  /** Fail a succeeded conversion's automatic charge (delinquency setup). */
  failCharge(id: string) {
    const c = this.conversions.get(id);
    if (!c) throw new Error(`no mock conversion ${id}`);
    c.billing = { status: "charge_failed" };
    this.billing.unpaid.push({
      conversion_id: c.conversion_id,
      step: c.step,
      amount_cents: c.quote.amount_cents,
      currency: c.quote.currency,
      needs_action: false,
    });
  },
};

/** The layout marker in a mock file name (the gateway owns the real
 * ones; these follow the design mocks). */
const MOCK_LAYOUT_MARKERS: Record<string, string> = {
  mvhevc: "spatial",
  sbs: "SBS",
  half_sbs: "Half-SBS",
};

/** ADR 0137: what a finished run can still get; `advance` moves running
 * jobs on (one GET at a time, like a poll). */
function runFormats(c: Conversion, advance: boolean) {
  const base = (n: string) => n.replace(/_part\d+$/, "");
  const have = [...new Set((c.outputs ?? []).map(base))].filter((f) => ["mvhevc", "sbs", "half_sbs", "anaglyph"].includes(f));
  const jobs = mockDb.formatJobs.get(c.conversion_id) ?? {};
  if (advance) {
    for (const [fmt, j] of Object.entries(jobs)) {
      if (!j || j.status === "succeeded" || j.status === "failed") continue;
      j.polls += 1;
      j.status = "processing";
      if (j.polls >= mockDb.formatJobPolls) {
        j.finished_at = new Date().toISOString();
        if (mockDb.formatJobsFail) {
          j.status = "failed";
          j.error = "repack failed";
        } else {
          j.status = "succeeded";
          // a split run gets one file per part, like its own part files
          c.outputs = [
            ...(c.outputs ?? []),
            ...(c.parts && c.parts.length > 1
              ? c.parts.map((p) => `${fmt}_part${String(p.index).padStart(2, "0")}`)
              : [fmt]),
          ];
          have.push(fmt);
        }
      }
    }
  }
  const pending = Object.entries(jobs)
    .filter(([, j]) => j && (j.status === "pending" || j.status === "processing"))
    .map(([f]) => f);
  const project = c.project_id ? mockDb.projects.get(c.project_id) : undefined;
  let reason: string | null = null;
  if (c.state !== "succeeded") reason = "run_failed";
  else if (project?.files_deleted_at) reason = "files_erased";
  else if (c.method !== "lifelike") reason = "classic_retired";
  // only the half-size file: nothing full-size to make others from
  else if (have.length === 1 && have[0] === "half_sbs") reason = "half_only";
  const offered = ["6k", "8k"].includes(c.params.preset ?? "") ? ["mvhevc", "half_sbs"] : ["mvhevc", "sbs", "half_sbs"];
  const available = reason ? [] : offered.filter((f) => !have.includes(f) && !pending.includes(f));
  return {
    available,
    have,
    pending,
    ...(reason ? { unavailable_reason: reason } : {}),
    price_cents: 0,
    jobs: Object.fromEntries(
      Object.entries(jobs).map(([f, j]) => [
        f,
        { job_id: j!.job_id, status: j!.status, source: "repack", price_cents: 0, requested_at: j!.requested_at, finished_at: j!.finished_at, ...(j!.error ? { error: j!.error } : {}), ...(j!.estimated_seconds ? { estimated_seconds: j!.estimated_seconds } : {}) },
      ]),
    ),
  };
}

/** The passkey relying party in the browser mock: this page's host. */
function mockRpId(): string {
  return typeof window !== "undefined" && window.location?.hostname ? window.location.hostname : "localhost";
}

function err(status: number, code: string, message: string) {
  return HttpResponse.json(
    { success: false, error: code, message },
    { status },
  );
}

// ---------------------------------------------------------- gateway auth

/** Accounts behind the mock /v1/auth/* routes (China mode sign-in),
 * mirroring gateway/internal/identity: same answers, same error codes.
 * Seeded with dev@example.com; the email code is always MOCK_EMAIL_CODE
 * (owner 2026-11-06: no passwords on the web). */
interface MockAuthUser {
  uid: string;
  email: string;
  displayName: string | null;
}

export const MOCK_EMAIL_CODE = "123456";

export const mockAuth = {
  users: new Map<string, MockAuthUser>(),
  /** refresh token → uid; revoke one to exercise a refused refresh */
  refreshTokens: new Map<string, string>(),
  issued: 0,
  /** addresses a code was mailed to, oldest first */
  codesSent: [] as string[],
  /** each code mail's language, as asked (null when none was sent) */
  codeLanguages: [] as (string | null)[],
  reset() {
    this.users = new Map([
      [
        "dev@example.com",
        {
          uid: "dev-user",
          email: "dev@example.com",
          displayName: "Dev User",
        },
      ],
    ]);
    this.refreshTokens = new Map();
    this.issued = 0;
    this.codesSent = [];
    this.codeLanguages = [];
  },
};
mockAuth.reset();

function authSession(u: MockAuthUser) {
  const n = ++mockAuth.issued;
  const refreshToken = `mock-refresh-${n}`;
  mockAuth.refreshTokens.set(refreshToken, u.uid);
  return {
    uid: u.uid,
    email: u.email,
    display_name: u.displayName ?? "",
    id_token: `mock-id-${n}`,
    refresh_token: refreshToken,
    expires_in: 3600,
  };
}

function identitiesJSON() {
  const ids = mockDb.identities;
  return {
    providers: ids.providers,
    email: ids.email,
    email_verified: ids.email !== "",
    password: ids.password,
    passkeys: mockDb.passkeys.length,
    anonymous: ids.providers.length === 0 && mockDb.passkeys.length === 0,
    other_account: ids.other_account ?? null,
  };
}

function authHandlers(base: string) {
  const emailOf = async (request: Request) => {
    const body = (await request.json().catch(() => ({}))) as {
      email?: string;
      code?: string;
      session?: boolean;
      language?: unknown;
    };
    return { ...body, email: (body.email ?? "").trim().toLowerCase() };
  };
  return [
    http.post(`${base}/v1/auth/email/start`, async ({ request }) => {
      const { email, language } = await emailOf(request);
      if (!email.includes("@")) {
        return err(400, "invalid_email", "that email address is not valid");
      }
      // gateway 00145: the mail's language, BCP-47 (zh-Hans for China)
      if (language !== undefined && (typeof language !== "string" || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language))) {
        return err(400, "invalid_request", "language must be a BCP-47 tag");
      }
      mockAuth.codesSent.push(email);
      mockAuth.codeLanguages.push(language ?? null);
      return HttpResponse.json({ resend_after: 30 });
    }),
    http.post(`${base}/v1/auth/email/verify`, async ({ request }) => {
      const { email, code, session } = await emailOf(request);
      if (!mockAuth.codesSent.includes(email)) {
        return err(400, "code_expired", "that code has expired; ask for a new one");
      }
      if (code !== MOCK_EMAIL_CODE) {
        return HttpResponse.json(
          { success: false, error: "code_invalid", message: "that code isn't right", details: { attempts_left: 4 } },
          { status: 400 },
        );
      }
      let u = mockAuth.users.get(email);
      const isNew = u === undefined;
      if (!u) {
        u = { uid: `mock-uid-${mockAuth.users.size + 1}`, email, displayName: null };
        mockAuth.users.set(email, u);
      }
      return HttpResponse.json(
        session
          ? { ...authSession(u), is_new_user: isNew }
          : { uid: u.uid, custom_token: `mock-custom-${u.uid}`, is_new_user: isNew },
      );
    }),
    http.post(`${base}/v1/auth/refresh`, async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as {
        refresh_token?: string;
      };
      const uid = mockAuth.refreshTokens.get(body.refresh_token ?? "");
      const u = [...mockAuth.users.values()].find((x) => x.uid === uid);
      if (!u) {
        return err(
          401,
          "invalid_refresh_token",
          "your session has expired; sign in again",
        );
      }
      return HttpResponse.json(authSession(u));
    }),
    http.post(`${base}/v1/auth/profile`, async ({ request }) => {
      const auth = request.headers.get("Authorization") ?? "";
      if (!auth.startsWith("Bearer ")) {
        return err(401, "invalid_token", "invalid or expired authentication token");
      }
      const body = (await request.json().catch(() => ({}))) as {
        display_name?: string;
      };
      const name = (body.display_name ?? "").trim();
      if (!name) {
        return err(400, "invalid_request", "display_name must be 1–120 characters");
      }
      // The mock can't read a uid out of its tokens: the seeded user.
      const u = mockAuth.users.get("dev@example.com")!;
      u.displayName = name;
      return HttpResponse.json(authSession(u));
    }),
  ];
}

let nextId = 1;
// ------------------------------------------------------- resumable uploads

/** Resumable upload sessions behind the mock POST /v1/uploads
 * {resumable: true}, answering PUTs like the storage session does:
 * Content-Range "bytes a-b/*" → 308 with Range, the last chunk
 * "bytes a-b/total" → 200, an empty "bytes * /total" → where it stands.
 * failNext makes the next n chunk PUTs fail with 503 (the bytes are
 * dropped), to exercise the client's retry and resume. */
interface MockUploadSession {
  gcsKey: string;
  bytes: number;
  total: number | null;
  done: boolean;
  chunks: number;
  statusChecks: number;
}

export const mockUploads = {
  sessions: new Map<string, MockUploadSession>(),
  failNext: 0,
  reset() {
    this.sessions = new Map();
    this.failNext = 0;
  },
};

/** Range, exposed to cross-origin readers as the bucket's CORS does. */
function sessionRange(s: MockUploadSession): Record<string, string> {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Range, Content-Range",
  };
  return s.bytes > 0 ? { ...cors, Range: `bytes=0-${s.bytes - 1}` } : cors;
}

async function resumablePut(request: Request, id: string): Promise<Response> {
  const s = mockUploads.sessions.get(id);
  if (!s) return new HttpResponse(null, { status: 404 });
  const header = request.headers.get("Content-Range") ?? "";
  const status = /^bytes \*\/(\d+|\*)$/.exec(header);
  if (status) {
    s.statusChecks++;
    if (s.done) return new HttpResponse(null, { status: 200 });
    return new HttpResponse(null, { status: 308, headers: sessionRange(s) });
  }
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header);
  if (!m) return new HttpResponse(null, { status: 400 });
  const body = await request.arrayBuffer();
  if (mockUploads.failNext > 0) {
    mockUploads.failNext--;
    return new HttpResponse(null, { status: 503 });
  }
  const [start, end] = [Number(m[1]), Number(m[2])];
  if (start !== s.bytes || end - start + 1 !== body.byteLength) {
    // Out of order or short: keep what it has, say where it stands.
    return new HttpResponse(null, { status: 308, headers: sessionRange(s) });
  }
  s.chunks++;
  s.bytes = end + 1;
  if (m[3] !== "*") s.total = Number(m[3]);
  if (s.total !== null && s.bytes === s.total) {
    s.done = true;
    return new HttpResponse(null, { status: 200 });
  }
  return new HttpResponse(null, { status: 308, headers: sessionRange(s) });
}

function newId(): string {
  return `m0c${String(nextId++).padStart(9, "0")}`;
}

const SHOT_TYPES = ["close_up", "standard", "dynamic", "wide"];

/** Mirror of the gateway's pro-step request validation — same rules, same
 * user-facing messages, so tests exercise real error surfacing. Returns an
 * error response or null. `body` is the raw JSON (so rejected fields the
 * typed request no longer carries — displacement — are still seen). */
/** S3D-56: "auto" | "match_source" | 20 | 40 | 60 | 100. */
function checkBitrate(b: unknown): ReturnType<typeof err> | null {
  if (b === undefined || b === "auto" || b === "match_source") return null;
  if (b === 20 || b === 40 || b === 60 || b === 100) return null;
  if (b === "master" && mockDb.tierPricing) return null; // Master bitrate add-on
  return err(400, "invalid_request", "bitrate must be auto|match_source|20|40|60|100");
}

/** Estimated output size: bitrate × length × files (mock only). */
function estimatedSizeBytes(
  req: StepConversionRequest,
  seconds: number,
  sourceMbps = 60,
): number {
  const preset = req.preset ?? "1080p";
  const autoMbps: Record<string, number> = {
    "1080p": 20, qhd: 30, "3k": 40, "4k": 50, "5k": 70, "6k": 85, "8k": 110,
  };
  const mbps =
    typeof req.bitrate === "number"
      ? req.bitrate
      : req.bitrate === "match_source"
        ? sourceMbps
        : req.bitrate === "master"
        ? 2 * (autoMbps[preset] ?? 30)
        : (autoMbps[preset] ?? 30);
  const files = Math.max(1, req.formats?.length ?? 1);
  return Math.round(((mbps * 1e6) / 8) * seconds * files);
}

function validateStepRequest(
  p: Project,
  body: Record<string, unknown>,
): ReturnType<typeof err> | null {
  if (projectMethod(p) === "lifelike") return validateLifelikeRequest(p, body);
  const step = body.step as Step;
  if (body.split_max_seconds !== undefined) {
    // Classic's pipeline doesn't split yet: the gateway rejects it rather
    // than silently dropping it
    return err(
      400,
      "split_unsupported",
      "Classic 3D can't split outputs into parts yet",
    );
  }
  if (step === "lifelike_preview") {
    return err(
      400,
      "step_not_supported_for_method",
      "lifelike_preview is a Lifelike 3D step",
    );
  }
  const bitrateErr = checkBitrate(body.bitrate);
  if (bitrateErr) return bitrateErr;
  // S3D-12: Classic stops at 3K; 4K and above are Lifelike only
  if (
    typeof body.preset === "string" &&
    ["4k", "5k", "6k", "8k"].includes(body.preset)
  ) {
    return err(400, "preset_unavailable", "Classic 3D goes up to 3K");
  }
  if (!["depth_preview", "stereo_preview", "production"].includes(step)) {
    return err(
      400,
      "invalid_request",
      "step must be depth_preview|stereo_preview|production",
    );
  }
  if (body.displacement !== undefined) {
    return err(
      400,
      "invalid_request",
      "displacement is not a pro-step parameter; use scene_overrides[].displacement or depth_scale",
    );
  }
  // Explicit empty formats is a client bug (every format deselected), never
  // "use the step default" — mirrors resolveStepParams. Absent still
  // defaults; depth_preview ignores formats (depth-only).
  if (
    Array.isArray(body.formats) &&
    body.formats.length === 0 &&
    step !== "depth_preview"
  ) {
    return err(
      400,
      "invalid_request",
      "formats cannot be empty: select at least one output format",
    );
  }
  const depthRes = body.depth_res;
  if (depthRes !== undefined) {
    if (
      typeof depthRes !== "number" ||
      !Number.isInteger(depthRes) ||
      depthRes % 14 !== 0 ||
      depthRes < 140 ||
      depthRes > 2520
    ) {
      return err(
        400,
        "invalid_request",
        "depth_res must be a multiple of 14 in [140, 2520]",
      );
    }
  }
  const depthScale = body.depth_scale;
  if (depthScale !== undefined) {
    if (step === "depth_preview") {
      return err(
        400,
        "invalid_request",
        "depth_scale is not a depth_preview parameter",
      );
    }
    if (
      typeof depthScale !== "number" ||
      depthScale < 0.3 ||
      depthScale > 1.5
    ) {
      return err(400, "invalid_request", "depth_scale must be in [0.3, 1.5]");
    }
  }
  const overrides = body.scene_overrides as SceneOverride[] | undefined;
  if (overrides !== undefined) {
    // depth_preview accepts PASSTHROUGH-ONLY overrides (2D scenes skip the
    // AI depth pass, black depth) — depth knobs stay stereo/production-only.
    if (
      step === "depth_preview" &&
      overrides.some((o) => o.passthrough !== true)
    ) {
      return err(
        400,
        "invalid_request",
        "scene_overrides[]: depth_preview accepts passthrough only; displacement/shot_type/placement apply to stereo_preview and production",
      );
    }
    const cuts = new Set(p.scenes?.cuts ?? []);
    let prev = -1;
    for (const o of overrides) {
      if (o.first !== 0 && !cuts.has(o.first)) {
        return err(
          400,
          "invalid_request",
          `scene_overrides[].first ${o.first} is not 0 or a current scene cut`,
        );
      }
      if (o.first <= prev) {
        return err(
          400,
          "invalid_request",
          "scene_overrides[].first must be strictly increasing",
        );
      }
      prev = o.first;
      // passthrough is MUTUALLY EXCLUSIVE with the depth keys: a passthrough
      // entry must be exactly {first, passthrough: true}
      if (
        o.passthrough === true &&
        (o.shot_type !== undefined ||
          o.displacement !== undefined ||
          o.placement !== undefined)
      ) {
        return err(
          400,
          "invalid_request",
          "scene_overrides[].passthrough cannot be combined with shot_type|displacement|placement",
        );
      }
      if (
        o.shot_type === undefined &&
        o.displacement === undefined &&
        o.placement === undefined &&
        o.passthrough !== true
      ) {
        return err(
          400,
          "invalid_request",
          "scene_overrides entries need at least one of shot_type|displacement|placement",
        );
      }
      if (
        o.displacement !== undefined &&
        (o.displacement <= 0 || o.displacement > 0.03)
      ) {
        return err(
          400,
          "invalid_request",
          "scene_overrides[].displacement must be in (0, 0.03]",
        );
      }
      if (o.shot_type !== undefined && !SHOT_TYPES.includes(o.shot_type)) {
        return err(
          400,
          "invalid_request",
          "scene_overrides[].shot_type must be close_up|standard|dynamic|wide",
        );
      }
      if (o.placement !== undefined) {
        const [near, far] = o.placement;
        if (
          o.placement.length !== 2 ||
          !(near >= -1.5 && near < far && far <= 1.5)
        ) {
          return err(
            400,
            "invalid_request",
            "scene_overrides[].placement must be [near, far] with -1.5<=near<far<=1.5",
          );
        }
      }
    }
  }
  if (
    body.inpaint !== undefined &&
    !["none", "migan", "propainter"].includes(body.inpaint as string)
  ) {
    return err(400, "invalid_request", "inpaint must be none|migan|propainter");
  }
  if (body.warp !== undefined) {
    if (!["forward", "backward"].includes(body.warp as string)) {
      return err(400, "invalid_request", "warp must be forward|backward");
    }
    if (step === "depth_preview") {
      return err(
        400,
        "invalid_request",
        "warp applies to stereo_preview and production only",
      );
    }
    // mirrors the gateway: a gather warp has no gaps to fill, so an
    // explicit inpaint model alongside it is a contradiction
    if (
      body.warp === "backward" &&
      body.inpaint !== undefined &&
      body.inpaint !== "none"
    ) {
      return err(
        400,
        "invalid_request",
        `warp backward cannot be combined with inpaint ${body.inpaint} (a gather warp has no gaps to fill; use inpaint none)`,
      );
    }
  }
  if (body.use_uploaded_depth === true) {
    if (step === "depth_preview") {
      return err(
        400,
        "invalid_request",
        "use_uploaded_depth applies to stereo_preview and production (depth_preview computes the depth map)",
      );
    }
    if (depthRes !== undefined) {
      return err(
        400,
        "invalid_request",
        "use_uploaded_depth and depth_res are mutually exclusive — the uploaded depth map replaces the depth pass",
      );
    }
    if (p.depth_upload === undefined) {
      return err(
        400,
        "invalid_request",
        "no uploaded depth map on this project; upload one via POST /v1/projects/{id}/depth-map first",
      );
    }
  }
  if (
    (typeof body.target_fps === "number" ? body.target_fps : 0) >
    p.probe!.fps * 1.001
  ) {
    return err(
      400,
      "invalid_request",
      "target_fps cannot exceed the source frame rate",
    );
  }
  return null;
}

/** A project's method: stored, else classic (projects from before the
 * choice existed). */
function projectMethod(p: Project): Method {
  return p.method ?? "classic";
}

function sourceDurationS(p: Project): number {
  return p.probe?.duration_s ?? 0;
}

/** Lifelike request rules (contract 2026-11-03 + owner changes): steps
 * lifelike_preview | production; presets 1080p | qhd | 3k | 4k at or below
 * the source's short side (1080p always); formats ⊆ mvhevc/sbs/half_sbs;
 * no Classic knobs; previews ≤ 10 s; split_max_seconds 60–3600. */
function validateLifelikeRequest(
  p: Project,
  body: Record<string, unknown>,
): ReturnType<typeof err> | null {
  const step = body.step as string;
  if (step !== "lifelike_preview" && step !== "production") {
    return err(
      400,
      "step_not_supported_for_method",
      "Lifelike 3D projects run lifelike_preview and production only",
    );
  }
  for (const k of LIFELIKE.classicOnly) {
    if (body[k] !== undefined) {
      return err(400, "invalid_request", `${k} is not a Lifelike 3D option`);
    }
  }
  const preset = (body.preset as string | undefined) ?? "1080p";
  if (LIFELIKE.priceCentsPerMinute[preset] === undefined) {
    return err(400, "invalid_request", "preset must be 1080p|qhd|3k|4k|5k|6k|8k");
  }
  const bitrateErr = checkBitrate(body.bitrate);
  if (bitrateErr) return bitrateErr;
  const maxFps = mockMaxFps();
  if (maxFps !== null && typeof body.target_fps === "number" && body.target_fps > maxFps + 0.01) {
    return err(422, "plan_required_fps", "frame rates above 30 fps need a Business or Studio plan");
  }
  const eye = body.original_eye as string | undefined;
  if (eye !== undefined && eye !== "left" && eye !== "right") {
    return err(400, "invalid_request", "original_eye must be left|right");
  }
  if (
    eye === undefined &&
    lifelikeQualities(p).find((q) => q.preset === preset)?.original_eye_required
  ) {
    return err(400, "original_eye_required", "this quality keeps one eye original");
  }
  if (body.foveation !== undefined && body.foveation !== null) {
    if (body.foveation !== "static" || !mockDb.lifelikeFoveation) {
      return err(400, "invalid_request", "foveation is not available");
    }
    const side = LIFELIKE.presetShortSide[preset];
    const short = p.probe ? Math.min(p.probe.width, p.probe.height) : 0;
    if (!(side < short)) {
      return err(400, "invalid_request", "foveation needs a size below the source");
    }
  }
  if (!lifelikeQualities(p).some((q) => q.preset === preset)) {
    return err(
      400,
      "preset_above_source",
      "this quality is higher than the source video",
    );
  }
  const formats = body.formats as string[] | undefined;
  if (Array.isArray(formats)) {
    if (formats.length === 0) {
      return err(
        400,
        "invalid_request",
        "formats cannot be empty: select at least one output format",
      );
    }
    if (formats.some((f) => !LIFELIKE.formats.includes(f))) {
      return err(
        400,
        "invalid_request",
        "Lifelike 3D formats are mvhevc, sbs and half_sbs",
      );
    }
  }
  const from = body.from_frame as number | undefined;
  const to = body.to_frame as number | undefined;
  if (step === "lifelike_preview") {
    if (from === undefined || to === undefined || to <= from) {
      return err(
        400,
        "invalid_request",
        "lifelike_preview needs from_frame < to_frame",
      );
    }
    if ((to - from) / p.probe!.fps > LIFELIKE.maxPreviewSeconds + 1e-6) {
      return err(400, "invalid_request", "a preview spans at most 10 seconds");
    }
  }
  const split = body.split_max_seconds;
  if (split !== undefined) {
    if (
      step !== "production" ||
      typeof split !== "number" ||
      !Number.isInteger(split) ||
      split < 60 ||
      split > 3600
    ) {
      return err(
        400,
        "invalid_request",
        "split_max_seconds must be an integer in [60, 3600] on production",
      );
    }
  }
  return null;
}

/** The Lifelike qualities of a source (S3D-04, the gateway's `qualities`):
 * steps at or below its short side; a short side between steps adds "Full
 * resolution (Np)" (sent as the next step, priced like the step below); a
 * source below 1080 gets "Full resolution (Np)" at the 1080p price. */
/** Full side-by-side stops at 5K (gateway formatsFor). */
function mockFormatsFor(preset: Preset): Format[] {
  return preset === "6k" || preset === "8k"
    ? ["mvhevc", "half_sbs"]
    : ["mvhevc", "sbs", "half_sbs"];
}

function lifelikeQualities(p: Project): NonNullable<Project["qualities"]> {
  if (!p.probe) return [];
  const short = Math.min(p.probe.width, p.probe.height);
  const steps: [Preset, number][] = [
    ["1080p", 1080],
    ["qhd", 1440],
    ["3k", 1620],
    ["4k", 2160],
    ["5k", 2880],
    ["6k", 3240],
    ["8k", 4320],
  ];
  const out: NonNullable<Project["qualities"]> = [];
  let below: Preset | null = null;
  let belowSide = 0;
  for (const [preset, side] of steps) {
    if (side <= short) {
      // the gateway's shape: id + label_short_side, no label or sizes
      out.push({
        id: preset,
        preset,
        label_short_side: side,
        price_preset: preset,
        formats: mockFormatsFor(preset),
        // S3D-65: above 4K one eye keeps the source picture
        ...(side > 2160 ? { original_eye_required: true, experimental: true } : {}),
      });
      below = preset;
      belowSide = side;
    } else if (short <= belowSide) {
      // the source sits exactly on a step: nothing in between
      break;
    } else {
      // between steps (or under 1080): the source's own size
      out.push({
        preset,
        id: "full",
        label_short_side: short % 2 === 0 ? short : short - 1,
        formats: mockFormatsFor(preset),
        ...(below !== null ? { price_preset: below } : {}),
        ...(short > 2160 ? { original_eye_required: true, experimental: true } : {}),
      });
      break;
    }
  }
  return out;
}

/** Lifelike ETA model (contract): (530 × output minutes) / gpus + encode
 * tail + 45, tail frames capped at 7,200. */
function lifelikeEta(outputSeconds: number, fps: number, preset: string): number {
  const frames = Math.min(Math.round(outputSeconds * fps), 7200);
  const tail = frames * (LIFELIKE.encodeTailPerFrame[preset] ?? 0.035);
  return Math.round(
    (LIFELIKE.etaSecondsPerOutputMinute * (outputSeconds / 60)) / LIFELIKE.gpus +
      tail +
      45,
  );
}

/** A Lifelike quote: the Lifelike price table × fps factor, then the bulk
 * discount and the minimum. */
/** The per-run floor (S3D-17): $1 for every run; previews read their
 * own field so the two can differ again. */
function minimumFor(step: string | undefined): number {
  return step === "production" ? RATES.minimumCents : RATES.previewMinimumCents;
}

/** gateway 00172: the quote's File quality block. */
function mockQuality(req: StepConversionRequest, seconds: number) {
  const tier = req.quality ?? "standard";
  const mbps = { standard: 22, high: 41, master: 80 }[tier];
  const pct = tier === "standard" ? 0 : TIERS.addons[tier];
  return {
    tier,
    mbps,
    ...(tier === "standard" ? { max_mbps: 40 } : {}),
    ...(tier === "master" ? { bit_depth: 10 } : {}),
    approx: true,
    estimated_size_bytes: Math.round((mbps * 1e6 * seconds) / 8),
    price_pct: pct,
    label: tier === "standard" ? "Standard quality · included" : `${tier === "high" ? "High" : "Master"} quality +${Math.round(pct * 100)}%`,
  };
}

/** gateway 00172: Foveated Detail is free and always on at these. */
const FOVEATION_INCLUDED = ["1080p"];

/** Foveated Detail on a Lifelike quote or run: included at 1080p (applied
 * only when the output is below the source), else as ordered. */
function mockFoveation(project: Project, req: StepConversionRequest) {
  const preset = req.preset ?? "1080p";
  const included = FOVEATION_INCLUDED.includes(preset);
  if (!included) return { applied: req.foveation === "static", included: false };
  const short = project.probe ? Math.min(project.probe.width, project.probe.height) : 0;
  return short > 1080
    ? { applied: true, included: true }
    : { applied: false, included: true, reason: "output_not_below_source" as const };
}

/** TEST's launch offer (gateway README "Launch campaign"): 25% off web
 * Lifelike production runs up to 1440p, until the end of Jan 10 Pacific */
export const MOCK_CAMPAIGN = {
  pct: 0.25,
  max_preset: "qhd" as Preset,
  presets: ["1080p", "qhd"] as Preset[],
  starts_at: "2026-11-07T00:00:00Z",
  ends_at: "2027-01-11T07:59:59Z",
  label: "Launch offer until Jan 10",
};

function campaignActive(): boolean {
  const now = Date.now();
  return (
    mockDb.campaign &&
    now >= Date.parse(MOCK_CAMPAIGN.starts_at) &&
    now <= Date.parse(MOCK_CAMPAIGN.ends_at)
  );
}

/** GET /v1/pricing campaign {active, pct, percent, max_preset, presets,
 * starts_at, ends_at, label}; active false without one */
function publicCampaign(): Record<string, unknown> {
  if (!mockDb.campaign) return { active: false };
  return {
    active: campaignActive(),
    ...MOCK_CAMPAIGN,
    percent: Math.round(MOCK_CAMPAIGN.pct * 100),
    ...(mockDb.campaignMethods ? { methods: mockDb.campaignMethods } : {}),
  };
}

/** Does the offer take its share off this method's run? */
function campaignFor(method: "lifelike" | "classic", preset: Preset): boolean {
  if (!campaignActive() || !MOCK_CAMPAIGN.presets.includes(preset)) return false;
  return mockDb.campaignMethods ? mockDb.campaignMethods.includes(method) : method === "lifelike";
}

/** the run carries the quote's campaign_cents (when it has one) */
function campaignOf(quote: Conversion["quote"]): { campaign_cents?: number } {
  const c = quote.breakdown?.campaign_cents as number | undefined;
  return c !== undefined ? { campaign_cents: c } : {};
}

/** gateway 00178: what every run carries for its Details panel */
function detailFields(req: StepConversionRequest, freeUnits: number | null = null): Partial<Conversion> {
  return {
    started_at: null,
    free_preview_units: freeUnits,
    quick_look: req.quick_look === true,
    intro: mockDb.accountSettings.lifelike_intro === true,
  };
}

function lifelikeQuoteFor(
  project: Project,
  req: StepConversionRequest,
): {
  quote: Conversion["quote"];
  reuseStages: string[];
  params: Conversion["params"];
  outputSeconds: number;
  eta: number;
} {
  const probe = project.probe!;
  const from = req.from_frame ?? 0;
  const to =
    req.to_frame && req.to_frame < probe.num_frames
      ? req.to_frame
      : probe.num_frames;
  const outputSeconds = (to - from) / probe.fps;
  const preset = req.preset ?? "1080p";
  // "Full resolution" between steps is priced like the step below
  const priced =
    lifelikeQualities(project).find((q) => q.preset === preset)?.price_preset ??
    preset;
  const perMin = LIFELIKE.priceCentsPerMinute[priced];
  const fpsPol = fpsPolicy(project, req.target_fps);
  const effFPS = fpsPol.effective;
  const fpsFactor = clamp(effFPS / RATES.fpsBase, 0.5, 2.5);
  if (mockDb.tierPricing) {
    const tier = mockTier();
    const listPer = TIERS.lifelike.list[priced];
    const tierPer = tier ? TIERS.lifelike[tier][priced] : listPer;
    const addOns: string[] = [];
    if (req.foveation === "static") addOns.push("foveated");
    if (req.bitrate === "master" || req.quality === "master") addOns.push("master");
    else if (req.quality === "high") addOns.push("high");
    const plan = tier === "business" || tier === "studio" ? TIERS.plans[tier] : null;
    const expressIncluded = req.express === true && plan?.express_included === true;
    if (req.express && !expressIncluded) addOns.push("express");
    const preview = req.step === "lifelike_preview";
    let q;
    if (preview) {
      const frames = Math.round(outputSeconds * effFPS);
      const perFrame = (perMin: number) => Math.round((frames * perMin) / (60 * RATES.fpsBase));
      q = composeTier(perFrame(listPer), perFrame(tierPer), tier, addOns, false);
    } else {
      // owner 2026-11-04: the run's video rounds UP to whole minutes
      const base = (perMin: number) => Math.ceil(Math.ceil(outputSeconds / 60) * perMin * fpsFactor);
      q = composeTier(base(listPer), base(tierPer), tier, addOns, true);
    }
    // the launch offer: after the plan or Pro price, on the whole run,
    // by the output preset; web production runs only
    const campaign =
      !preview && campaignFor("lifelike", preset)
        ? Math.round(q.final * MOCK_CAMPAIGN.pct)
        : 0;
    let total = Math.max(q.final - campaign, minimumFor(req.step));
    const units = preview ? previewUnits(priced, outputSeconds, effFPS) : 0;
    const free = preview && freePreviewState(units).free;
    const priceWithoutFree = total;
    if (free) total = 0;
    return {
      quote: {
        amount_cents: total,
        currency: "usd",
        rate_version: "mock-2026-11",
        breakdown: {
          step: req.step,
          preset,
          tier,
          pricing: "tiers",
          billable_seconds: Math.round(outputSeconds * 100) / 100,
          list_cents_per_minute: listPer,
          cents_per_minute: tierPer,
          fps_factor: Math.round(fpsFactor * 10000) / 10000,
          ...(preview ? {} : { billable_minutes: Math.ceil(outputSeconds / 60) }),
          list_base_cents: preview ? q.listTotal - Object.values(q.adds).reduce((a, b) => a + b, 0) : Math.ceil(Math.ceil(outputSeconds / 60) * listPer * fpsFactor),
          addons: q.adds,
          subtotal_cents: q.listTotal,
          discount: q.kind ? { kind: q.kind, cents: q.cents, pct: q.dpct, ...(q.kind === "tier" ? { tier } : {}) } : null,
          discount_cents: q.kind === "bulk" ? q.cents : 0,
          pro_discount_cents: q.kind === "tier" ? q.cents : 0,
          pro_discount_pct: q.kind === "tier" ? q.dpct : 0,
          express: req.express === true,
          express_included: expressIncluded,
          campaign_cents: campaign,
          ...(campaign > 0
            ? {
                campaign_label: `Launch offer −${Math.round(MOCK_CAMPAIGN.pct * 100)}%`,
                campaign_pct: MOCK_CAMPAIGN.pct,
                campaign_name: MOCK_CAMPAIGN.label,
              }
            : {}),
          ...(q.adds.foveated ? { foveation_factor: 1.3, foveation_cents: q.adds.foveated } : {}),
          ...(req.quality === "high" || req.quality === "master"
            ? {
                quality: req.quality,
                quality_label: `${req.quality === "high" ? "High" : "Master"} quality +${Math.round(TIERS.addons[req.quality] * 100)}%`,
              }
            : {}),
          ...(free ? { free_preview: true, price_without_free_cents: priceWithoutFree } : {}),
          ...(preview ? { free_preview_units: units } : {}),
        },
      },
      reuseStages: [],
      params: {
        preset,
        formats: req.formats ?? (req.step === "production" ? ["mvhevc"] : ["sbs", "mvhevc"]),
        from_frame: req.from_frame || undefined,
        to_frame: req.to_frame || undefined,
        target_fps: req.target_fps || (effFPS !== probe.fps ? effFPS : undefined),
        ...("capped" in fpsPol && fpsPol.capped ? { fps_capped: true } : {}),
        scene_cuts: project.scenes?.cuts,
        split_max_seconds: req.split_max_seconds,
        ...(req.original_eye ? { original_eye: req.original_eye } : {}),
        ...(req.foveation ? { foveation: req.foveation } : {}),
        ...(req.bitrate ? { bitrate: req.bitrate } : {}),
        ...(req.express ? { express: true } : {}),
        ...(req.quick_look ? { quick_look: true } : {}),
      },
      outputSeconds,
      eta: lifelikeEta(outputSeconds, probe.fps, preset),
    };
  }
  // Foveated Detail: +30% (S3D-50)
  const foveationFactor = req.foveation === "static" ? 1.3 : 1;
  // owner 2026-11-04: a full run's video rounds UP to whole minutes
  const production = req.step === "production";
  const minutes = production ? Math.ceil(outputSeconds / 60) : outputSeconds / 60;
  const subtotal = Math.ceil(minutes * perMin * fpsFactor * foveationFactor);
  const bulk =
    subtotal > RATES.discountThresholdCents
      ? Math.round(subtotal * RATES.discountPct)
      : 0;
  // S3D-67: Pro members save on every run
  // full runs only; previews are never discounted
  const proCents =
    mockDb.pro === true && req.step === MOCK_PRO.applies_to
      ? Math.round((subtotal - bulk) * MOCK_PRO.pct)
      : 0;
  // the $1 minimum per run, previews included (S3D-17)
  const total = Math.max(subtotal - bulk - proCents, minimumFor(req.step));
  return {
    quote: {
      amount_cents: total,
      currency: "usd",
      rate_version: "mock",
      breakdown: {
        ...(proCents > 0
          ? { pro_discount_pct: MOCK_PRO.pct, pro_discount_cents: proCents }
          : {}),
        step: req.step,
        preset,
        billable_seconds: Math.round(outputSeconds * 100) / 100,
        ...(production ? { billable_minutes: minutes } : {}),
        cents_per_minute: perMin,
        fps_factor: Math.round(fpsFactor * 10000) / 10000,
        base_cents: subtotal,
        subtotal_cents: subtotal,
        discount_cents: bulk,
        ...(foveationFactor !== 1
          ? {
              foveation_factor: foveationFactor,
              foveation_cents: subtotal - Math.ceil(subtotal / foveationFactor),
            }
          : {}),
      },
    },
    reuseStages: [],
    params: {
      preset,
      formats:
        req.formats ??
        (req.step === "production" ? ["mvhevc"] : ["sbs"]),
      from_frame: req.from_frame || undefined,
      to_frame: req.to_frame || undefined,
      target_fps: req.target_fps || undefined,
      scene_cuts: project.scenes?.cuts,
      split_max_seconds: req.split_max_seconds,
      ...(req.original_eye ? { original_eye: req.original_eye } : {}),
      ...(req.foveation ? { foveation: req.foveation } : {}),
    },
    outputSeconds,
    eta: lifelikeEta(outputSeconds, probe.fps, preset),
  };
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), hi);

/** Analyze lifecycle while running — one stage per detail GET, then the
 * fixture analysis folds in (same shape the gateway's read-through poll
 * produces: progress + stage + eta on BOTH list and detail responses). */
const ANALYZE_STAGES: readonly {
  stage: string;
  progress: number;
  eta: number;
}[] = [
  { stage: "analyze", progress: 0.15, eta: 34 },
  { stage: "proxy", progress: 0.45, eta: 22 },
  { stage: "scene_detect", progress: 0.7, eta: 12 },
  { stage: "thumbnails", progress: 0.9, eta: 4 },
];

/** Coarse wall-clock estimate for a quoted step — mirrors the gateway's
 * "billable duration × per-step throughput" shape, floored at 20 s. */
function etaForStep(step: Step, billableSeconds: number): number {
  const perSecond = {
    depth_preview: 2.5,
    stereo_preview: 3.5,
    lifelike_preview: 3.5,
    production: 4,
  };
  return Math.max(20, Math.round(billableSeconds * perSecond[step]));
}

function quoteFor(
  project: Project,
  req: StepConversionRequest,
): {
  quote: Conversion["quote"];
  reuseStages: string[];
  params: Conversion["params"];
} {
  const probe = project.probe!;
  const from = req.from_frame ?? 0;
  const to =
    req.to_frame && req.to_frame < probe.num_frames
      ? req.to_frame
      : probe.num_frames;
  const billable = (to - from) / probe.fps;
  const step = req.step as Step;
  const preset = step === "depth_preview" ? "draft" : (req.preset ?? "1080p");
  const costPerMin =
    step === "production"
      ? RATES.centsPerMinute[preset as keyof typeof RATES.centsPerMinute]
      : step === "stereo_preview"
        ? RATES.stereoPreviewCentsPerMinute[preset]
        : RATES.stepCentsPerMinute[step as "depth_preview"];
  // price = cost rate × margin (the ONE margin knob)
  const perMin = costPerMin * RATES.costMarginMultiplier;
  // Uploaded depth map: the depth stage is skipped (no resolution factor,
  // unconditional depth-share reuse discount) and the run is forced to the
  // FULL source rate — the upload is frame-exact against the source.
  const uploadedDepth =
    req.use_uploaded_depth === true && project.depth_upload !== undefined;
  // fps factor: frames are what cost, so the effective render rate scales
  // the base linearly, normalized to 24 fps and clamped to [0.5, 2.5].
  // Previews default to HALF the source rate, production to the full rate.
  const effFPS = uploadedDepth
    ? probe.fps
    : (req.target_fps ?? (step === "production" ? probe.fps : probe.fps / 2));
  const fpsFactor = clamp(effFPS / RATES.fpsBase, 0.5, 2.5);
  const base = Math.ceil((billable / 60) * perMin * fpsFactor);
  // depth factor on the depth share: LINEAR in working megapixels
  // (depth_res² × elongation, POST-CROP dims) relative to 980² × 16:9 —
  // equals the legacy (res/980)² quadratic on a 16:9 source. The WHOLE base
  // is depth work on depth_preview; 0.35 of it on the other steps. Absent
  // depth_res = the PRESET's input_size (what the job actually runs —
  // mirrors presetInputSize in the gateway / PRESETS in the pipeline).
  const presetInputSize: Record<string, number> = {
    draft: 518,
    "1080p": 980,
    qhd: 1148,
    "3k": 1148,
    "4k": 1442,
  };
  const depthRes = uploadedDepth
    ? 0
    : (req.depth_res ?? presetInputSize[preset] ?? 980);
  const dims = depthContentDims(probe, project.crop) ?? {
    width: 16,
    height: 9,
  };
  const elongation =
    Math.max(dims.width, dims.height) / Math.min(dims.width, dims.height);
  const workMP = (depthRes * depthRes * elongation) / 1e6;
  const baseMP = (RATES.depthResBase ** 2 * (16 / 9)) / 1e6;
  // depthRes 0 (uploaded depth) = no inference, factor 1 — mirrors the
  // gateway's depthFactor guard
  const depthFactor =
    depthRes > 0 ? clamp(workMP / baseMP, 0.5, RATES.depthFactorCeiling) : 1;
  const depthShare = step === "depth_preview" ? 1 : RATES.stageShares.depth;
  let subtotal = Math.round(base * (1 + depthShare * (depthFactor - 1)));
  const inpaint =
    step === "depth_preview" || req.warp === "backward" // depth_preview never
      ? "none" // inpaints; backward warp forces none (mirrors the gateway)
      : (req.inpaint ?? (step === "production" ? "propainter" : "none"));
  // production preset rates already include inpainting; stereo previews
  // price the optional ProPainter pass explicitly.
  // ... and production is CHEAPER without it (warp backward ⇒ inpaint
  // none): its rates bake ProPainter in — mirrors the gateway's
  // production_no_inpaint_multiplier (0.4, whole subtotal).
  const inpaintMult =
    step === "stereo_preview" && inpaint === "propainter"
      ? 1.6
      : step === "stereo_preview" && inpaint === "migan"
        ? 1.15
        : step === "production" && inpaint === "migan"
          ? 0.5
          : step === "production" && inpaint === "none"
            ? 0.4
            : 1;
  subtotal = Math.round(subtotal * inpaintMult);
  // reuse: an uploaded depth map skips the depth stage outright (both
  // steps, unconditional); otherwise production discounts when a prior
  // succeeded conversion exists, and stereo_preview when a prior succeeded
  // DEPTH run matches the depth artifact key (depth_res + fps) — mirrors
  // the gateway's Modal lookup.
  const reuseStages: string[] = [];
  if (uploadedDepth && step !== "depth_preview" && !req.from_scratch) {
    reuseStages.push("depth");
  }
  if (step === "production" && !req.from_scratch) {
    const hasPrior = [...mockDb.conversions.values()].some(
      (c) => c.project_id === project.project_id && c.state === "succeeded",
    );
    if (hasPrior) {
      if (!uploadedDepth) reuseStages.push("depth");
      reuseStages.push("preprocess");
    }
  }
  if (step === "stereo_preview" && !uploadedDepth && !req.from_scratch) {
    const effTargetFPS =
      req.target_fps ?? Math.round((probe.fps / 2) * 100) / 100;
    const depthMatch = [...mockDb.conversions.values()].some(
      (c) =>
        c.project_id === project.project_id &&
        c.step === "depth_preview" &&
        c.state === "succeeded" &&
        c.params.depth_res === depthRes &&
        c.params.target_fps === effTargetFPS,
    );
    if (depthMatch) reuseStages.push("depth");
  }
  const share = reuseStages.reduce(
    (s, st) =>
      s + (RATES.stageShares[st as keyof typeof RATES.stageShares] ?? 0),
    0,
  );
  const reuseDiscount = Math.round(subtotal * Math.min(share, 0.9));
  const afterReuse = subtotal - reuseDiscount;
  const bulk =
    afterReuse > RATES.discountThresholdCents
      ? Math.round(afterReuse * RATES.discountPct)
      : 0;
  const credit = project.analyze.credit_available
    ? RATES.analyzeCreditCents
    : 0;
  // the launch offer on Classic web runs, once the gateway lists Classic
  const campaign =
    step === "production" && campaignFor("classic", preset) ? Math.round((afterReuse - bulk) * MOCK_CAMPAIGN.pct) : 0;
  const total = Math.max(afterReuse - bulk - campaign - credit, minimumFor(req.step));
  return {
    quote: {
      amount_cents: total,
      currency: "usd",
      rate_version: "mock",
      breakdown: {
        ...(campaign > 0
          ? {
              campaign_cents: campaign,
              campaign_label: `Launch offer −${Math.round(MOCK_CAMPAIGN.pct * 100)}%`,
              campaign_pct: MOCK_CAMPAIGN.pct,
              campaign_name: MOCK_CAMPAIGN.label,
            }
          : {}),
        step,
        preset,
        billable_seconds: Math.round(billable * 100) / 100,
        cents_per_minute: perMin,
        fps_factor: Math.round(fpsFactor * 10000) / 10000,
        base_cents: base,
        depth_res: depthRes,
        depth_res_factor: Math.round(depthFactor * 10000) / 10000,
        ...(inpaintMult !== 1 ? { inpaint_multiplier: inpaintMult } : {}),
        subtotal_cents: subtotal,
        reuse_stages: reuseStages,
        reuse_discount_cents: reuseDiscount,
        discount_cents: bulk,
        analyze_credit_cents: credit,
      },
    },
    reuseStages,
    params: {
      preset,
      // step defaults: depth_preview is depth-only (no formats — nothing is
      // encoded); stereo_preview sbs; production mvhevc+half_sbs
      formats:
        step === "depth_preview"
          ? []
          : (req.formats ??
            (step === "production" ? ["mvhevc", "half_sbs"] : ["sbs"])),
      ...(step === "depth_preview" ? { depth_only: true } : {}),
      inpaint,
      ...(req.warp !== undefined ? { warp: req.warp } : {}),
      // uploaded depth: no inference resolution, and the run is pinned to
      // the full source rate (target_fps absent) — mirrors the gateway
      ...(uploadedDepth
        ? { depth_source: "uploads/mock-depth.mp4" }
        : { depth_res: depthRes }),
      ...(req.depth_scale !== undefined
        ? { depth_scale: req.depth_scale }
        : {}),
      ...(req.scene_overrides?.length
        ? { scene_overrides: req.scene_overrides }
        : {}),
      // previews default to HALF the source rate; never above source
      target_fps: uploadedDepth
        ? undefined
        : req.target_fps ||
          (step === "production"
            ? undefined
            : Math.round((probe.fps / 2) * 100) / 100),
      from_frame: req.from_frame || undefined,
      to_frame: req.to_frame || undefined,
      scene_cuts: project.scenes?.cuts,
      skip_reuse: req.from_scratch || undefined,
    },
  };
}

/** Success side effects, like the real pipeline's: the run's outputs gain
 * the depth artifacts (depth + the browser-playable depth_vis), the saved
 * card is charged automatically (or fails, when a test armed
 * nextChargeFails), and a pro video conversion stamps the project's
 * scene_profile (the adaptive profiler's per-shot parameters) with the
 * CURRENT scenes version. */
function succeed(c: Conversion) {
  c.waiting_for_gpu = false;
  if (c.method === "lifelike") {
    const formats = c.params.formats ?? [];
    const p = c.project_id ? mockDb.projects.get(c.project_id) : undefined;
    const fps = p?.probe?.fps ?? 24;
    const from = c.params.from_frame ?? 0;
    const to = c.params.to_frame ?? p?.probe?.num_frames ?? 0;
    const seconds = (to - from) / fps;
    const split = c.params.split_max_seconds;
    if (split !== undefined && seconds > split) {
      // mvhevc_part01, sbs_part01, … — every format shares the boundaries
      const n = Math.ceil(seconds / split);
      c.parts = Array.from({ length: n }, (_, i) => ({
        index: i + 1,
        start_s: i * split,
        duration_s: Math.min(split, seconds - i * split),
      }));
      c.outputs = formats.flatMap((f) =>
        c.parts!.map((part) => `${f}_part${String(part.index).padStart(2, "0")}`),
      );
    } else {
      c.outputs = [...formats];
    }
    // gateway 00172: what each file measures
    const rate = { standard: 22000, high: 41000, master: 80000 }[c.quality ?? "standard"];
    c.outputs_media = Object.fromEntries(
      c.outputs.map((o, i) => [
        o,
        { video_kbps: rate - (o.startsWith("sbs") ? 3000 : 0) - i, audio_codec: "aac", audio_kbps: 256, source: "worker" as const },
      ]),
    );
  } else {
    c.outputs = [...(c.params.formats ?? []), "depth", "depth_vis"];
  }
  const hold = mockDb.billing.prepaid.holds.get(c.conversion_id);
  if (hold !== undefined) {
    // spec v7 N5: settle min(price, hold), release the rest
    const pp = mockDb.billing.prepaid;
    pp.holds.delete(c.conversion_id);
    pp.balance_cents -= hold;
    c.billing = { status: "balance_settled", charged_cents: hold };
  } else if (mockDb.billing.nextChargeFails) {
    mockDb.billing.nextChargeFails = false;
    mockDb.failCharge(c.conversion_id);
  } else if (!c.billing) {
    if (c.quote.amount_cents >= mockDb.billing.holdThresholdCents) {
      // held up front → captured on success
      c.billing = { status: "charged", charged_cents: c.quote.amount_cents };
    } else {
      batchCharge(c);
    }
  }
  const p = c.project_id ? mockDb.projects.get(c.project_id) : undefined;
  if (p && c.step) {
    const profile = structuredClone(
      sceneProfileFixture.scene_profile,
    ) as unknown as SceneProfile;
    p.scene_profile = {
      ...profile,
      conversion_id: c.conversion_id,
      scenes_version: p.scenes?.version ?? profile.scenes_version,
      updated_at: new Date().toISOString(),
    };
  }
}

/** Batched billing, like the gateway: a cheap succeeded step joins the
 * open batch (pi_status batched); reaching the cap charges the whole batch
 * at once. */
function batchCharge(c: Conversion) {
  const b = mockDb.billing;
  if (!b.pending) {
    const now = new Date();
    b.pending = {
      batch_id: `mb${String(nextId++).padStart(10, "0")}`,
      amount_cents: 0,
      currency: c.quote.currency,
      cap_cents: b.batchCapCents,
      opened_at: now.toISOString(),
      due_at: new Date(now.getTime() + 1 * 3600 * 1000).toISOString(),
      items: [],
    };
  }
  b.pending.items.push({
    conversion_id: c.conversion_id,
    project_id: c.project_id,
    step: c.step,
    kind: c.kind,
    description: c.step ?? "3D conversion",
    amount_cents: c.quote.amount_cents,
    added_at: new Date().toISOString(),
  });
  b.pending.amount_cents += c.quote.amount_cents;
  c.billing = { status: "batched", batch_id: b.pending.batch_id };
  if (b.pending.amount_cents >= b.pending.cap_cents) settlePending();
}

/** Charge the open batch: every batched conversion reads charged. */
function settlePending() {
  const b = mockDb.billing;
  if (!b.pending) return;
  for (const it of b.pending.items) {
    const c = mockDb.conversions.get(it.conversion_id);
    if (c) c.billing = { status: "charged", charged_cents: it.amount_cents };
  }
  b.pending = null;
}

/** Plausible SHOT_PARAMS-bucket values the mock profiler cycles across the
 * project's scenes (fixture-like shot_type/displacement/placement). */
const PROFILE_BUCKETS: readonly {
  shot_type: ShotType;
  displacement: number;
  placement: [number, number];
}[] = [
  { shot_type: "standard", displacement: 0.01, placement: [-1.0, 0.3] },
  { shot_type: "close_up", displacement: 0.008, placement: [-1.0, 0.1] },
  { shot_type: "dynamic", displacement: 0.009, placement: [-1.0, 0.1] },
  { shot_type: "wide", displacement: 0.012, placement: [-0.7, 0.6] },
];

/** Shots derived from the project's CURRENT scene cuts, tiling
 * [0, num_frames) exactly — what the free profiler "measures". */
function profiledShots(p: Project): ProfileShot[] {
  const bounds = [0, ...(p.scenes?.cuts ?? []), p.probe!.num_frames];
  const shots: ProfileShot[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const b = PROFILE_BUCKETS[i % PROFILE_BUCKETS.length];
    shots.push({
      first_src: bounds[i],
      last_src: bounds[i + 1],
      shot_type: b.shot_type,
      displacement: b.displacement,
      placement: [...b.placement],
    });
  }
  return shots;
}

/** Free-profile lifecycle while running — the FIRST detail GET advances
 * progress, the SECOND completes: profile.state=succeeded and the result
 * folds into project.scene_profile (conversion_id "profile:<jobid>"), like
 * the gateway. */
function tickProfile(p: Project) {
  if (p.profile?.state !== "running") return;
  const tick = mockDb.profileTicks.get(p.project_id) ?? 0;
  const now = new Date().toISOString();
  if (tick < 1) {
    p.profile = {
      ...p.profile,
      progress: 0.6,
      stage: "profiling",
      updated_at: now,
    };
    mockDb.profileTicks.set(p.project_id, tick + 1);
  } else if (!mockDb.profileHold) {
    const version = p.profile.scenes_version;
    p.profile = {
      state: "succeeded",
      scenes_version: version,
      updated_at: now,
    };
    p.scene_profile = {
      conversion_id: `profile:${newId()}`,
      scenes_version: version,
      shots: profiledShots(p),
      updated_at: now,
    };
    mockDb.profileTicks.delete(p.project_id);
  }
}

/** One analysis step: one lifecycle stage per tick (deterministic for
 * tests), then the fixture analysis folds in like the gateway's
 * read-through poll. */
function tickAnalyze(p: Project) {
  if (p.analyze.state !== "running") return;
  const tick = mockDb.analyzeTicks.get(p.project_id) ?? 0;
  if (tick < ANALYZE_STAGES.length) {
    const s = ANALYZE_STAGES[tick];
    p.analyze = {
      ...p.analyze,
      progress: s.progress,
      stage: s.stage,
      eta_seconds: s.eta,
    };
    mockDb.analyzeTicks.set(p.project_id, tick + 1);
  } else {
    const t = structuredClone(projectFixture) as unknown as Project;
    Object.assign(p, {
      analyze: t.analyze,
      probe: t.probe,
      scenes: t.scenes,
      crop: t.crop,
      strip_thumbs: t.strip_thumbs,
      scene_thumbs: t.scene_thumbs,
      poster: t.poster,
    });
    mockDb.analyzeTicks.delete(p.project_id);
  }
}

/** A time in the stream's `version` unit (microseconds). */
function micros(at: string): number {
  return Date.parse(at) * 1000;
}

const ACTIVE_RUN = new Set(["created", "paid", "processing"]);
const encoder = new TextEncoder();

/** One open status stream: send an event to it, or close it. */
interface MockStream {
  send: (event: string, data: Record<string, unknown>) => void;
  close: () => void;
}

const streams = new Set<MockStream>();
let streamTicker: ReturnType<typeof setInterval> | null = null;
/** what the streams last said about handoffs and the settle */
const sentHandoffs = new Map<string, string>();
let sentSettle = "";
let sentBalance = "";

/** billing.updated kind balance: what's spendable and what runs hold. */
function balanceBody() {
  const pp = mockDb.billing.prepaid;
  const held = [...pp.holds.values()].reduce((n: number, c: number) => n + c, 0);
  return { balance_cents: Math.max(pp.balance_cents - held - pp.frozen_cents, 0), held_cents: held };
}

/** The gateway's handoff doc state: waiting | paying, closed once used or
 * expired. */
function handoffDocState(h: { conversion_id: string; state: string }): string {
  const c = mockDb.conversions.get(h.conversion_id);
  if (h.state === "paid" || h.state === "expired" || (c && c.state !== "created")) return "closed";
  return h.state === "paying" ? "paying" : "waiting";
}

function settleBody() {
  const b = mockDb.billing;
  const owed = (b.unpaid ?? []).reduce((n: number, u: { amount_cents: number }) => n + u.amount_cents, 0);
  return { settle_id: "settle_mock_1", state: b.settling ? "in_progress" : owed > 0 ? "open" : "paid", amount_cents: owed };
}

function runBody(c: Conversion) {
  return { ...c, project_id: c.project_id };
}

function projectBody(p: Project) {
  const { conversions: _c, ...rest } = projectDetail(p);
  void _c;
  return { ...rest, summary: projectSummary(p as MockProject) };
}

function broadcast(event: string, data: Record<string, unknown>) {
  for (const s of streams) s.send(event, data);
}

/** One lifecycle step of every going run, analysis and profile job, sent
 * to every open stream (run.progress while only its progress moves,
 * run.state on any other change, project.updated). */
function streamTick() {
  for (const c of mockDb.conversions.values()) {
    if (!ACTIVE_RUN.has(c.state)) continue;
    const before = JSON.stringify({ s: c.state, b: c.billing, o: c.outputs, w: c.waiting_for_gpu });
    tick(c);
    c.updated_at = new Date().toISOString();
    const after = JSON.stringify({ s: c.state, b: c.billing, o: c.outputs, w: c.waiting_for_gpu });
    if (before !== after) {
      broadcast("run.state", {
        run_id: c.conversion_id,
        project_id: c.project_id,
        version: micros(c.updated_at),
        state: c.state,
        run: runBody(c),
      });
    } else {
      broadcast("run.progress", {
        run_id: c.conversion_id,
        project_id: c.project_id,
        version: micros(c.updated_at),
        state: c.state,
        progress: c.progress,
        stage: c.stage,
        eta_seconds: c.eta_seconds,
        waiting_for_gpu: c.waiting_for_gpu === true,
        queued_s: c.queued_s,
      });
    }
  }
  // format jobs (run.formats, with the run's file names)
  for (const c of mockDb.conversions.values()) {
    if (!mockDb.formatJobs.has(c.conversion_id)) continue;
    const before = JSON.stringify([runFormats(c, false), c.outputs]);
    const formats = runFormats(c, true);
    if (JSON.stringify([formats, c.outputs]) === before) continue;
    c.updated_at = new Date().toISOString();
    broadcast("run.formats", {
      run_id: c.conversion_id,
      project_id: c.project_id,
      version: micros(c.updated_at),
      formats,
      outputs: [...(c.outputs ?? [])].sort(),
    });
  }
  // hand-off links (handoff.state)
  for (const [code, h] of mockDb.billing.handoffs) {
    const state = handoffDocState(h);
    if (sentHandoffs.get(code) === state) continue;
    sentHandoffs.set(code, state);
    broadcast("handoff.state", { code, run_id: h.conversion_id, version: micros(new Date().toISOString()), state });
  }
  // the prepaid balance (billing.updated)
  const balance = balanceBody();
  if (JSON.stringify(balance) !== sentBalance) {
    sentBalance = JSON.stringify(balance);
    broadcast("billing.updated", { kind: "balance", version: micros(new Date().toISOString()), ...balance });
  }
  // the settle of what's owed (billing.updated)
  const settle = settleBody();
  if (JSON.stringify(settle) !== sentSettle) {
    sentSettle = JSON.stringify(settle);
    broadcast("billing.updated", { kind: "settle", version: micros(new Date().toISOString()), ...settle });
  }
  for (const p of mockDb.projects.values()) {
    if ((p as MockProject).deleted) continue;
    if (p.analyze.state !== "running" && p.profile?.state !== "running") continue;
    tickAnalyze(p);
    tickProfile(p);
    p.updated_at = new Date().toISOString();
    broadcast("project.updated", {
      project_id: p.project_id,
      version: micros(p.updated_at),
      deleted: false,
      project: projectBody(p),
    });
  }
}

/** Close every open status stream (mockDb.reset: a test's streams never
 * tick the next test's runs). */
export function closeMockStreams() {
  for (const s of [...streams]) s.close();
  sentHandoffs.clear();
  sentSettle = "";
  sentBalance = "";
}

/**
 * GET /v1/events (owner 2026-11-07, the gateway's schema): `retry:`, a
 * snapshot on connect, then one shared tick every POLL_INTERVAL_MS while
 * any stream is open (streamTick). mockDb.eventsDown answers 503 instead.
 */
function eventStream(request: Request) {
  if (mockDb.eventsDown) return err(503, "events_unavailable", "the status stream is down");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const me: MockStream = {
        send(event, data) {
          if (!open) return;
          mockDb.eventSeq += 1;
          const body = JSON.stringify({ type: event, ...data });
          try {
            controller.enqueue(encoder.encode(`event: ${event}\nid: ${mockDb.eventSeq}\ndata: ${body}\n\n`));
          } catch {
            me.close();
          }
        },
        close() {
          if (!open) return;
          open = false;
          streams.delete(me);
          mockDb.openStreams = streams.size;
          if (streams.size === 0 && streamTicker !== null) {
            clearInterval(streamTicker);
            streamTicker = null;
          }
          try {
            controller.close();
          } catch {
            // already closed
          }
        },
      };
      streams.add(me);
      mockDb.openStreams = streams.size;
      controller.enqueue(encoder.encode("retry: 2000\n\n"));
      me.send("snapshot", {
        version: micros(new Date().toISOString()),
        runs: [...mockDb.conversions.values()]
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
          .slice(0, 50)
          .map(runBody),
        projects: [...mockDb.projects.values()]
          .filter((p) => !(p as MockProject).deleted)
          .slice(0, 100)
          .map(projectBody),
        run_formats: Object.fromEntries(
          [...mockDb.conversions.values()]
            .filter((c) => mockDb.formatJobs.has(c.conversion_id))
            .map((c) => [c.conversion_id, runFormats(c, false)]),
        ),
        handoffs: [...mockDb.billing.handoffs].map(([code, h]) => {
          sentHandoffs.set(code, handoffDocState(h));
          return { code, run_id: h.conversion_id, state: handoffDocState(h), version: micros(new Date().toISOString()) };
        }),
        settles: (() => {
          sentSettle = JSON.stringify(settleBody());
          return [{ ...settleBody(), version: micros(new Date().toISOString()) }];
        })(),
        billing: (() => {
          sentBalance = JSON.stringify(balanceBody());
          return { ...balanceBody(), version: micros(new Date().toISOString()) };
        })(),
      });
      streamTicker ??= setInterval(streamTick, POLL_INTERVAL_MS);
      request.signal.addEventListener("abort", () => me.close());
    },
  });
  return new HttpResponse(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
  });
}

/** The detail-response shape (GET/PATCH project, POST profile): the project
 * plus its conversions, newest first. */
/** gateway 00175: the device file names given at POST /v1/projects. */
const sourceNames = new Map<string, string>();

/** gateway 00175: project.source_details, as a read file has them (a
 * synthetic camera; colour only while HDR output is on, like the
 * gateway). */
function mockSourceDetails(p: Project) {
  if (!p.probe) return undefined;
  return {
    details_read: true,
    file: {
      name: sourceNames.get(p.project_id) ?? null,
      bytes: p.source_bytes || null,
      container: "mov",
      duration_s: p.probe.duration_s,
    },
    video: {
      width: p.probe.width,
      height: p.probe.height,
      fps: p.probe.fps,
      fps_rational: p.probe.fps_rational,
      vfr: false,
      frames: p.probe.num_frames,
      counted_frames: null,
      codec: "hevc",
      profile: "Main 10",
      bit_depth: 10,
      bitrate_bps: 41_200_000,
      color_transfer: p.hdr_output ? "arib-std-b67" : null,
      color_primaries: p.hdr_output ? "bt2020" : null,
      rotation: 0,
    },
    source_crop: p.crop ?? null,
    audio: { codec: "aac", channels: 2, sample_rate: 48000, bitrate_bps: 256_000 },
    stereo: { spatial: false, layout: null },
    camera: { make: "Example", model: "Camera One" },
  };
}

function projectDetail(p: Project) {
  const conversions = [...mockDb.conversions.values()]
    .filter((c) => c.project_id === p.project_id)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const details = mockSourceDetails(p);
  return {
    ...p,
    method: projectMethod(p),
    ...(p.probe ? { qualities: lifelikeQualities(p) } : {}),
    ...(details ? { source_details: details } : {}),
    conversions,
  };
}

/** One poll = one lifecycle tick (paid→processing→succeeded). Pro
 * conversions enter at "paid" (billing verified up front) — there is no
 * client payment confirmation step anymore. */
const LIFELIKE_TICKS: readonly { stage: string; progress: number }[] = [
  { stage: "plan", progress: 0.1 },
  { stage: "render", progress: 0.45 },
  { stage: "encode", progress: 0.8 },
  { stage: "publish", progress: 0.95 },
];

function tick(c: Conversion) {
  // A pre-charged run's card payment clears on the next poll.
  if (c.state === "created" && c.billing?.status === "charge_pending") {
    c.state = "paid";
    c.billing = { status: "charged", charged_cents: c.quote.amount_cents };
    return;
  }
  // Queued for a free GPU: one poll of waiting (stage queued, no progress)
  if (c.state === "paid" && (c.method === "lifelike" || mockDb.nextWaitsForGpu)) {
    if (c.method !== "lifelike") mockDb.nextWaitsForGpu = false;
    c.state = "processing";
    c.stage = c.method === "lifelike" ? "queued" : "preprocess";
    c.progress = 0;
    c.waiting_for_gpu = true;
    c.queued_s = 12;
    return;
  }
  if (c.state === "processing" && c.waiting_for_gpu) {
    const waited = (c.queued_s ?? 0) / 12;
    if (waited < mockDb.gpuWaitPolls) {
      c.queued_s = (c.queued_s ?? 0) + 12;
      return;
    }
  }
  if (c.method === "lifelike" && c.state === "processing") {
    c.waiting_for_gpu = false;
    // gateway 00178: when it left the line
    c.started_at ??= new Date().toISOString();
    const i = LIFELIKE_TICKS.findIndex((t) => t.stage === c.stage);
    const next = LIFELIKE_TICKS[i + 1];
    if (next) {
      c.stage = next.stage;
      c.progress = next.progress;
      c.eta_seconds = Math.round((1 - next.progress) * 120);
    } else {
      c.state = "succeeded";
      c.stage = "done";
      c.progress = 1;
      c.eta_seconds = 0;
      succeed(c);
    }
    return;
  }
  if (c.state === "processing" && c.waiting_for_gpu) c.waiting_for_gpu = false;
  if (c.state === "paid") {
    c.state = "processing";
    c.started_at ??= new Date().toISOString();
    c.progress = 0.1;
    c.stage = "preprocess";
  } else if (c.state === "processing") {
    c.progress = Math.min((c.progress ?? 0) + 0.3, 1);
    c.stage = c.progress < 0.5 ? "video_depth" : "video_stereo";
    if (c.progress >= 1) {
      c.state = "succeeded";
      c.stage = "";
      succeed(c);
    }
  }
}

/** The gateway's GET /v1/billing response shape. */
/** The account's Pro credit (gateway 00166), or null: paid Pro only, and
 * a Business or Studio plan's credit wins. mockDb.proCredit overrides. */
function mockProCredit() {
  if (mockDb.proCredit !== undefined) return mockDb.proCredit;
  if (mockDb.pro !== true || isTeamPlan(mockDb.billing.plan)) return null;
  const granted = new Date();
  const expires = new Date(granted.getTime() + MOCK_PRO_CREDIT.expires_days * 86_400_000);
  return {
    cents: MOCK_PRO_CREDIT.cents,
    kind: mockDb.proStatus?.plan_id ?? "pro_monthly",
    source: "web" as const,
    trial: false,
    granted: true,
    granted_at: granted.toISOString(),
    expires_at: expires.toISOString(),
    left_cents: MOCK_PRO_CREDIT.cents,
  };
}

function billingStatus() {
  const b = mockDb.billing;
  return {
    has_payment_method: b.hasPaymentMethod,
    ...(b.hasPaymentMethod && b.card ? { card: b.card } : {}),
    delinquent: b.unpaid.length > 0,
    unpaid: b.unpaid,
    ...(b.pending ? { pending: b.pending } : {}),
    // spec v7: the prepaid balance (the batch pill's old field is gone)
    balance: prepaidSummary(),
    // pricing 2026-11: Business / Studio
    ...(b.plan ? { plan: b.plan } : {}),
    ...(b.duesRetry ? { dues_retry: b.duesRetry } : {}),
    ...(b.batchRetry ? { retry: b.batchRetry } : {}),
    // owner 2026-11-07: the Pro credit (none under a team plan)
    pro_credit: mockProCredit(),
    tier: {
      cap_cents: b.batchCapCents,
      window_hours: 1,
      lifetime_paid_cents: 0,
      hold_threshold_cents: b.holdThresholdCents,
      next_tier: { min_paid_cents: 20000, cap_cents: 15000 },
    },
    publishable_key: "pk_test_mock",
    // spec v6 F
    ...(b.unpaid.length > 0
      ? {
          outstanding: {
            amount_cents: b.unpaid.reduce((n, u) => n + u.amount_cents, 0),
            runs: b.unpaid.length,
            settling: b.settling,
          },
        }
      : {}),
    ...(b.card
      ? { default_method: { type: "card", label: `Visa •••• ${b.card.last4}` } }
      : {}),
    ...(b.limits ? { limits: b.limits } : {}),
    flow_state: b.underReview
      ? ("under_review" as const)
      : b.hasPaymentMethod
        ? ("credit" as const)
        : ("sheet" as const),
  };
}

/** Classic per-minute prices at the standard settings (S3D-12): 1080p
 * $4.50, 1440p $7.12, 3K $8.14, 4K $27.46 in the decisions. */
const CLASSIC_STANDARD_CENTS_PER_MINUTE: Record<string, number> = {
  "1080p": 450,
  qhd: 712,
  "3k": 814,
};

/** A plausible stored size for an output (S3D-31). */
function mockOutputBytes(c: Conversion, format: string): number {
  const seconds = c.parts?.[0]?.duration_s ?? 60;
  const perSecond: Record<string, number> = {
    mvhevc: 6_000_000,
    sbs: 4_000_000,
    half_sbs: 2_000_000,
    anaglyph: 2_000_000,
    depth: 1_000_000,
  };
  return Math.round(seconds * (perSecond[format] ?? 1_000_000));
}

/** A project card's outcome line (S3D-35), like the gateway's summary. */
function projectSummary(p: MockProject) {
  const convs = [...mockDb.conversions.values()]
    .filter((c) => c.project_id === p.project_id)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const latest = convs[0];
  const spent = convs.reduce((sum, c) => {
    const s = c.billing?.status;
    return s === "charged" || s === "batched" || s === "charge_failed" ||
      s === "charge_pending"
      ? sum + c.quote.amount_cents
      : sum;
  }, 0);
  return {
    ...(latest
      ? {
          latest_state: latest.state,
          latest_step: latest.step,
          latest_progress: latest.progress,
          ...(latest.eta_seconds ? { latest_eta_seconds: latest.eta_seconds } : {}),
          ...(latest.waiting_for_gpu ? { latest_waiting_for_gpu: true } : {}),
          ...(latest.billing ? { latest_billing_status: latest.billing.status } : {}),
        }
      : {}),
    spent_cents: spent,
  };
}

/** LL-D8: runs quoted above the threshold are charged when they start. */
function chargeTiming(amountCents: number): "before" | "after" {
  if (!mockDb.deferredPayments) return "before";
  return amountCents > mockDb.chargeBeforeCents ? "before" : "after";
}

/** The method's source cap applies to quotes and conversions too. */
function methodCapError(p: Project): ReturnType<typeof err> | null {
  const cap = mockDb.methodMaxDurationS[projectMethod(p)];
  if (cap > 0 && sourceDurationS(p) > cap) {
    return err(
      400,
      "source_too_long_for_method",
      `This video is longer than ${Math.round(cap / 60)} minutes, the most Classic 3D can take.`,
    );
  }
  return null;
}

export const handlers = [
  ...authHandlers(GATEWAY),
  ...(GATEWAY_CN !== GATEWAY ? authHandlers(GATEWAY_CN) : []),

  // the live status stream (owner 2026-11-07)
  http.get(`${GATEWAY}/v1/events`, ({ request }) => eventStream(request)),

  http.post(`${GATEWAY}/v1/customers`, () => {
    return HttpResponse.json({ customer_id: "cus_mock" });
  }),

  // ------------------------------------------------------------- billing

  // Pay-as-you-go status — also ensures the billing profile, like the
  // gateway (so the BillingProvider's first fetch is the ensure call).
  http.get(`${GATEWAY}/v1/billing`, () => {
    return HttpResponse.json(billingStatus());
  }),

  // GET /v1/billing/history (S3D-57): card charges, newest first — a
  // run over the pre-charge threshold alone, smaller runs grouped per day
  http.get(`${GATEWAY}/v1/billing/history`, ({ request }) => {
    const card = mockDb.billing.card
      ? { brand: mockDb.billing.card.brand, last4: mockDb.billing.card.last4 }
      : undefined;
    const runs = [...mockDb.conversions.values()].filter((c) =>
      ["charged", "refunded", "refund_pending", "charge_failed", "batched"].includes(
        c.billing?.status ?? "",
      ),
    );
    const item = (c: Conversion) => {
      const p = mockDb.projects.get(c.project_id ?? "");
      return {
        conversion_id: c.conversion_id,
        project_id: c.project_id ?? "",
        project_name: p?.name,
        step: c.step ?? "production",
        preset: c.params.preset,
        from_frame: c.params.from_frame,
        to_frame: c.params.to_frame,
        amount_cents: c.quote.amount_cents,
        // gateway 00178: the launch offer's line on the run
        ...((c.quote.breakdown?.campaign_cents ?? 0) > 0
          ? { campaign_cents: c.quote.breakdown!.campaign_cents, campaign_label: c.quote.breakdown!.campaign_label }
          : {}),
      };
    };
    const status = (s: string | undefined) =>
      s === "refunded" || s === "refund_pending"
        ? "refunded"
        : s === "charge_failed"
          ? "failed"
          : "paid";
    const charges: Record<string, unknown>[] = [];
    const groups = new Map<string, Conversion[]>();
    for (const c of runs) {
      if (c.charge_timing === "before" || c.quote.amount_cents > mockDb.chargeBeforeCents) {
        charges.push({
          charge_id: `ch_${c.conversion_id}`,
          created_at: c.updated_at,
          amount_cents: c.billing?.charged_cents ?? c.quote.amount_cents,
          currency: "usd",
          ...(card ? { card } : {}),
          status: status(c.billing?.status),
          receipt_url: `https://pay.stripe.com/receipts/mock/${c.conversion_id}`,
          hosted_invoice_url: `https://invoice.stripe.com/i/mock/${c.conversion_id}`,
          // owner 2026-11-07: what the card paid in its own currency
          presentment: c.presentment ?? null,
          items: [item(c)],
        });
      } else {
        const day = c.updated_at.slice(0, 10) + (c.billing?.status === "charge_failed" ? ":f" : "");
        groups.set(day, [...(groups.get(day) ?? []), c]);
      }
    }
    for (const [day, list] of groups) {
      const failed = day.endsWith(":f");
      charges.push({
        charge_id: `ch_${day.replace(/[^0-9a-z]/gi, "")}`,
        created_at: list[list.length - 1].updated_at,
        amount_cents: list.reduce((n, c) => n + c.quote.amount_cents, 0),
        currency: "usd",
        ...(card ? { card } : {}),
        status: failed ? "failed" : "paid",
        ...(failed
          ? {}
          : {
              receipt_url: `https://pay.stripe.com/receipts/mock/${day}`,
              hosted_invoice_url: `https://invoice.stripe.com/i/mock/${day}`,
            }),
        items: list.map(item),
      });
    }
    charges.sort((a, b) => ((a.created_at as string) < (b.created_at as string) ? 1 : -1));
    // spec v6 F: rows — paid charges and refunds, plus one "Payment
    // needed" row while the account owes
    const label = card ? `Visa •••• ${card.last4}` : undefined;
    const rows: Record<string, unknown>[] = [];
    const owed = mockDb.billing.unpaid;
    if (owed.length > 0) {
      rows.push({
        row_id: "row_outstanding",
        kind: "outstanding",
        created_at: new Date().toISOString(),
        amount_cents: owed.reduce((n, u) => n + u.amount_cents, 0),
        currency: "usd",
        status: "payment_needed",
        help_ref: "OWED",
        items: owed.map((u) => {
          const c = mockDb.conversions.get(u.conversion_id ?? "");
          return c ? item(c) : { conversion_id: u.conversion_id ?? "", project_id: "", step: "production", amount_cents: u.amount_cents };
        }),
      });
    }
    for (const ch of charges) {
      if (ch.status === "failed") continue;
      const id = String(ch.charge_id);
      rows.push({
        row_id: id,
        kind: "charge",
        created_at: ch.created_at,
        amount_cents: ch.amount_cents,
        currency: "usd",
        status: "paid",
        ...(label ? { payment_method: { label } } : {}),
        invoice: { hosted_invoice_url: ch.hosted_invoice_url },
        receipt_url: ch.receipt_url,
        help_ref: id.slice(-4).toUpperCase(),
        presentment: ch.presentment ?? null,
        items: ch.items,
      });
      if (ch.status === "refunded") {
        rows.push({
          row_id: `${id}_refund`,
          kind: "refund",
          created_at: ch.created_at,
          // like the gateway (history_rows.go): a refund is negative, its
          // local amount too (REV-05)
          amount_cents: -Number(ch.amount_cents),
          currency: "usd",
          status: "refunded",
          credit_note_url: `https://invoice.stripe.com/cn/mock/${id}`,
          help_ref: id.slice(-4).toUpperCase(),
          presentment: refundPresentment(ch.presentment as { amount_minor: number; currency: string } | null | undefined),
          items: ch.items,
        });
      }
    }
    // gateway ffac292: plan invoices, changes and credit, newest first;
    // filter=plan keeps those, filter=runs the rest
    const url = new URL(request.url);
    const planKinds = ["plan", "plan_change", "credit"];
    const merged = [...rows, ...mockDb.billing.planHistory].sort((a, b) =>
      String(a.created_at) < String(b.created_at) ? 1 : String(a.created_at) > String(b.created_at) ? -1 : 0,
    );
    const filter = url.searchParams.get("filter");
    const listed =
      filter === "plan"
        ? merged.filter((r) => planKinds.includes(String(r.kind)))
        : filter === "runs"
          ? merged.filter((r) => !planKinds.includes(String(r.kind)))
          : merged;
    const after = url.searchParams.get("starting_after");
    const start = after ? listed.findIndex((r) => r.row_id === after) + 1 : 0;
    const page = listed.slice(start, start + 25);
    return HttpResponse.json({ rows: page, has_more: start + 25 < listed.length, tax: "off" });
  }),

  // SetupIntent material for the onboarding Payment Element.
  http.post(`${GATEWAY}/v1/billing/setup-intent`, () => {
    return HttpResponse.json({
      client_secret: "seti_mock_secret",
      customer_id: "cus_mock",
      publishable_key: "pk_test_mock",
    });
  }),

  /** What the MockSetupPanel calls in place of stripe.confirmSetup — the
   * card is saved and becomes the default on the next status read. */
  http.post(`${GATEWAY}/__mock__/confirm-setup`, () => {
    const b = mockDb.billing;
    b.hasPaymentMethod = true;
    b.card = { ...MOCK_CARD };
    b.methods = [{ id: "pm_mock_4242", type: "card", ...MOCK_CARD, is_default: true }];
    return HttpResponse.json({ ok: true });
  }),

  // spec v7 N3: top-ups (P17)
  http.post(`${GATEWAY}/v1/billing/balance/topup`, async ({ request }) => {
    if (mockDb.billing.deletionPending) return err(403, "deletion_pending", "your account is being deleted");
    const body = (await request.json()) as { amount_cents: number; method?: string };
    const pp = mockDb.billing.prepaid;
    const max = pp.topups === 0 ? BALANCE_LIMITS.first_max : BALANCE_LIMITS.max;
    if (body.amount_cents < BALANCE_LIMITS.min || body.amount_cents > max) {
      return HttpResponse.json(
        { success: false, error: "amount_out_of_range", message: "amount out of range", details: { min: BALANCE_LIMITS.min, max } },
        { status: 422 },
      );
    }
    // 00083: the daily top-up cap, with what's left today
    const dayLeft = BALANCE_LIMITS.day_cap - mockDb.billing.topupDayCents;
    if (body.amount_cents > dayLeft) {
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      tomorrow.setUTCHours(0, 0, 0, 0);
      return HttpResponse.json(
        {
          success: false,
          error: "topup_daily_cap",
          message: "today's top-up limit is reached",
          details: { min: BALANCE_LIMITS.min, max, day_left_cents: Math.max(dayLeft, 0), day_cap_cents: BALANCE_LIMITS.day_cap, resets_at: tomorrow.toISOString() },
        },
        { status: 422 },
      );
    }
    const topup_id = `tu_${Math.random().toString(36).slice(2, 8)}`;
    if (body.method === "wechat_pay") {
      return HttpResponse.json({ topup_id, qr_image_url: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=" });
    }
    if (body.method === "alipay") {
      return HttpResponse.json({ topup_id, redirect_url: "https://mock-pay.example/alipay-topup" });
    }
    const secret = `cs_mock_topup_${topup_id}`;
    mockDb.billing.checkouts.set(secret, {
      kind: "topup",
      topup_id,
      amount_cents: body.amount_cents,
      state: "open",
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    return HttpResponse.json({
      topup_id,
      checkout: { client_secret: secret, expires_at: mockDb.billing.checkouts.get(secret)!.expires_at },
      publishable_key: "pk_test_mock",
      bonus_cents: mockTopupBonus(body.amount_cents),
    });
  }),

  // spec v7 N4/N6: auto-reload, spend limit, alert
  http.put(`${GATEWAY}/v1/billing/balance/settings`, async ({ request }) => {
    const body = (await request.json()) as {
      auto_reload?: { enabled: boolean; below_cents: number; add_cents: number };
      spend_limit_cents?: number | null;
      low_balance_cents?: number;
    };
    const pp = mockDb.billing.prepaid;
    if (body.auto_reload) {
      if (body.auto_reload.enabled && !mockDb.billing.hasPaymentMethod) {
        return err(409, "method_needed", "save a payment method first");
      }
      if (body.auto_reload.enabled && (body.auto_reload.add_cents < 1000 || body.auto_reload.add_cents < body.auto_reload.below_cents)) {
        return err(400, "invalid_request", "add at least $10 and at least the threshold");
      }
      const blocked = mockDb.billing.underReview
        ? "under_review"
        : mockDb.billing.deletionPending
          ? "deletion_pending"
          : mockDb.billing.autoReloadBlocked;
      if (body.auto_reload.enabled && blocked) {
        return HttpResponse.json(
          { success: false, error: "auto_reload_blocked", message: "auto-reload can't be turned on now", details: { reason: blocked } },
          { status: 409 },
        );
      }
      pp.auto_reload = { ...body.auto_reload };
    }
    if ("spend_limit_cents" in body) pp.spend_limit_cents = body.spend_limit_cents ?? null;
    if (body.low_balance_cents !== undefined) pp.low_balance_cents = body.low_balance_cents;
    return HttpResponse.json(prepaidSummary());
  }),

  http.get(`${GATEWAY}/v1/billing/balance/entries`, () =>
    HttpResponse.json({ entries: mockDb.billing.prepaid.entries, has_more: false }),
  ),

  // spec v7 N13: usage rows
  http.get(`${GATEWAY}/v1/billing/usage`, ({ request }) => {
    const url = new URL(request.url);
    const month = url.searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
    const pp = mockDb.billing.prepaid;
    const rows = [...mockDb.conversions.values()]
      .filter((c) => c.created_at.slice(0, 7) === month)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map((c) => {
        const p = mockDb.projects.get(c.project_id ?? "");
        const fps = p?.probe?.fps ?? 24;
        const frames = (c.params.to_frame ?? p?.probe?.num_frames ?? 0) - (c.params.from_frame ?? 0);
        const st = c.billing?.status;
        const running = !["succeeded", "failed", "canceled", "expired"].includes(c.state);
        return {
          at: c.created_at,
          project: p?.name ?? "Untitled project",
          project_id: c.project_id,
          conversion_id: c.conversion_id,
          method: c.method ?? "classic",
          preset: c.params.preset,
          minutes: Math.round((frames / fps / 60) * 100) / 100,
          cost_cents: running ? null : st === "balance_released" || c.state !== "succeeded" ? 0 : (c.billing?.charged_cents ?? c.quote.amount_cents),
          paid_with: st?.startsWith("balance") ? "balance" : "card",
          status: running ? "running" : st === "balance_released" || c.state !== "succeeded" ? "released" : "done",
          ...(running && pp.holds.has(c.conversion_id) ? { reserved_cents: pp.holds.get(c.conversion_id) } : {}),
        };
      });
    if (url.searchParams.get("format") === "csv") {
      const lines = ["date,project,method,preset,minutes,cost,paid_with,status", ...rows.map((r) => [r.at.slice(0, 10), r.project, r.method, r.preset, r.minutes, ((r.cost_cents ?? 0) / 100).toFixed(2), r.paid_with, r.status].join(","))];
      return new HttpResponse(lines.join("\n"), { headers: { "Content-Type": "text/csv" } });
    }
    return HttpResponse.json({ rows, has_more: false });
  }),

  // spec v6 F: pay this run on another device (P7)
  http.post(`${GATEWAY}/v1/conversions/:id/handoff`, async ({ params, request }) => {
    const c = mockDb.conversions.get(params.id as string);
    if (!c) return err(404, "not_found", "conversion not found");
    if (c.state !== "created") return err(409, "already_paid", "this run is already paid");
    const body = (await request.json().catch(() => ({}))) as { email?: boolean };
    const b = mockDb.billing;
    let code = [...b.handoffs].find(([, h]) => h.conversion_id === c.conversion_id && h.state !== "expired")?.[0];
    if (!code) {
      const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
      const pick = () => abc[Math.floor(Math.random() * abc.length)];
      code = Array.from({ length: 8 }, pick).join("");
      b.handoffs.set(code, {
        conversion_id: c.conversion_id,
        state: "open",
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
    }
    const h = b.handoffs.get(code)!;
    return HttpResponse.json({
      code,
      url: `https://stereo3d.studio/p/${code.slice(0, 4)}-${code.slice(4)}`,
      qr_image_url: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
      expires_at: h.expires_at,
      ...(body.email ? { email_masked: "d•••@example.com" } : {}),
    });
  }),

  // spec v6 F: what a hand-off link pays for (public, read-only, P8)
  http.get(`${GATEWAY}/v1/handoff/:code`, ({ params }) => {
    const b = mockDb.billing;
    if (b.handoffRateLimited) return err(429, "rate_limited", "too many tries");
    const code = String(params.code).replace(/-/g, "").toUpperCase();
    const h = b.handoffs.get(code);
    if (!h) return err(404, "not_found", "no such link");
    const c = mockDb.conversions.get(h.conversion_id)!;
    if (c.state !== "created") h.state = "paid";
    return HttpResponse.json({
      label: `${c.step === "production" ? "3D video" : "Preview"} · ${qualityNameMock(c.params.preset)}`,
      amount_cents: c.quote.amount_cents,
      currency: "usd",
      email_masked: "d•••@example.com",
      china: false,
      expires_at: h.expires_at,
      state: h.state,
    });
  }),

  // spec v6 F: pay through the link (public): the mock's hosted page pays
  // at once and comes back to return_url
  http.post(`${GATEWAY}/v1/handoff/:code/pay`, async ({ params, request }) => {
    const b = mockDb.billing;
    const code = String(params.code).replace(/-/g, "").toUpperCase();
    const h = b.handoffs.get(code);
    if (!h) return err(404, "not_found", "no such link");
    if (h.state === "expired") return err(409, "expired", "this link expired");
    const body = (await request.json().catch(() => ({}))) as { method?: string; return_url?: string };
    const c = mockDb.conversions.get(h.conversion_id)!;
    if (c.state !== "created") return err(409, "already_paid", "already paid");
    if (body.method === "wechat_pay") {
      h.state = "paying";
      return HttpResponse.json({
        qr_image_url: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
        expires_at: h.expires_at,
      });
    }
    h.state = "paid";
    c.state = "paid";
    c.billing = { status: "charged", charged_cents: c.quote.amount_cents };
    const back = body.return_url ?? "/";
    return HttpResponse.json(body.method === "alipay" ? { redirect_url: back } : { url: back });
  }),

  // spec v6.2: saved methods in backup order, default first, managed here
  http.get(`${GATEWAY}/v1/billing/methods`, () => HttpResponse.json(methodsBody())),

  http.post(`${GATEWAY}/v1/billing/methods/setup`, async ({ request }) => {
    const b = mockDb.billing;
    if (b.methods.length >= 5) return err(409, "too_many_methods", "at most 5 payment methods");
    const body = (await request.json().catch(() => ({}))) as { make_default?: boolean };
    const secret = `cs_mock_setup_${Math.random().toString(36).slice(2, 8)}`;
    b.checkouts.set(secret, {
      kind: "setup",
      amount_cents: 0,
      state: "open",
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      ...(body.make_default ? { conversion_id: "make_default" } : {}),
    });
    return HttpResponse.json({ client_secret: secret, publishable_key: "pk_test_mock" });
  }),

  http.post(`${GATEWAY}/v1/billing/methods/:id/default`, ({ params }) => {
    const b = mockDb.billing;
    const m = b.methods.find((x) => x.id === params.id);
    if (!m) return err(404, "not_found", "no such method");
    b.methods = [m, ...b.methods.filter((x) => x !== m)].map((x) => ({ ...x, is_default: x === m }));
    return HttpResponse.json(methodsBody());
  }),

  http.put(`${GATEWAY}/v1/billing/methods/order`, async ({ request }) => {
    const b = mockDb.billing;
    const { ids } = (await request.json()) as { ids: string[] };
    const byId = new Map(b.methods.map((m) => [m.id, m]));
    if (ids.length !== b.methods.length || ids.some((id) => !byId.has(id))) {
      return err(400, "invalid_request", "ids must list every method");
    }
    b.methods = ids.map((id, i) => ({ ...byId.get(id)!, is_default: i === 0 }));
    return HttpResponse.json(methodsBody());
  }),

  http.delete(`${GATEWAY}/v1/billing/methods/:id`, ({ params }) => {
    const b = mockDb.billing;
    if (b.methods.length === 1 && b.unpaid.length > 0) {
      return err(409, "method_needed", "the last payment method can't go while a payment is pending");
    }
    const was = b.methods.find((x) => x.id === params.id);
    b.methods = b.methods.filter((x) => x.id !== params.id);
    if (was?.is_default && b.methods[0]) b.methods[0] = { ...b.methods[0], is_default: true };
    if (b.methods.length === 0) {
      b.hasPaymentMethod = false;
      b.card = undefined;
    }
    return HttpResponse.json(methodsBody());
  }),

  http.get(`${GATEWAY}/v1/billing/company`, () => HttpResponse.json(mockDb.billing.company)),

  // owner 2026-11-04: the business details on invoices; Stripe checks
  // the tax ID (the mock: GB VAT is GB + 9 digits, EU VAT 2 letters + 8–12)
  http.put(`${GATEWAY}/v1/billing/company`, async ({ request }) => {
    const body = (await request.json()) as CompanyDetails;
    const t = body.tax_id;
    if (t?.value) {
      const v = t.value.replace(/\s/g, "").toUpperCase();
      const ok =
        t.type === "gb_vat" ? /^GB\d{9}$/.test(v) : t.type === "eu_vat" ? /^[A-Z]{2}[0-9A-Z]{8,12}$/.test(v) : v.length >= 4;
      if (!ok) return err(400, "invalid_tax_id", `Invalid value for ${t.type}: ${t.value}. Check the number and its country.`);
      body.tax_id = { type: t.type, value: v, verification: "pending" };
    }
    mockDb.billing.company = { ...mockDb.billing.company, ...body };
    return HttpResponse.json(mockDb.billing.company);
  }),

  http.get(`${GATEWAY}/v1/billing/invoices`, () => {
    const invoices = [...mockDb.conversions.values()]
      .filter((c) => c.billing?.status === "charged" || c.billing?.status === "refunded")
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .map((c, i) => ({
        invoice_id: `in_${c.conversion_id}`,
        number: `S3D-${String(1000 + i)}`,
        created_at: c.updated_at,
        amount_cents: c.quote.amount_cents,
        currency: "usd",
        pdf_url: `https://invoice.stripe.com/pdf/mock/${c.conversion_id}`,
        ...(c.billing?.status === "refunded"
          ? {
              credit_notes: [
                {
                  id: `cn_${c.conversion_id}`,
                  number: `S3D-${String(1000 + i)}-CN1`,
                  created_at: c.updated_at,
                  amount_cents: c.quote.amount_cents,
                  pdf_url: `https://invoice.stripe.com/cn/pdf/mock/${c.conversion_id}`,
                },
              ],
            }
          : {}),
      }));
    return HttpResponse.json({ invoices, has_more: false });
  }),

  // S3D-61: pay a pay-now run without the Payment Element (China mode)
  http.post(`${GATEWAY}/v1/conversions/:id/pay-now`, async ({ params, request }) => {
    const c = mockDb.conversions.get(params.id as string);
    if (!c) return err(404, "not_found", "conversion not found");
    const body = (await request.json()) as {
      method?: string;
      return_url?: string;
      ui?: string;
      replace?: boolean;
    };
    // spec v6 F: the run's open payment for our sheet
    if (body.ui === "elements") {
      if (c.state !== "created") return err(409, "already_paid", "this run is already paid");
      const live = body.replace ? undefined : liveCheckout(c.conversion_id);
      if (body.replace) {
        for (const ch of mockDb.billing.checkouts.values()) {
          if (ch.conversion_id === c.conversion_id && ch.state === "open") ch.state = "expired";
        }
      }
      const checkout = live
        ? { client_secret: live, expires_at: mockDb.billing.checkouts.get(live)!.expires_at }
        : openCheckout({ kind: "run", conversion_id: c.conversion_id, amount_cents: c.quote.amount_cents });
      return HttpResponse.json({
        checkout,
        amount_cents: c.quote.amount_cents,
        publishable_key: "pk_test_mock",
      });
    }
    const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    if (body.method === "alipay") {
      return HttpResponse.json({
        method: "alipay",
        redirect_url: `https://mock-pay.example/alipay?return=${encodeURIComponent(body.return_url ?? "")}`,
        expires_at: expires,
      });
    }
    if (body.method === "wechat_pay") {
      return HttpResponse.json({
        method: "wechat_pay",
        qr_image_url: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
        expires_at: expires,
      });
    }
    return err(400, "invalid_request", "method must be alipay|wechat_pay");
  }),

  // mock-only: the customer paid a pay-now run (Payment Element or QR)
  http.post(`${GATEWAY}/__mock__/complete-payment/:id`, ({ params }) => {
    const c = mockDb.conversions.get(params.id as string);
    if (!c) return err(404, "not_found", "conversion not found");
    c.state = "paid";
    c.billing = { status: "charged", charged_cents: c.quote.amount_cents };
    return HttpResponse.json(c);
  }),

  // gateway 00094: a sales enquiry (5 a day per account)
  http.post(`${GATEWAY}/v1/contact`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      topic?: string; message?: string; company?: string; team_size?: string;
    };
    const message = (body.message ?? "").trim();
    if (
      !["business", "studio", "other"].includes(String(body.topic)) ||
      message.length < 1 || message.length > 2000 ||
      (body.company?.length ?? 0) > 120 || (body.team_size?.length ?? 0) > 120
    ) {
      return err(400, "invalid_request", "topic and a message of 1–2000 characters are required");
    }
    if (mockDb.events.filter((e) => e.name === "contact").length >= 5) {
      return err(429, "rate_limited", "Too many messages today. Write to support@stereo3d.studio instead.");
    }
    mockDb.events.push({ name: "contact", props: { ...body }, at: new Date().toISOString() });
    return HttpResponse.json({ sent: true });
  }),

  // attribution: the gateway reads the Pro state again after a purchase
  http.post(`${GATEWAY}/v1/pro/refresh`, () => HttpResponse.json({ pro: mockDb.pro === true, known: true })),

  // owner 2026-11-04: web Pro → Business/Studio, priced before confirming
  http.post(`${GATEWAY}/v1/plans/preview-change`, async ({ request }) => {
    const { to } = (await request.json().catch(() => ({}))) as { to?: string };
    const unavailable = planUnavailable(to);
    if (unavailable) return unavailable;
    const target = planTarget(to);
    if (!target) return err(400, "invalid_request", "unknown plan");
    const current = currentPlanKey();
    // owner 2026-11-04: a step-down starts at the end of the paid period
    const quote_at = new Date().toISOString();
    if (PLAN_RANK[target.id] < PLAN_RANK[current]) {
      return HttpResponse.json({
        from: current,
        to,
        quote_at,
        kind: "step_down",
        today_cents: 0,
        new_plan_cents: target.price,
        effective_at: currentPeriodEnd(),
        currency: "usd",
      });
    }
    // owner 2026-11-04: paid × min(time left, usage left)
    const basis = creditBasis();
    const unused = basis ? Math.round(basis.paid_cents * Math.min(basis.time_share, basis.usage_share)) : 450;
    const renews = new Date();
    if (target.interval === "year") renews.setFullYear(renews.getFullYear() + 1);
    else if (target.interval === "week") renews.setDate(renews.getDate() + 7);
    else renews.setMonth(renews.getMonth() + 1);
    return HttpResponse.json({
      from: current,
      to,
      quote_at,
      kind: "step_up",
      today_cents: target.price - unused,
      new_plan_cents: target.price,
      unused_credit_cents: unused,
      ...(basis ? { credit_basis: basis } : {}),
      renews_at: renews.toISOString(),
      currency: "usd",
    });
  }),
  http.post(`${GATEWAY}/v1/plans/change`, async ({ request }) => {
    const { to, confirm } = (await request.json().catch(() => ({}))) as {
      to?: string;
      confirm?: boolean;
      quote_at?: string;
    };
    if (confirm !== true)
      return err(400, "confirm_required", "confirm is required");
    const target = planTarget(to);
    if (!target) return err(400, "invalid_request", "unknown plan");
    if (mockDb.nextChangeExpired) {
      mockDb.nextChangeExpired = false;
      return err(
        409,
        "quote_expired",
        "That price is out of date. Check the new one.",
      );
    }
    const unavailable = planUnavailable(target.id);
    if (unavailable) return unavailable;
    const current = currentPlanKey();
    if (target.id === current)
      return err(409, "same_plan", "You're already on that plan.");
    // cancelling replaces a waiting step-down (the gateway agent,
    // 2026-11-06); any other change waits for it to be taken back
    if (mockDb.billing.plan?.scheduled_change && target.id !== "pay_per_video")
      return err(
        409,
        "change_scheduled",
        "A change is already scheduled. Keep your plan first.",
      );
    mockDb.planChanges.push(target.id);
    if (PLAN_RANK[target.id] < PLAN_RANK[current]) {
      const scheduled = { to: target.id, effective_at: currentPeriodEnd() };
      if (mockDb.billing.plan?.active)
        mockDb.billing.plan.scheduled_change = scheduled;
      if (mockDb.proStatus)
        mockDb.proStatus = {
          ...mockDb.proStatus,
          scheduled_change: scheduled,
        } as typeof mockDb.proStatus;
      return HttpResponse.json({
        plan: current,
        status: "active",
        scheduled_change: scheduled,
      });
    }
    if (target.id.startsWith("pro_")) {
      startMockPro(target.id);
      return HttpResponse.json({ plan: target.id, status: "active" });
    }
    // BUX-25: the yearly Business is Business with its own price and year
    const yearlyBiz = target.id === "business_yearly";
    const key = (yearlyBiz ? "business" : target.id) as "business" | "studio";
    const def = yearlyBiz ? businessYearlyMock() : TIERS.plans[key];
    // a step-up starts at once: a full period from today
    const end = new Date();
    if (def.interval === "year") end.setUTCFullYear(end.getUTCFullYear() + 1);
    else end.setUTCMonth(end.getUTCMonth() + 1);
    mockDb.billing.plan = {
      plan: key, name: def.name, status: "active", active: true, monthly_cents: def.monthly_cents,
      credit_cents: def.credit_cents, credit_left_cents: def.credit_cents, cancel_at_period_end: false,
      current_period_end: end.toISOString(), interval: def.interval as "month" | "year", price_cents: def.price_cents,
      ...(yearlyBiz ? { plan_id: "business_yearly" } : {}),
    };
    return HttpResponse.json({ plan: key, status: "active" });
  }),
  // keep the current plan: drop the scheduled step-down
  http.delete(`${GATEWAY}/v1/plans/scheduled-change`, () => {
    const plan = mockDb.billing.plan;
    if (!plan?.scheduled_change) return err(404, "not_found", "no scheduled change");
    plan.scheduled_change = null;
    if (mockDb.proStatus)
      mockDb.proStatus = { ...mockDb.proStatus, scheduled_change: null };
    return HttpResponse.json(plan);
  }),

  // owner 2026-11-04: in-app feedback, the app's store (mocked until it lands)
  http.post(`${GATEWAY}/v1/feedback`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const signedIn = (request.headers.get("Authorization") ?? "").startsWith("Bearer ");
    if (mockDb.nextFeedbackStatus) {
      const status = mockDb.nextFeedbackStatus;
      mockDb.nextFeedbackStatus = null;
      return err(status, status === 429 ? "rate_limited" : "server_error", "couldn't send");
    }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!["idea", "problem", "other"].includes(String(body.kind)) || message.length < 1 || message.length > 5000) {
      return err(400, "invalid_request", "kind and a message of 1–5000 characters are required");
    }
    if (!signedIn && !(typeof body.email === "string" && body.email.includes("@"))) {
      return err(400, "invalid_request", "email is required when signed out");
    }
    mockDb.feedback.push({ body, signed_in: signedIn, at: new Date().toISOString() });
    return HttpResponse.json({ sent: true, id: `fb${mockDb.feedback.length}` });
  }),

  // our own product events (onboarding answers): stored with the account
  http.post(`${GATEWAY}/v1/events`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { name?: string; props?: Record<string, unknown> };
    if (!body.name) return err(400, "invalid_request", "name is required");
    // gateway 00093: onboarding_headsets and the plans_surface_* events
    // owner 2026-11-04: the Business/Studio setup funnel too
    const SETUP_EVENTS = ["business_setup_opened", "business_setup_plan_picked", "business_setup_details_done", "business_setup_checkout_started", "business_setup_purchased"];
    if (body.name !== "onboarding_headsets" && body.name !== "sign_in" && !body.name.startsWith("plans_surface_") && !SETUP_EVENTS.includes(body.name)) {
      return err(400, "unknown_event", "unknown event");
    }
    // ADR 0136: the web's non-passkey sign-ins, by method
    if (body.name === "sign_in" && !["google", "apple", "email", "password", "email_code"].includes(String(body.props?.method))) {
      return err(400, "invalid_request", "method is google, apple, email, password or email_code");
    }
    if (body.name.startsWith("plans_surface_") && !PLANS_PLACEMENTS.includes(String(body.props?.placement))) {
      return err(400, "invalid_request", "placement is required");
    }
    mockDb.events.push({ name: body.name, props: body.props ?? {}, at: new Date().toISOString() });
    return HttpResponse.json({ logged: true });
  }),

  // ADR 0136: customer passkeys (the web's working shape until the gateway's)
  http.post(`${GATEWAY}/v1/auth/passkey/options`, () =>
    HttpResponse.json({
      options: { publicKey: { challenge: "bW9jay1jaGFsbGVuZ2U", rpId: mockRpId(), allowCredentials: [], userVerification: "required", timeout: 60000 } },
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    }),
  ),
  http.post(`${GATEWAY}/v1/auth/passkey/verify`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { response?: { id?: string }; session?: boolean };
    const refusal = mockDb.passkeyVerifyErrors.shift();
    if (refusal) return err(refusal.status, refusal.code, refusal.code);
    const key = mockDb.passkeys.find((p) => p.id === body.response?.id);
    if (!key) return err(404, "passkey_not_registered", "This passkey isn't registered here.");
    key.last_used_at = new Date().toISOString();
    return HttpResponse.json({ uid: "dev-user", custom_token: "mock-custom-token" });
  }),
  http.get(`${GATEWAY}/v1/account/passkeys`, () => HttpResponse.json({ passkeys: mockDb.passkeys })),
  // gateway 00155: support plan moves (RP-05)
  http.get(`${GATEWAY}/v1/support/plan-moves`, () =>
    HttpResponse.json({
      moves: mockDb.planMoves.map((m) => {
        const out: Record<string, unknown> = { ...m };
        delete out.blocker;
        delete out.expired;
        return out;
      }),
    }),
  ),
  http.post(`${GATEWAY}/v1/support/plan-moves/:id/accept`, ({ params }) => {
    const m = mockDb.planMoves.find((x) => x.id === params.id);
    if (!m) return err(404, "move_not_found", "We couldn't find that offer.");
    if (m.expired) return err(410, "move_expired", "This offer expired.");
    if (m.blocker) return err(409, m.blocker, "Your account has a plan of its own. Contact support.");
    const key = m.plan === "studio" ? "studio" : "business";
    const def = TIERS.plans[key];
    mockDb.billing.plan = {
      plan: key, name: def.name, status: "active", active: true, monthly_cents: def.monthly_cents,
      credit_cents: def.credit_cents, credit_left_cents: def.credit_cents, cancel_at_period_end: true,
      current_period_end: m.ends_at, interval: def.interval as "month" | "year", price_cents: def.price_cents,
      restored_from: "moved-account", renewable: false,
    };
    mockDb.planMoves = mockDb.planMoves.filter((x) => x.id !== m.id);
    return HttpResponse.json({ moved: true });
  }),
  // gateway 00152: Restore Purchases moves a deleted account's plan here
  http.post(`${GATEWAY}/v1/billing/restore/find`, async ({ request }) => {
    const { email } = (await request.json().catch(() => ({}))) as { email?: string };
    if (!email?.includes("@")) return err(400, "invalid_email", "that email address is not valid");
    mockAuth.codesSent.push(email.trim().toLowerCase());
    return HttpResponse.json({ success: true, sent: true, resend_after_s: 30 }, { status: 202 });
  }),
  http.post(`${GATEWAY}/v1/billing/restore/find/verify`, async ({ request }) => {
    const b = (await request.json().catch(() => ({}))) as { email?: string; code?: string };
    const email = b.email?.trim().toLowerCase();
    if (email) {
      if (!mockAuth.codesSent.includes(email)) return err(400, "code_expired", "That code has expired. Send a new one.");
      if (b.code !== MOCK_EMAIL_CODE) return err(400, "code_invalid", "That code isn't right.");
    }
    const matches = mockDb.restoreOffers.filter((o) => (email ? o.emails.includes(email) : o.own));
    const elsewhere = matches.find((o) => o.elsewhere);
    const open = matches.filter((o) => !o.elsewhere && !mockDb.restoreMoved.includes(o.offer.offer_id));
    if (open.length === 0 && elsewhere) {
      return HttpResponse.json(
        {
          success: false,
          error: "restored_elsewhere",
          message: "That plan was restored on another account. Sign in to that account to use it.",
          details: { providers: elsewhere.elsewhere },
        },
        { status: 409 },
      );
    }
    return HttpResponse.json(open.length > 0 ? { proof_id: "proof_mock", found: open.map((o) => o.offer) } : { proof_id: null, found: [] });
  }),
  http.post(`${GATEWAY}/v1/billing/restore/move`, async ({ request }) => {
    const b = (await request.json().catch(() => ({}))) as { proof_id?: string; offer_id?: string };
    const hit = mockDb.restoreOffers.find((o) => o.offer.offer_id === b.offer_id);
    if (b.proof_id !== "proof_mock" || !hit) {
      return err(400, "proof_invalid", "Find your purchases again, then restore within 15 minutes.");
    }
    if (mockDb.billing.plan?.active) {
      return err(409, "has_own_plan", "Your account has a plan of its own. Contact support to move the other one here.");
    }
    if (!mockDb.restoreMoved.includes(hit.offer.offer_id)) mockDb.restoreMoved.push(hit.offer.offer_id);
    const key = hit.offer.plan === "studio" ? "studio" : "business";
    const def = TIERS.plans[key];
    mockDb.billing.plan = {
      plan: key, name: def.name, status: "active", active: true, monthly_cents: def.monthly_cents,
      credit_cents: def.credit_cents, credit_left_cents: def.credit_cents, cancel_at_period_end: !hit.offer.renews,
      current_period_end: hit.offer.ends_at, interval: def.interval as "month" | "year", price_cents: def.price_cents,
      restored_from: "deleted-account",
    };
    return HttpResponse.json({ restored: true, message: "Your purchases are restored" });
  }),
  // gateway 00152: the email store (any host: China mode too)
  http.get(/\/v1\/account\/emails$/, () => HttpResponse.json(mockDb.accountEmails)),
  http.post(/\/v1\/account\/emails\/start$/, async ({ request }) => {
    const { email } = (await request.json().catch(() => ({}))) as { email?: string };
    if (!email?.includes("@")) return err(400, "invalid_email", "that email address is not valid");
    mockAuth.codesSent.push(email.trim().toLowerCase());
    return HttpResponse.json({ success: true, sent: true, resend_after_s: 30 }, { status: 202 });
  }),
  http.post(/\/v1\/account\/emails$/, async ({ request }) => {
    const b = (await request.json().catch(() => ({}))) as { email?: string; code?: string; make_main?: boolean };
    const email = (b.email ?? "").trim().toLowerCase();
    if (!mockAuth.codesSent.includes(email)) return err(400, "code_expired", "That code has expired. Send a new one.");
    if (b.code !== MOCK_EMAIL_CODE) return err(400, "code_invalid", "That code isn't right.");
    const taken = mockDb.emailsTakenBy.get(email);
    if (taken) {
      return HttpResponse.json(
        { success: false, error: "credential_in_use", message: "That email belongs to another account.", details: { providers: taken } },
        { status: 409 },
      );
    }
    const relay = email.endsWith("@privaterelay.appleid.com");
    const team = mockDb.billing.plan?.active && (mockDb.billing.plan.plan === "business" || mockDb.billing.plan.plan === "studio");
    if (relay && b.make_main && team) {
      return err(409, "relay_not_main", "Your plan needs a real email as its main one. Hide My Email addresses can be added as extra emails.");
    }
    const list = mockDb.accountEmails.emails;
    if (!list.some((e) => e.email === email)) {
      if (list.length >= 5) return err(409, "too_many_emails", "Your account has five emails. Remove one first.");
      list.push({ id: `em_${list.length + 1}`, email, main: false, relay, added_at: new Date().toISOString() });
    }
    let changed = false;
    if (b.make_main) {
      for (const e of list) {
        const now = e.email === email;
        if (now && !e.main) changed = true;
        e.main = now;
      }
    }
    const main = list.find((e) => e.main);
    mockDb.accountEmails.plan_email_needed = Boolean(team) && (!main || main.relay);
    return HttpResponse.json({ ...mockDb.accountEmails, refresh_token: changed });
  }),
  http.post(/\/v1\/account\/emails\/[^/]+\/main$/, ({ request }) => {
    const id = decodeURIComponent(new URL(request.url).pathname.split("/").at(-2) ?? "");
    const list = mockDb.accountEmails.emails;
    const row = list.find((e) => e.id === id);
    if (!row) return err(404, "email_not_found", "That email isn't on your account.");
    const team = mockDb.billing.plan?.active && (mockDb.billing.plan.plan === "business" || mockDb.billing.plan.plan === "studio");
    if (row.relay && team) return err(409, "relay_not_main", "Your plan needs a real email as its main one.");
    const changed = !row.main;
    for (const e of list) e.main = e.id === id;
    mockDb.accountEmails.plan_email_needed = Boolean(team) && row.relay;
    return HttpResponse.json({ ...mockDb.accountEmails, refresh_token: changed });
  }),
  http.delete(/\/v1\/account\/emails\/[^/]+$/, ({ request }) => {
    const id = decodeURIComponent(new URL(request.url).pathname.split("/").pop() ?? "");
    const list = mockDb.accountEmails.emails;
    const row = list.find((e) => e.id === id);
    if (!row) return err(404, "email_not_found", "That email isn't on your account.");
    if (row.main) return err(409, "main_email_not_removable", "Make another email main before removing this one.");
    mockDb.accountEmails.emails = list.filter((e) => e.id !== id);
    return HttpResponse.json(mockDb.accountEmails);
  }),
  // owner 2026-11-06: refund requests (gateway efa1856), a person decides
  http.get(`${GATEWAY}/v1/support/refund-options`, () => HttpResponse.json(mockDb.refundOptions)),
  http.post(`${GATEWAY}/v1/support/refund-requests`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { plan?: boolean; conversion_ids?: string[]; balance?: boolean; text?: string };
    if ((body.text ?? "").length > 2000) return err(400, "text_too_long", "Keep it under 2000 characters.");
    const opts = mockDb.refundOptions;
    const ids = body.conversion_ids ?? [];
    const bad = ids.filter((id) => !opts.runs.some((r) => r.conversion_id === id));
    // RF-02: balance: true asks about every listed top-up's unspent part
    const tops = opts.balance?.topups ?? [];
    if (!body.plan && ids.length === 0 && !body.balance) return err(400, "invalid_request", "pick the plan, the runs or the balance to ask about");
    if (bad.length > 0 || (body.plan && !opts.plan) || (body.balance && tops.length === 0)) {
      return HttpResponse.json(
        {
          success: false,
          error: "not_refundable",
          message: "That can't be asked for: it wasn't paid in the last 30 days, or it's refunded already.",
          details: { conversion_ids: bad, plan: body.plan === true && !opts.plan, balance: body.balance === true && tops.length === 0 },
        },
        { status: 400 },
      );
    }
    const out: { id: string; state: "looking"; status: string; merged: boolean }[] = [];
    const open = (about: "plan" | "runs" | "balance", cents: number, cids: string[]) => {
      const id = `req_${mockDb.supportRequests.length + 1}`;
      mockDb.supportRequests.unshift({
        id, about, state: "looking", status: "We're looking at it", opened_at: new Date().toISOString(),
        requested_cents: cents, refunded_cents: 0, your_note: body.text ?? null, conversion_ids: cids, question: null,
        follow_up_of: null,
      });
      return id;
    };
    if (body.plan && opts.plan) {
      const merged = opts.plan.open_request_id !== null;
      const id = opts.plan.open_request_id ?? open("plan", opts.plan.paid_cents, []);
      opts.plan.open_request_id = id;
      out.push({ id, state: "looking", status: "We're looking at it", merged });
    }
    const fresh = opts.runs.filter((r) => ids.includes(r.conversion_id) && r.open_request_id === null);
    const asked = opts.runs.filter((r) => ids.includes(r.conversion_id) && r.open_request_id !== null);
    if (fresh.length > 0) {
      const id = open("runs", fresh.reduce((n, r) => n + r.amount_cents, 0), fresh.map((r) => r.conversion_id));
      for (const r of fresh) r.open_request_id = id;
      out.push({ id, state: "looking", status: "We're looking at it", merged: false });
    }
    for (const id of new Set(asked.map((r) => r.open_request_id!))) {
      out.push({ id, state: "looking", status: "We're looking at it", merged: true });
    }
    if (body.balance) {
      for (const top of tops) {
        const merged = top.open_request_id !== null;
        const id = top.open_request_id ?? open("balance", top.unspent_cents, []);
        top.open_request_id = id;
        out.push({ id, state: "looking", status: "We're looking at it", merged });
      }
    }
    return HttpResponse.json({ success: true, requests: out }, { status: 201 });
  }),
  http.get(`${GATEWAY}/v1/support/requests`, () => HttpResponse.json({ requests: mockDb.supportRequests })),
  http.post(`${GATEWAY}/v1/support/requests/:id/reply`, async ({ params, request }) => {
    const { text } = (await request.json().catch(() => ({}))) as { text?: string };
    if (!text?.trim()) return err(400, "invalid_request", "text is required");
    const r = mockDb.supportRequests.find((x) => x.id === params.id);
    if (!r) return err(404, "request_not_found", "We couldn't find that request.");
    if (["refunded", "not_refunded", "waived", "closed"].includes(r.state)) {
      // a closed request gets a follow-up
      const follow = {
        ...r, id: `req_${mockDb.supportRequests.length + 1}`, state: "looking" as const, status: "We're looking at it",
        opened_at: new Date().toISOString(), your_note: text, question: null, follow_up_of: r.id,
      };
      mockDb.supportRequests.unshift(follow);
      return HttpResponse.json(follow);
    }
    // an answered question goes back to review
    Object.assign(r, { state: "looking", status: "We're looking at it", question: null });
    return HttpResponse.json(r);
  }),
  // EM-02: sign-in methods through the gateway (gateway/README "Linked
  // sign-in methods")
  // (any host: China mode calls the cn. gateway)
  http.get(/\/v1\/account\/identities$/, () => HttpResponse.json(identitiesJSON())),
  http.post(/\/v1\/account\/identities\/link$/, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { provider?: string; id_token?: string };
    if (body.provider !== "apple.com" && body.provider !== "google.com") {
      return err(400, "invalid_request", "provider is apple.com, google.com or email");
    }
    if (!body.id_token) return err(400, "invalid_request", "id_token is required");
    if (mockDb.identityInUse) {
      return HttpResponse.json(
        {
          success: false,
          error: "credential_in_use",
          message: "That sign-in belongs to another account.",
          details: { providers: mockDb.identityInUse },
        },
        { status: 409 },
      );
    }
    if (!mockDb.identities.providers.includes(body.provider)) {
      mockDb.identities.providers = [body.provider, ...mockDb.identities.providers];
    }
    return HttpResponse.json(identitiesJSON());
  }),
  http.delete(/\/v1\/account\/identities\/[^/]+$/, ({ request }) => {
    const provider = decodeURIComponent(new URL(request.url).pathname.split("/").pop() ?? "");
    if (provider === "email") return err(409, "email_not_removable", "Your email stays as your account's address.");
    const ids = mockDb.identities;
    const has = provider === "password" ? ids.password : ids.providers.includes(provider);
    if (!has) return err(404, "not_linked", "That sign-in isn't on your account.");
    if (provider !== "password" && ids.providers.length + mockDb.passkeys.length - 1 < 1) {
      return err(409, "last_method", "That's your only way to sign in. Add another first.");
    }
    if (provider === "password") ids.password = false;
    else ids.providers = ids.providers.filter((p) => p !== provider);
    return HttpResponse.json(identitiesJSON());
  }),
  http.post(`${GATEWAY}/v1/account/passkeys/register/options`, () => {
    if (mockDb.passkeyReauthNeeded) {
      return HttpResponse.json(
        { success: false, error: "reauth_required", message: "Sign in again to add a passkey.", details: { method: "firebase" } },
        { status: 401 },
      );
    }
    return HttpResponse.json({
      options: {
        publicKey: {
          challenge: "bW9jay1jaGFsbGVuZ2U",
          rp: { id: mockRpId(), name: "Spatial Video Studio" },
          user: { id: "ZGV2LXVzZXI", name: "dev@example.com", displayName: "Dev User" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
          excludeCredentials: mockDb.passkeys.map((p) => ({ id: p.id, type: "public-key" })),
          timeout: 60000,
          attestation: "none",
        },
      },
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
  }),
  http.post(`${GATEWAY}/v1/account/passkeys/register/verify`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { response?: { id?: string }; name?: string };
    const id = body.response?.id;
    if (!id) return err(400, "passkey_invalid", "That passkey couldn't be saved.");
    if (mockDb.passkeys.some((p) => p.id === id)) return err(409, "passkey_exists", "This passkey is already on your account.");
    const passkey = { id, name: (body.name ?? "").trim().slice(0, 60) || "Passkey", device_hint: null, created_at: new Date().toISOString(), last_used_at: null };
    mockDb.passkeys.push(passkey);
    return HttpResponse.json({ passkey }, { status: 201 });
  }),
  http.patch(`${GATEWAY}/v1/account/passkeys/:id`, async ({ params, request }) => {
    const body = (await request.json().catch(() => ({}))) as { name?: string };
    const key = mockDb.passkeys.find((p) => p.id === params.id);
    if (!key) return err(404, "not_found", "No such passkey.");
    const name = (body.name ?? "").trim();
    if (!name || name.length > 60) return err(400, "invalid_request", "A name is 1 to 60 characters.");
    key.name = name;
    return HttpResponse.json({ passkey: key });
  }),
  http.delete(`${GATEWAY}/v1/account/passkeys/:id`, ({ params }) => {
    const before = mockDb.passkeys.length;
    mockDb.passkeys = mockDb.passkeys.filter((p) => p.id !== params.id);
    if (mockDb.passkeys.length === before) return err(404, "not_found", "No such passkey.");
    return HttpResponse.json({ removed: true });
  }),

  // BL-25 (gateway 00087): account settings; the intro switch needs a plan
  http.get(`${GATEWAY}/v1/account/settings`, () => HttpResponse.json(accountSettings())),
  http.patch(`${GATEWAY}/v1/account/settings`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      lifelike_intro?: boolean;
      locale?: string | null;
      headsets?: string[];
      hints_seen_add?: string[];
      onboarding?: { welcome_done?: boolean; checklist_hidden?: boolean; tips_done?: boolean; app_pro_welcome_done?: boolean };
      dismissed?: Record<string, true | string | null>;
      simulate_app_pro?: boolean;
      business_setup?: { team_size?: string; main_use?: string; headsets?: string[] };
    };
    const st = mockDb.accountSettings;
    if (body.business_setup) st.business_setup = { ...st.business_setup, ...body.business_setup };
    if (body.simulate_app_pro !== undefined) {
      st.simulate_app_pro = body.simulate_app_pro;
      // GET /v1/pro and the quotes follow, as on the test gateway
      mockDb.pro = body.simulate_app_pro;
    }
    if (body.dismissed) {
      for (const [k, v] of Object.entries(body.dismissed)) {
        // 00098: "business_note:<projectId>" for the account's own projects
        const own = k.startsWith("business_note:") && mockDb.projects.has(k.slice("business_note:".length));
        // ADR 0136: the "add a passkey" suggestion after a sign-in
        const passkeyNote = k === "passkey_suggestion";
        if (!PLANS_PLACEMENTS.includes(k) && !own && !passkeyNote) return err(400, "invalid_request", `dismissed: unknown placement "${k}"`);
        if (v === null) delete st.dismissed[k];
        else st.dismissed[k] = v === true ? new Date().toISOString() : v;
      }
    }
    if (body.headsets !== undefined) st.headsets = [...body.headsets];
    if (body.hints_seen_add) st.hints_seen = [...new Set([...st.hints_seen, ...body.hints_seen_add])];
    if (body.onboarding) st.onboarding = { ...st.onboarding, ...body.onboarding };
    if (body.lifelike_intro !== undefined) {
      if (!isTeamPlan(mockDb.billing.plan))
        return err(
          409,
          "plan_required",
          "a Business or Studio plan is needed for that",
        );
      if (mockDb.nextSettingsFails) {
        mockDb.nextSettingsFails = false;
        return err(500, "server_error", "couldn't save");
      }
      st.lifelike_intro = body.lifelike_intro;
    }
    if (body.locale !== undefined) st.locale = body.locale;
    return HttpResponse.json(accountSettings());
  }),

  // pricing 2026-11: Business / Studio subscription checkout
  http.post(`${GATEWAY}/v1/billing/plan`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { plan?: string; ui?: string };
    const unavailable = planUnavailable(body.plan);
    if (unavailable) return unavailable;
    // owner 2026-11-04: web Pro on the same checkout
    const proDef = MOCK_PRO_PLANS.find((p) => p.id === body.plan);
    if (proDef) {
      if (mockDb.pro === true)
        return err(409, "plan_active", "you already have Pro");
      const secret = `cs_mock_plan_${proDef.id}_${Math.random().toString(36).slice(2, 8)}`;
      const expires_at = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      mockDb.billing.checkouts.set(secret, {
        kind: "plan",
        plan: proDef.id as never,
        amount_cents: proDef.price_cents,
        state: "open",
        expires_at,
      });
      return HttpResponse.json({ plan: proDef.id, publishable_key: "pk_test_mock", checkout: { client_secret: secret, expires_at } });
    }
    // BUX-25: the yearly Business, only while it's on
    const yearly = body.plan === "business_yearly" && mockDb.businessYearly;
    if (yearly) body.plan = "business";
    if (body.plan !== "business" && body.plan !== "studio") {
      return err(400, "unknown_plan", "plan must be business or studio");
    }
    if (mockDb.billing.plan?.active)
      return err(
        409,
        "plan_active",
        "you already have a plan; change it instead",
      );
    const secret = `cs_mock_plan_${body.plan}_${Math.random().toString(36).slice(2, 8)}`;
    const expires_at = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    mockDb.billing.checkouts.set(secret, {
      kind: "plan",
      plan: body.plan,
      amount_cents: yearly ? businessYearlyMock().price_cents : TIERS.plans[body.plan].monthly_cents,
      state: "open",
      expires_at,
      ...(yearly ? { yearly: true } : {}),
    });
    return HttpResponse.json({ plan: body.plan, publishable_key: "pk_test_mock", checkout: { client_secret: secret, expires_at } });
  }),

  http.post(`${GATEWAY}/v1/billing/plan/cancel`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { resume?: boolean };
    const plan = mockDb.billing.plan;
    if (!plan?.active) return err(404, "no_plan", "you don't have a plan");
    plan.cancel_at_period_end = !body.resume;
    return HttpResponse.json(plan);
  }),

  // spec v6: what our sheet's confirm does in the mock (in place of the
  // processor): paid / declined / processing / too_many
  // BUX-20: one tap on the saved default for a pay-first run
  http.post(`${GATEWAY}/v1/conversions/:id/pay-one-tap`, async ({ params, request }) => {
    const o = mockDb.oneTap;
    o.taps += 1;
    const c = mockDb.conversions.get(String(params.id));
    if (!c) return err(404, "not_found", "conversion not found");
    const body = (await request.json().catch(() => ({}))) as { amount_cents?: number };
    const refused = oneTapRefusal();
    if (refused) return refused;
    if (c.state !== "created") return err(409, "already_paid", "this is already paid");
    const amount = o.serverAmountCents ?? c.quote.amount_cents;
    if (body.amount_cents !== amount) {
      return HttpResponse.json(
        { success: false, error: "amount_changed", message: "The amount changed. Check it and pay again.", details: { amount_cents: amount } },
        { status: 409 },
      );
    }
    // like the gateway: the run's fields, then the tap's (its state wins)
    const run = { ...c, amount_cents: amount, publishable_key: "pk_test_mock" };
    switch (o.outcome) {
      case "succeeded":
        oneTapPaid("run", c.conversion_id, amount);
        return HttpResponse.json({ ...run, ...mockDb.conversions.get(c.conversion_id), ...tapFields("succeeded", mockDb.conversions.get(c.conversion_id)?.state) });
      case "processing":
        c.billing = { status: "waiting_for_payment" };
        return HttpResponse.json({ ...run, billing: c.billing, ...tapFields("processing", c.state) });
      case "requires_action":
        o.pending = { kind: "run", id: c.conversion_id, amount };
        return HttpResponse.json({ ...run, ...tapFields("requires_action", c.state), client_secret: `pi_mock_onetap_${c.conversion_id}` });
      default:
        return HttpResponse.json({ ...run, ...tapFields("declined", c.state), message: "Your card has insufficient funds.", decline_code: "insufficient_funds" });
    }
  }),

  // BUX-20: one tap on the saved default for what the account owes
  http.post(`${GATEWAY}/v1/billing/settle/one-tap`, async ({ request }) => {
    const o = mockDb.oneTap;
    const b = mockDb.billing;
    o.taps += 1;
    const body = (await request.json().catch(() => ({}))) as { amount_cents?: number; settle_id?: string };
    const refused = oneTapRefusal();
    if (refused) return refused;
    const owed = b.unpaid.reduce((n, u) => n + u.amount_cents, 0);
    const base = { publishable_key: "pk_test_mock", settle_id: "st_mock", runs: b.unpaid.length };
    if (owed === 0) return HttpResponse.json({ ...base, settled: true, payment_state: "paid", amount_cents: 0, ...tapFields("succeeded") });
    const amount = o.serverAmountCents ?? owed;
    if (body.amount_cents !== amount) {
      return HttpResponse.json(
        { success: false, error: "amount_changed", message: "The amount changed. Check it and pay again.", details: { amount_cents: amount } },
        { status: 409 },
      );
    }
    switch (o.outcome) {
      case "succeeded":
        oneTapPaid("settle", "st_mock", amount);
        return HttpResponse.json({ ...base, settled: true, payment_state: "paid", amount_cents: amount, ...tapFields("succeeded") });
      case "processing":
        b.settling = true;
        return HttpResponse.json({ ...base, settled: false, payment_state: "processing", amount_cents: amount, ...tapFields("processing") });
      case "requires_action":
        o.pending = { kind: "settle", id: "st_mock", amount };
        return HttpResponse.json({ ...base, settled: false, payment_state: "open", amount_cents: amount, ...tapFields("requires_action"), client_secret: "pi_mock_onetap_settle" });
      default:
        return HttpResponse.json({ ...base, settled: false, payment_state: "open", amount_cents: amount, ...tapFields("declined"), message: "Your card has insufficient funds.", decline_code: "insufficient_funds" });
    }
  }),

  // mock-only: the bank's check on a one-tap (stripe.handleNextAction)
  http.post(`${GATEWAY}/__mock__/one-tap-action`, () => {
    const o = mockDb.oneTap;
    const p = o.pending;
    if (o.actionOutcome === "failed") {
      return HttpResponse.json({ error: { message: "We couldn't confirm it with your bank." } }, { status: 402 });
    }
    if (p && o.actionOutcome === "succeeded") oneTapPaid(p.kind, p.id, p.amount);
    if (p && o.actionOutcome === "processing" && p.kind === "settle") mockDb.billing.settling = true;
    o.pending = null;
    return HttpResponse.json({ status: o.actionOutcome });
  }),

  // D7: the payment a failure mail links to (public)
  http.get(`${GATEWAY}/v1/pay-requests/:token`, ({ params }) => {
    const r = mockDb.payRequests.get(String(params.token));
    if (!r) return err(404, "pay_link_not_found", "no such payment link");
    return HttpResponse.json({
      label: r.label,
      amount_cents: r.amount_cents,
      currency: r.currency,
      state: r.state,
      ...(r.kind ? { kind: r.kind } : {}),
      ...(r.plan_name ? { plan_name: r.plan_name } : {}),
    });
  }),
  http.post(`${GATEWAY}/v1/pay-requests/:token/checkout`, ({ params }) => {
    const token = String(params.token);
    const r = mockDb.payRequests.get(token);
    if (!r) return err(404, "pay_link_not_found", "no such payment link");
    if (r.state === "paid") return HttpResponse.json({ state: "paid" });
    if (r.state !== "open") {
      return HttpResponse.json({ error: "pay_link_closed", message: "this payment link is closed", details: { state: r.state } }, { status: 409 });
    }
    if (r.inProgress) return err(409, "payment_in_progress", "a payment is already in progress");
    const amount = r.todayCents ?? r.amount_cents;
    if (r.flow === "url") return HttpResponse.json({ url: `https://invoice.stripe.com/i/mock/${token}`, amount_cents: amount });
    const secret = `cs_mock_pr_${token}_${newId()}`;
    const expires = new Date(Date.now() + 30 * 60_000).toISOString();
    mockDb.billing.checkouts.set(secret, { kind: "pay_request", token, amount_cents: amount, state: "open", expires_at: expires });
    return HttpResponse.json({ checkout: { client_secret: secret, expires_at: expires }, publishable_key: "pk_test_mock", amount_cents: amount });
  }),

  http.post(`${GATEWAY}/__mock__/checkout/:secret/confirm`, ({ params }) => {
    const b = mockDb.billing;
    const ch = b.checkouts.get(params.secret as string);
    if (!ch) return err(404, "not_found", "no such payment");
    if (ch.state === "expired") return HttpResponse.json({ result: "expired" });
    if (ch.state === "paid") return HttpResponse.json({ result: "already_paid" });
    if (ch.kind === "pay_request") {
      if (b.nextConfirm !== "paid") return HttpResponse.json({ result: b.nextConfirm });
      ch.state = "paid";
      const r = mockDb.payRequests.get(ch.token ?? "");
      if (r) r.state = "paid";
      return HttpResponse.json({ result: "paid" });
    }
    if (ch.kind === "plan" && String(ch.plan).startsWith("pro_")) {
      ch.state = "paid";
      startMockPro(String(ch.plan));
      b.hasPaymentMethod = true;
      return HttpResponse.json({ result: "paid" });
    }
    if (ch.kind === "plan" && ch.plan) {
      ch.state = "paid";
      const def = ch.yearly ? businessYearlyMock() : TIERS.plans[ch.plan];
      const yearly = def.interval === "year";
      const end = new Date();
      if (yearly) end.setUTCFullYear(end.getUTCFullYear() + 1);
      else end.setUTCMonth(end.getUTCMonth() + 1);
      const resets = new Date();
      resets.setUTCMonth(resets.getUTCMonth() + 1);
      b.plan = {
        plan: ch.plan,
        ...(ch.yearly ? { plan_id: "business_yearly" } : {}),
        name: def.name,
        status: "active",
        active: true,
        monthly_cents: def.monthly_cents,
        credit_cents: def.credit_cents,
        credit_left_cents: def.credit_cents,
        current_period_end: end.toISOString(),
        cancel_at_period_end: false,
        interval: def.interval as "month" | "year",
        price_cents: def.price_cents,
        credit_interval: def.credit_interval,
        // plans.go planJSON: month k+1 of 12 for a yearly plan
        ...(yearly ? { month_index: 1, credit_resets_at: resets.toISOString() } : {}),
      };
      b.hasPaymentMethod = true;
      if (b.methods.length === 0) {
        b.card = { ...MOCK_CARD };
        b.methods = [{ id: "pm_mock_4242", type: "card", ...MOCK_CARD, is_default: true }];
      }
      // gateway ffac292: the first invoice and the usage credit as rows
      const inv = `in_mock_${ch.plan}_${b.planHistory.length + 1}`;
      const now = new Date().toISOString();
      const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
      b.planHistory.push(
        {
          row_id: `plan_${inv}`,
          kind: "plan",
          created_at: now,
          amount_cents: def.price_cents,
          currency: "usd",
          status: "paid",
          payment_method: { label: `Visa •••• ${MOCK_CARD.last4}` },
          invoice: {
            hosted_invoice_url: `https://invoice.stripe.com/i/mock/${inv}`,
            invoice_pdf: `https://pay.stripe.com/invoice/mock/${inv}/pdf`,
          },
          receipt_url: `https://pay.stripe.com/receipts/mock/${inv}`,
          help_ref: inv.slice(-4).toUpperCase(),
          label: `${def.name} plan · ${yearly ? "yearly" : "monthly"}`,
          plan: { tier: ch.plan, interval: yearly ? "yearly" : "monthly", reason: "first", invoice_id: inv },
          lines: [{ description: `${def.name} plan`, amount_cents: def.price_cents }],
          items: [],
        },
        {
          row_id: `credit_${inv}`,
          kind: "credit",
          created_at: now,
          amount_cents: 0,
          currency: "usd",
          status: "applied",
          help_ref: "",
          label: `Usage credit added · ${usd(def.credit_cents)}`,
          credit: { cents: def.credit_cents, kind: "granted" },
          items: [],
        },
      );
      return HttpResponse.json({ result: "paid" });
    }
    if (ch.kind === "topup") {
      const pp = b.prepaid;
      const outcome = pp.nextTopup;
      pp.nextTopup = "paid";
      if (outcome === "declined") return HttpResponse.json({ result: "declined" });
      ch.state = "paid";
      b.topupDayCents += ch.amount_cents;
      addTopup(ch.amount_cents, "topup", "Visa •••• 4242", ch.topup_id);
      // BUX-23: the bonus is its own ledger row, usage credit only
      const bonus = mockTopupBonus(ch.amount_cents);
      if (bonus > 0) {
        b.prepaid.balance_cents += bonus;
        b.prepaid.entries.unshift({ id: `be_${b.prepaid.entries.length + 1}`, kind: "topup_bonus", cents: bonus, at: new Date().toISOString(), ...(ch.topup_id ? { topup_id: ch.topup_id } : {}) });
      }
      b.hasPaymentMethod = true;
      if (b.methods.length === 0) {
        b.card = { ...MOCK_CARD };
        b.methods = [{ id: "pm_mock_4242", type: "card", ...MOCK_CARD, is_default: true }];
      }
      return HttpResponse.json({ result: "paid" });
    }
    if (ch.kind === "setup") {
      const outcome = b.nextSetup;
      b.nextSetup = "saved";
      if (outcome === "declined") return HttpResponse.json({ result: "declined" });
      if (outcome === "too_many") return HttpResponse.json({ result: "too_many" });
      ch.state = "paid";
      const n = b.methods.length;
      const last4 = ["5454", "4444", "1881", "0005"][n % 4];
      const added = {
        id: `pm_mock_${last4}_${n}`,
        type: "card" as const,
        brand: "mastercard",
        last4,
        exp_month: 12,
        exp_year: 2031,
        is_default: n === 0 || ch.conversion_id === "make_default",
        added_at: new Date().toISOString(),
      };
      b.methods = added.is_default
        ? [added, ...b.methods.map((m) => ({ ...m, is_default: false }))]
        : [...b.methods, added];
      b.hasPaymentMethod = true;
      return HttpResponse.json({ result: "paid" });
    }
    const outcome = b.nextConfirm;
    b.nextConfirm = "paid";
    if (outcome !== "paid") {
      if (outcome === "processing") {
        if (ch.kind === "settle") b.settling = true;
        const c = ch.conversion_id ? mockDb.conversions.get(ch.conversion_id) : undefined;
        if (c) c.billing = { ...c.billing!, status: "waiting_for_payment" };
      }
      return HttpResponse.json({ result: outcome });
    }
    ch.state = "paid";
    // the method used is saved for next time (spec v6 C3)
    b.hasPaymentMethod = true;
    b.card = { ...MOCK_CARD };
    b.methods = [{ id: "pm_mock_4242", type: "card", ...MOCK_CARD, is_default: true }];
    if (ch.kind === "settle") {
      b.unpaid = [];
      b.settling = false;
      for (const c of mockDb.conversions.values()) {
        if (c.billing?.status === "charge_failed") {
          c.billing = { status: "charged", charged_cents: c.quote.amount_cents };
        }
      }
    } else if (ch.conversion_id) {
      const c = mockDb.conversions.get(ch.conversion_id);
      if (c) {
        c.state = "paid";
        c.billing = { status: "charged", charged_cents: c.quote.amount_cents };
      }
    }
    return HttpResponse.json({ result: "paid" });
  }),

  // Retry outstanding charges on the current default card.
  http.post(`${GATEWAY}/v1/billing/settle`, async ({ request }) => {
    const b = mockDb.billing;
    // spec v6 F: {ui: "elements"} → the settle's payment for our sheet (P2)
    const body = (await request.json().catch(() => ({}))) as { ui?: string; source?: string };
    // spec v7 N9: pay what's owed from the balance
    if (body.source === "balance") {
      const owed = b.unpaid.reduce((n, u) => n + u.amount_cents, 0);
      if (prepaidAvailable() < owed) return err(402, "insufficient_balance", "the balance doesn't cover it");
      b.prepaid.balance_cents -= owed;
      b.prepaid.entries.unshift({ id: `be_${b.prepaid.entries.length + 1}`, kind: "debt_payment", cents: -owed, at: new Date().toISOString() });
      b.unpaid = [];
      return HttpResponse.json({ settled: true, publishable_key: "pk_test_mock" });
    }
    if (body.ui === "elements") {
      if (b.unpaid.length === 0) return err(409, "already_paid", "nothing is owed");
      const amount = b.unpaid.reduce((n, u) => n + u.amount_cents, 0);
      let live: string | undefined;
      for (const [secret, ch] of b.checkouts) {
        if (ch.kind === "settle" && ch.state === "open") live = secret;
      }
      const checkout = live
        ? { client_secret: live, expires_at: b.checkouts.get(live)!.expires_at }
        : openCheckout({ kind: "settle", amount_cents: amount });
      return HttpResponse.json({
        checkout,
        amount_cents: amount,
        runs: b.unpaid.length,
        payment_state: b.settling ? "processing" : "open",
        publishable_key: "pk_test_mock",
        settle_id: "st_mock",
        one_tap: b.settling ? null : oneTapOffer(amount),
      });
    }
    if (b.settleOutcome === "requires_action" && b.unpaid.length > 0) {
      return HttpResponse.json({
        settled: false,
        requires_action: true,
        client_secret: `pi_mock_3ds_${b.unpaid[0].conversion_id}`,
        publishable_key: "pk_test_mock",
      });
    }
    if (b.settleOutcome === "declined" && b.unpaid.length > 0) {
      return HttpResponse.json({
        settled: false,
        publishable_key: "pk_test_mock",
        message:
          "The charge was declined again. Update your card in the billing portal, then retry.",
      });
    }
    for (const u of b.unpaid) {
      const c = u.conversion_id
        ? mockDb.conversions.get(u.conversion_id)
        : undefined;
      if (c) c.billing = { status: "charged", charged_cents: u.amount_cents };
    }
    b.unpaid = [];
    return HttpResponse.json({
      settled: true,
      publishable_key: "pk_test_mock",
    });
  }),

  // Charge the pending balance now.
  http.post(`${GATEWAY}/v1/billing/pay-now`, () => {
    settlePending();
    return HttpResponse.json({
      settled: true,
      publishable_key: "pk_test_mock",
    });
  }),

  // Account deletion: refused while a run is going or a charge failed;
  // the pending balance is charged first.
  http.post(`${GATEWAY}/v1/account/delete`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { balance_confirmed?: boolean };
    const active = [...mockDb.conversions.values()].filter((c) =>
      ["created", "paid", "processing"].includes(c.state),
    ).length;
    if (active > 0) {
      return err(
        409,
        "active_runs",
        "cancel or wait for your running jobs before deleting your account",
      );
    }
    // owner 2026-11-06: a renewing plan is cancelled first (a scheduled
    // step-down still renews); a cancelled one stays valid to its end
    const plan = mockDb.billing.plan;
    const ends = plan?.cancel_at_period_end || plan?.scheduled_change?.to === "pay_per_video";
    if (plan?.active && !ends) {
      return HttpResponse.json(
        {
          success: false,
          error: "plan_renewing",
          message: "cancel your plan before deleting your account",
          details: { plan: plan.plan, current_period_end: plan.current_period_end ?? currentPeriodEnd() },
        },
        { status: 409 },
      );
    }
    const owed = mockDb.billing.unpaid.reduce((n, u) => n + u.amount_cents, 0);
    if (owed > 0) {
      return HttpResponse.json(
        {
          success: false,
          error: "balance_due",
          message:
            "a payment couldn't be taken — update your card, then delete your account",
          details: { amount_cents: owed, publishable_key: "pk_test_mock" },
        },
        { status: 402 },
      );
    }
    // refund policy 2026-11-07 (gateway feat/refund-policy): an unspent
    // balance isn't refunded at deletion; balance_confirmed is accepted and
    // ignored. oldDeleteRefund: a gateway before it (00081: 409
    // balance_remaining until confirmed, then the balance is refunded first)
    const cash = mockDb.billing.prepaid.balance_cents;
    if (cash > 0 && mockDb.oldDeleteRefund) {
      if (!body.balance_confirmed) {
        return HttpResponse.json(
          { success: false, error: "balance_remaining", message: "your balance is refunded before your account is deleted", details: { cents: cash } },
          { status: 409 },
        );
      }
      mockDb.billing.deletionPending = true;
      return HttpResponse.json(
        {
          deleted: false,
          deletion_pending: true,
          case_id: "case_mock_1",
          refund_cents: cash,
          message: "we're returning your balance; your account is deleted once that's done",
        },
        { status: 202 },
      );
    }
    settlePending();
    // gateway 00166: the account goes in 48 hours; a repeat keeps the time
    const now = new Date();
    mockDb.billing.accountDeletion ??= {
      requested_at: now.toISOString(),
      delete_after: new Date(now.getTime() + 48 * 3_600_000).toISOString(),
    };
    const d = mockDb.billing.accountDeletion;
    return HttpResponse.json(
      {
        success: true,
        deleted: false,
        sign_in_removed: false,
        state: "pending_deletion",
        pending_deletion: true,
        delete_after: d.delete_after,
        requested_at: d.requested_at,
        message: "your account will be deleted after 48 hours; sign in before then to keep it",
      },
      { status: 202 },
    );
  }),

  // gateway 00166: keep the account while its deletion waits
  http.post(`${GATEWAY}/v1/account/delete/cancel`, () => {
    if (!mockDb.billing.accountDeletion) {
      return err(409, "not_pending_deletion", "the account isn't set to be deleted");
    }
    mockDb.billing.accountDeletion = null;
    return HttpResponse.json({ state: "active", cancelled: true, pending_deletion: false, cancelled_at: new Date().toISOString() });
  }),

  /** What completeChargeAction calls in place of confirmCardPayment: the
   * 3DS challenge succeeds. A pending HOLD (conversion parked at created)
   * clears and the run starts; outstanding post-success charges settle. */
  http.post(`${GATEWAY}/__mock__/complete-3ds`, async ({ request }) => {
    const { client_secret } = (await request.json()) as {
      client_secret?: string;
    };
    for (const c of mockDb.conversions.values()) {
      if (
        c.state === "created" &&
        c.billing?.status === "requires_action" &&
        c.billing.client_secret === client_secret
      ) {
        c.state = "paid";
        if (c.charge_timing === "before") {
          c.billing = { status: "charged", charged_cents: c.quote.amount_cents };
        } else {
          delete c.billing; // success stamps "charged" like any hold capture
        }
      }
    }
    for (const u of mockDb.billing.unpaid) {
      const c = u.conversion_id
        ? mockDb.conversions.get(u.conversion_id)
        : undefined;
      if (c) c.billing = { status: "charged", charged_cents: u.amount_cents };
    }
    mockDb.billing.unpaid = [];
    mockDb.billing.settleOutcome = "success";
    return HttpResponse.json({ ok: true });
  }),

  // Restore Purchases (gateway feat/restore-resync): restored when the
  // account has an active plan; tests answer other cases with server.use.
  http.post(`${GATEWAY}/v1/billing/restore`, () => {
    const plan = mockDb.billing.plan ?? null;
    const restored = plan?.active === true;
    return HttpResponse.json({
      restored,
      repaired: [],
      plan,
      pro: false,
      message: restored ? "Your purchases are restored" : "We didn't find any purchases",
    });
  }),

  // Stripe customer-portal session (the /account "Manage billing" button).
  http.post(`${GATEWAY}/v1/billing/portal`, () => {
    return HttpResponse.json({
      url: "https://billing.stripe.com/p/session/mock",
    });
  }),

  // GET /v1/limits — the parts the web reads: the global (Classic) cap and
  // the per-method caps (0 = unlimited).
  http.get(`${GATEWAY}/v1/limits`, () =>
    HttpResponse.json({
      limits: {
        max_duration_s: mockDb.methodMaxDurationS.classic,
        max_source_bytes: 20 * 1024 * 1024 * 1024,
      },
      methods: {
        lifelike: {
          max_source_duration_s: mockDb.methodMaxDurationS.lifelike,
          available: mockDb.methodAvailable.lifelike,
          foveation: mockDb.lifelikeFoveation,
        },
        classic: {
          max_source_duration_s: mockDb.methodMaxDurationS.classic,
          available: mockDb.methodAvailable.classic,
        },
      },
      default_method: "lifelike",
      rates: { precharge_threshold_cents: mockDb.chargeBeforeCents },
      // gateway 00166: a deletion waiting its 48 hours
      account_deletion: {
        pending_deletion: mockDb.billing.accountDeletion !== null,
        delete_after: mockDb.billing.accountDeletion?.delete_after ?? null,
      },
    }),
  ),

  // GET /v1/pricing — public (no sign-in), every number from config
  http.get(`${GATEWAY}/v1/pricing`, () =>
    HttpResponse.json({
      rate_version: "mock",
      currency: "usd",
      classic_new_projects: mockDb.classicNewProjects,
      methods: {
        lifelike: {
          presets: ["1080p", "qhd", "3k", "4k", "5k", "6k", "8k"],
          production_cents_per_minute: LIFELIKE.priceCentsPerMinute,
          max_source_duration_s: mockDb.methodMaxDurationS.lifelike,
          max_source_bytes: 25 * 1024 ** 3,
          foveation: { included_presets: FOVEATION_INCLUDED },
        },
        classic: {
          presets: ["1080p", "qhd", "3k"],
          // per minute at the standard depth detail and Best edges, 16:9
          production_cents_per_minute: CLASSIC_STANDARD_CENTS_PER_MINUTE,
          stereo_preview_cents_per_minute: Object.fromEntries(
            Object.entries(RATES.stereoPreviewCentsPerMinute).map(([k, v]) => [
              k,
              v * RATES.costMarginMultiplier,
            ]),
          ),
          depth_preview_cents_per_minute:
            RATES.stepCentsPerMinute.depth_preview * RATES.costMarginMultiplier,
          max_source_duration_s: mockDb.methodMaxDurationS.classic,
          max_source_bytes: 8 * 1024 ** 3,
        },
      },
      fps: { base: 24, min_factor: 0.5, max_factor: 2.5, max_fps_without_plan: 30, max_fps_with_plan: 120 },
      discount: {
        threshold_cents: RATES.discountThresholdCents,
        pct: RATES.discountPct,
      },
      minimum_cents: RATES.minimumCents,
      preview_minimum_cents: RATES.previewMinimumCents,
      precharge_threshold_cents: mockDb.chargeBeforeCents,
      balance: { window_hours: 1, new_account_cap_cents: mockDb.billing.batchCapCents },
      pro_discount: { ...MOCK_PRO, pct: mockProPct() },
      ...(mockDb.tierPricing ? publicTiers() : {}),
      campaign: publicCampaign(),
      adaptive_pricing: mockDb.adaptivePricing,
      china_payments: mockDb.chinaPayments,
      web_pro_weekly_hidden: mockDb.webProWeeklyHidden,
      topup_bonus: mockDb.topupBonus,
      // gateway 00102: web Pro on our own Stripe subscriptions
      pro_plans: MOCK_PRO_PLANS,
      pro_credit: MOCK_PRO_CREDIT,
    }),
  ),

  // S3D-24: soft delete — the project and its runs then answer 404
  http.post(`${GATEWAY}/v1/projects/:id/delete`, ({ params }) => {
    const p = mockDb.projects.get(params.id as string);
    if (!p || p.deleted) return err(404, "not_found", "project not found");
    // owner 2026-11-04: archive first, then delete; the sample never
    if (p.sample === true) {
      return err(409, "sample_not_deletable", "The sample can't be deleted. Unarchive it any time.");
    }
    if (p.archived !== true) {
      return err(409, "project_not_archived", "Archive the project first, then delete it from Archived.");
    }
    const active = [...mockDb.conversions.values()].some(
      (c) =>
        c.project_id === p.project_id &&
        !["succeeded", "failed", "canceled", "expired"].includes(c.state),
    );
    if (active) {
      return err(
        409,
        "conflict",
        "A run is still in progress. Cancel it or wait for it to finish, then delete the project.",
      );
    }
    p.deleted = true;
    return HttpResponse.json({ project_id: p.project_id, deleted: true });
  }),

  // S3D-24: Keep pushes the files' deletion back (the next one is 90
  // days after this use)
  http.post(`${GATEWAY}/v1/projects/:id/keep`, ({ params }) => {
    const p = mockDb.projects.get(params.id as string);
    if (!p || p.deleted) return err(404, "not_found", "project not found");
    delete p.files_delete_at;
    return HttpResponse.json({ project_id: p.project_id, files_delete_at: null });
  }),

  http.post(`${GATEWAY}/v1/uploads`, async ({ request }) => {
    const { filename, resumable } = (await request.json()) as {
      filename: string;
      resumable?: boolean;
    };
    const id = newId();
    const ext = filename.slice(filename.lastIndexOf("."));
    if (resumable === true) {
      mockUploads.sessions.set(id, {
        gcsKey: `stereo3d/test/users/dev-user/${id}/source${ext}`,
        bytes: 0,
        total: null,
        done: false,
        chunks: 0,
        statusChecks: 0,
      });
      return HttpResponse.json({
        upload_id: id,
        gcs_key: `stereo3d/test/users/dev-user/${id}/source${ext}`,
        upload_url: `${GATEWAY}/__mock__/resumable/${id}?upload_id=mock`,
        resumable: true,
        headers: {},
        expires_in: 604800,
      });
    }
    return HttpResponse.json({
      upload_id: id,
      gcs_key: `stereo3d/test/users/dev-user/${id}/source${ext}`,
      upload_url: `${GATEWAY}/__mock__/upload/${id}`,
      headers: { "Content-Type": "video/mp4" },
      expires_in: 900,
    });
  }),
  http.put(
    `${GATEWAY}/__mock__/upload/:id`,
    () => new HttpResponse(null, { status: 200 }),
  ),
  http.put(`${GATEWAY}/__mock__/resumable/:id`, ({ request, params }) =>
    resumablePut(request, params.id as string),
  ),
  // Whether an upload landed: complete resumable sessions exist; single-PUT
  // uploads aren't tracked and read as missing.
  http.post(`${GATEWAY}/v1/uploads/status`, async ({ request }) => {
    const { gcs_key } = (await request.json()) as { gcs_key: string };
    if (!gcs_key.includes("/users/dev-user/")) {
      return err(400, "invalid_request", "gcs_key is not one of your uploads");
    }
    const s = [...mockUploads.sessions.values()].find(
      (x) => x.gcsKey === gcs_key && x.done,
    );
    return HttpResponse.json({
      gcs_key,
      exists: s !== undefined,
      bytes: s?.bytes ?? 0,
    });
  }),

  http.post(`${GATEWAY}/v1/projects`, async ({ request }) => {
    const { gcs_key, name, method, source_filename } = (await request.json()) as {
      gcs_key: string;
      name?: string;
      method?: Method;
      source_filename?: string;
    };
    if (!gcs_key.includes("/users/dev-user/")) {
      return err(400, "invalid_request", "gcs_key is not one of your uploads");
    }
    if (method !== undefined && method !== "lifelike" && method !== "classic") {
      return err(400, "invalid_request", "method must be lifelike|classic");
    }
    if (method !== undefined && !mockDb.methodAvailable[method]) {
      return err(400, "method_unavailable", "this 3D method isn't available right now");
    }
    // owner 2026-11-04: Classic 3D takes no new projects
    if (method === "classic" && !mockDb.classicNewProjects) {
      return err(422, "classic_retired", "Classic 3D takes no new projects");
    }
    const template = structuredClone(projectFixture) as unknown as Project;
    const id = gcs_key.split("/").at(-2) ?? newId();
    const project: Project = {
      ...template,
      project_id: id,
      name: name || "Untitled project",
      // a missing method meant classic for old clients; Classic takes no
      // new projects any more, so those get Lifelike
      method: method ?? (mockDb.classicNewProjects ? "classic" : "lifelike"),
      analyze: {
        state: "running",
        error: "",
        credit_cents: 0,
        credit_available: false,
        progress: 0.05,
        stage: "analyze",
        eta_seconds: 40,
      },
      probe: undefined,
      scenes: undefined,
      strip_thumbs: undefined,
      scene_thumbs: undefined,
      poster: undefined,
      archived: false,
    };
    if (source_filename) sourceNames.set(id, source_filename);
    mockDb.projects.set(id, project);
    // analyze "completes" on the next GET (deterministic for tests)
    return HttpResponse.json(project);
  }),

  // default: ACTIVE (non-archived) projects; ?archived=1: ONLY archived ones
  http.get(`${GATEWAY}/v1/projects`, ({ request }) => {
    seedSample();
    const archived = new URL(request.url).searchParams.get("archived") === "1";
    return HttpResponse.json({
      projects: [...mockDb.projects.values()]
        .filter((p) => (p.archived ?? false) === archived && !p.deleted)
        .map((p) => ({
          ...p,
          method: projectMethod(p),
          summary: projectSummary(p),
        })),
    });
  }),

  http.get(`${GATEWAY}/v1/projects/:id`, ({ params }) => {
    const p = mockDb.projects.get(params.id as string);
    if (!p || p.deleted) return err(404, "not_found", "project not found");
    // while a status stream is open, the stream advances the analysis
    if (mockDb.openStreams === 0) {
      tickAnalyze(p);
      tickProfile(p);
    }
    return HttpResponse.json(projectDetail(p));
  }),

  /** Register an uploaded depth video on the project. The real gateway
   * ffprobe-validates frame-exactness; the mock stamps the source's frame
   * count, except when the key/name contains "badframes" — that simulates
   * the mismatch 400 so tests can exercise the error surface. */
  http.post(
    `${GATEWAY}/v1/projects/:id/depth-map`,
    async ({ params, request }) => {
      const p = mockDb.projects.get(params.id as string);
      if (!p) return err(404, "not_found", "project not found");
      if (!p.probe) {
        return err(
          409,
          "conflict",
          "analysis has not completed yet — the depth map is validated against the source frame count",
        );
      }
      const body = (await request.json()) as {
        gcs_key?: string;
        name?: string;
      };
      if (!body.gcs_key) {
        return err(
          400,
          "invalid_request",
          "gcs_key is required (from POST /v1/uploads)",
        );
      }
      if (`${body.gcs_key}${body.name ?? ""}`.includes("badframes")) {
        return err(
          400,
          "invalid_request",
          `depth map has ${p.probe.num_frames - 7} frames but the source has ${p.probe.num_frames} — it must be frame-exact (full length, source frame rate), like the Depth page's export`,
        );
      }
      p.depth_upload = {
        name: body.name?.trim() || undefined,
        frames: p.probe.num_frames,
        width: p.probe.width,
        height: p.probe.height,
        bytes: 1 << 20,
        created_at: new Date().toISOString(),
      };
      return HttpResponse.json(projectDetail(p));
    },
  ),

  http.delete(`${GATEWAY}/v1/projects/:id/depth-map`, ({ params }) => {
    const p = mockDb.projects.get(params.id as string);
    if (!p) return err(404, "not_found", "project not found");
    delete p.depth_upload;
    return HttpResponse.json(projectDetail(p));
  }),

  /** Free standalone shot profiling (empty JSON body). 409 while one is
   * already running; the job advances/completes on subsequent detail GETs. */
  http.post(`${GATEWAY}/v1/projects/:id/analyze`, ({ params }) => {
    const p = mockDb.projects.get(params.id as string);
    if (!p) return err(404, "not_found", "project not found");
    if (p.analyze.state !== "failed") {
      return err(
        409,
        "conflict",
        "analysis can only be retried after it failed",
      );
    }
    p.analyze = {
      state: "running",
      error: "",
      credit_cents: 0,
      credit_available: false,
      progress: 0.05,
      stage: "analyze",
      eta_seconds: 40,
    };
    mockDb.analyzeTicks.set(p.project_id, 0);
    return HttpResponse.json(projectDetail(p));
  }),

  http.post(`${GATEWAY}/v1/projects/:id/profile`, ({ params }) => {
    const p = mockDb.projects.get(params.id as string);
    if (!p) return err(404, "not_found", "project not found");
    if (!p.probe || !p.scenes) {
      return err(409, "conflict", "analysis has not completed yet");
    }
    if (p.profile?.state === "running") {
      return err(409, "conflict", "a profiling job is already running");
    }
    p.profile = {
      state: "running",
      scenes_version: p.scenes.version,
      progress: 0.1,
      stage: "profiling",
      updated_at: new Date().toISOString(),
    };
    mockDb.profileTicks.set(p.project_id, 0);
    return HttpResponse.json(projectDetail(p));
  }),

  http.patch(`${GATEWAY}/v1/projects/:id`, async ({ params, request }) => {
    const p = mockDb.projects.get(params.id as string);
    if (!p) return err(404, "not_found", "project not found");
    const body = (await request.json()) as {
      name?: string;
      pinned?: boolean;
      archived?: boolean;
      method?: Method;
      remove_bars?: boolean;
    };
    // owner 2026-11-04: keep or remove the black bars
    if (body.remove_bars !== undefined) {
      if (typeof body.remove_bars !== "boolean") return err(400, "invalid_request", "remove_bars is true or false");
      if (p.has_bars !== true) return err(400, "invalid_request", "this video has no black bars");
      p.remove_bars = body.remove_bars;
    }
    if (body.method !== undefined) {
      if (body.method !== "lifelike" && body.method !== "classic") {
        return err(400, "invalid_request", "method must be lifelike|classic");
      }
      if (!mockDb.methodAvailable[body.method]) {
        return err(
          400,
          "method_unavailable",
          "this 3D method isn't available right now",
        );
      }
      if (projectMethod(p) === "lifelike" && body.method === "classic") {
        return err(
          400,
          "method_switch_not_allowed",
          "A Lifelike project can't be switched back to Classic.",
        );
      }
      const cap = mockDb.methodMaxDurationS[body.method];
      if (cap > 0 && sourceDurationS(p) > cap) {
        return err(
          400,
          "source_too_long_for_method",
          `This video is longer than ${Math.round(cap / 60)} minutes, the most Classic 3D can take.`,
        );
      }
      p.method = body.method;
    }
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (name === "" || name.length > 120) {
        return err(400, "invalid_request", "name must be 1-120 characters");
      }
      p.name = name;
    }
    if (body.pinned !== undefined) {
      // the gateway omits pinned:false (Go omitempty) — mirror that
      if (body.pinned) p.pinned = true;
      else delete p.pinned;
    }
    if (body.archived !== undefined) {
      // gateway 00101: archiving is blocked while any run is unfinished
      const active = [...mockDb.conversions.values()].some(
        (c) => c.project_id === p.project_id && !["succeeded", "failed", "canceled", "expired"].includes(c.state),
      );
      if (body.archived && active) {
        return err(409, "project_has_active_run", ARCHIVE_BLOCKED);
      }
      p.archived = body.archived;
    }
    p.updated_at = new Date().toISOString();
    return HttpResponse.json(projectDetail(p));
  }),

  http.patch(
    `${GATEWAY}/v1/projects/:id/scenes`,
    async ({ params, request }) => {
      const p = mockDb.projects.get(params.id as string);
      if (!p) return err(404, "not_found", "project not found");
      if (!p.scenes || !p.probe)
        return err(409, "conflict", "analysis has not completed yet");
      const { cuts, expect_version } = (await request.json()) as {
        cuts: number[];
        expect_version?: number;
      };
      for (let i = 0; i < cuts.length; i++) {
        if (
          !Number.isInteger(cuts[i]) ||
          cuts[i] <= 0 ||
          cuts[i] >= p.probe.num_frames
        ) {
          return err(
            400,
            "invalid_request",
            "cuts must be source-frame indices in (0, num_frames)",
          );
        }
        if (i > 0 && cuts[i] <= cuts[i - 1]) {
          return err(
            400,
            "invalid_request",
            "cuts must be strictly increasing",
          );
        }
      }
      if (expect_version !== undefined && expect_version !== p.scenes.version) {
        return err(
          409,
          "conflict",
          "scene list changed since you loaded it — reload and retry",
        );
      }
      p.scenes = {
        version: p.scenes.version + 1,
        cuts,
        edited: true,
        updated_at: new Date().toISOString(),
      };
      return HttpResponse.json({ scenes: p.scenes });
    },
  ),

  http.post(
    `${GATEWAY}/v1/projects/:id/quotes`,
    async ({ params, request }) => {
      const p = mockDb.projects.get(params.id as string);
      if (!p) return err(404, "not_found", "project not found");
      if (p.files_deleted_at)
        return err(410, "files_deleted", "this project's files have been deleted");
      if (!p.probe)
        return err(409, "conflict", "analysis has not completed yet");
      if (p.sample) return err(422, "sample_project", "This is a sample project. Add your own video to make 3D.");
      const raw = (await request.json()) as Record<string, unknown>;
      // S3D-14: price the step under another method without changing the
      // project
      const { method: override, ...body } = raw as Record<string, unknown> & {
        method?: Method;
      };
      const priced: Project =
        override !== undefined ? { ...p, method: override } : p;
      const invalid = validateStepRequest(priced, body);
      if (invalid) return invalid;
      const req = body as unknown as StepConversionRequest;
      const method = projectMethod(priced);
      const capped = methodCapError(priced);
      if (capped) return capped;
      if (method === "lifelike") {
        const q = lifelikeQuoteFor(priced, req);
        return HttpResponse.json({
          step: req.step,
          params: q.params,
          quote: q.quote,
          reuse_stages: null,
          eta_seconds: q.eta,
          method,
          charge_timing: chargeTiming(q.quote.amount_cents),
          ...paymentFlow(q.quote.amount_cents),
          ...balanceQuote(q.quote.amount_cents),
          ...oneTapQuote(q.quote.amount_cents),
          output_seconds: Math.round(q.outputSeconds * 100) / 100,
          split_suggested: q.outputSeconds > LIFELIKE.splitSuggestSeconds,
          estimated_size_bytes: estimatedSizeBytes(req, q.outputSeconds),
          foveation: mockFoveation(priced, req),
          ...(req.quality ? { quality: mockQuality(req, q.outputSeconds) } : {}),
          ...(mockDb.pro !== null ? { pro: mockDb.pro } : {}),
          ...(q.quote.breakdown?.pro_discount_cents
            ? {
                pro_discount: {
                  pct: mockDb.tierPricing ? (q.quote.breakdown.pro_discount_pct as number) : MOCK_PRO.pct,
                  cents: q.quote.breakdown.pro_discount_cents,
                },
              }
            : {}),
          ...(mockDb.tierPricing ? tierQuoteExtras(req, q) : {}),
          ...(mockDb.tierPricing ? { alt_prices: altPrices(priced, req) } : {}),
          ...fpsPolicy(priced, req.target_fps).extras,
          ...mockPaySplit(q.quote.amount_cents),
        });
      }
      const { quote, reuseStages, params: resolved } = quoteFor(priced, req);
      const billable = quote.breakdown?.billable_seconds ?? p.probe!.duration_s;
      return HttpResponse.json({
        step: req.step,
        params: resolved,
        quote,
        // null when empty, mirroring the Go gateway's nil-slice serialization
        // (older deployments still send null) — keeps the client guard honest.
        reuse_stages: reuseStages.length > 0 ? reuseStages : null,
        eta_seconds: etaForStep(req.step, billable),
        method,
        charge_timing: chargeTiming(quote.amount_cents),
        ...paymentFlow(quote.amount_cents),
        ...balanceQuote(quote.amount_cents),
        ...oneTapQuote(quote.amount_cents),
        output_seconds: billable,
        split_suggested: false,
        ...(req.step === "production"
          ? { estimated_size_bytes: estimatedSizeBytes(req, billable) }
          : {}),
      });
    },
  ),

  http.post(
    `${GATEWAY}/v1/projects/:id/conversions`,
    async ({ params, request }) => {
      const p = mockDb.projects.get(params.id as string);
      if (!p) return err(404, "not_found", "project not found");
      if (p.files_deleted_at)
        return err(410, "files_deleted", "this project's files have been deleted");
      if (!p.probe)
        return err(409, "conflict", "analysis has not completed yet");
      const idem = request.headers.get("Idempotency-Key");
      if (idem && mockDb.idem.has(idem)) {
        return HttpResponse.json(
          mockDb.conversions.get(mockDb.idem.get(idem)!),
        );
      }
      const body = (await request.json()) as Record<string, unknown>;
      if (body.method !== undefined && body.method !== projectMethod(p)) {
        return err(
          400,
          "invalid_request",
          "method does not match the project's method",
        );
      }
      delete body.method;
      if (p.sample) return err(422, "sample_project", "This is a sample project. Add your own video to make 3D.");
      // fps_cap.go requireFPSChoice: a web run on a source above 30 fps
      // names its rate
      if (mockDb.fpsCap && p.probe!.fps > 30 * 1.0005 && p.probe!.fps <= 120 * 1.001 && typeof body.target_fps !== "number") {
        return HttpResponse.json(
          {
            success: false,
            error: "fps_choice_required",
            message: "Choose the frame rate for this video.",
            details: { target_fps_choices: fpsDivisions(p.probe!.fps, mockMaxFps() ?? 120) },
          },
          { status: 422 },
        );
      }
      const invalid = validateStepRequest(p, body);
      if (invalid) return invalid;
      // The real gateway's pay-as-you-go billing gate (402s, api/billing.go
      // requireBillable) — enforce it here too so the onboarding/settle flows
      // can't silently regress against the mock.
      if (mockDb.billing.underReview) {
        return err(403, "under_review", "a payment on this account is being checked");
      }
      if (mockDb.billing.unpaid.length > 0) {
        return err(
          402,
          "payment_method_needed",
          `the automatic payment for conversion ${mockDb.billing.unpaid[0].conversion_id} failed — settle it before starting new work`,
        );
      }
      if (mockDb.billing.deletionPending) return err(403, "deletion_pending", "your account is being deleted");
      // gateway 00166: frozen while the account waits to be deleted
      if (mockDb.billing.accountDeletion) {
        return HttpResponse.json(
          {
            success: false,
            error: "account_pending_deletion",
            message: "this account is set to be deleted",
            details: { delete_after: mockDb.billing.accountDeletion.delete_after },
          },
          { status: 409 },
        );
      }
      const req = body as unknown as StepConversionRequest;
      const capped = methodCapError(p);
      if (capped) return capped;
      const method = projectMethod(p);
      const { quote, params: resolved } =
        method === "lifelike" ? lifelikeQuoteFor(p, req) : quoteFor(p, req);
      // Threshold hybrid, mirroring the gateway: expensive runs place an
      // up-front hold (which can be declined or demand 3DS); cheap runs skip
      // it and charge on success.
      const holds = quote.amount_cents >= mockDb.billing.holdThresholdCents;
      if (holds && mockDb.billing.nextHoldFails) {
        mockDb.billing.nextHoldFails = false;
        return err(
          402,
          "card_declined",
          "your card declined the payment hold — update your payment method and retry",
        );
      }
      if (p.analyze.credit_available) p.analyze.credit_available = false;
      const id = newId();
      // Enters at "paid" (billing verified / hold in place), except a hold
      // demanding 3DS, which parks at "created" until __mock__/complete-3ds.
      // LL-D8: runs above the threshold are paid when they start; they stay
      // "created" until the card payment is confirmed (3DS included)
      const precharge = chargeTiming(quote.amount_cents) === "before";
      const needs3ds =
        (holds || precharge) && mockDb.billing.nextHoldRequiresAction;
      if (needs3ds) mockDb.billing.nextHoldRequiresAction = false;
      // S3D-60: a pay-now default method (Alipay, WeChat Pay) pays each run
      // when it starts — the run waits at "created" for that payment
      // pricing 2026-11: a free preview starts at once, nothing charged
      if (quote.breakdown?.free_preview === true) {
        const units = (quote.breakdown.free_preview_units as number) ?? 1;
        const fp = mockDb.freePreviews;
        if (mockTier() === "") fp.introUsed = true;
        else fp.used += units;
        fp.dayUsed += units;
        const fid = newId();
        const freeRun: Conversion = {
          conversion_id: fid,
          state: "paid",
          kind: "video",
          project_id: p.project_id,
          step: req.step,
          scenes_version: p.scenes?.version,
          params: resolved,
          quote,
          ...detailFields(req, units),
          progress: 0,
          stage: "",
          eta_seconds: 0,
          method,
          waiting_for_gpu: false,
          charge_timing: "before",
          billing: { status: "free_preview" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        mockDb.conversions.set(fid, freeRun);
        if (idem) mockDb.idem.set(idem, fid);
        return HttpResponse.json(freeRun);
      }
      // spec v7 N6: the monthly spend limit
      const pp = mockDb.billing.prepaid;
      if (pp.spend_limit_cents !== null && pp.month_spent_cents + quote.amount_cents > pp.spend_limit_cents) {
        return err(403, "spend_limit_reached", "this month's spend limit is reached");
      }
      // spec v7 N4/N5: paid from the balance (after an auto-reload if short)
      const bq = balanceQuote(quote.amount_cents) as { payment_flow?: string; balance?: { reload_cents?: number } };
      if (bq.payment_flow === "balance") {
        if (bq.balance?.reload_cents) addTopup(bq.balance.reload_cents, "auto_reload", "Visa •••• 4242");
        const bid = newId();
        pp.holds.set(bid, quote.amount_cents);
        pp.month_spent_cents += quote.amount_cents;
        const held: Conversion = {
          conversion_id: bid,
          state: "paid",
          kind: "video",
          project_id: p.project_id,
          step: req.step,
          scenes_version: p.scenes?.version,
          params: resolved,
          quote,
          ...campaignOf(quote),
          ...detailFields(req),
          progress: 0,
          stage: "",
          eta_seconds: 0,
          method,
          waiting_for_gpu: false,
          charge_timing: "before",
          billing: { status: "balance_hold" },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        mockDb.conversions.set(bid, held);
        if (idem) mockDb.idem.set(idem, bid);
        return HttpResponse.json(held);
      }
      // spec v6: nothing saved → the run waits for our pay sheet (P1)
      const sheet = !mockDb.billing.hasPaymentMethod;
      const payNow =
        sheet || !mockDb.deferredPayments || mockDb.billing.methods.find((m) => m.is_default)?.pay_now === true;
      const conv: Conversion = {
        conversion_id: id,
        state: payNow || needs3ds || precharge ? "created" : "paid",
        kind: "video",
        project_id: p.project_id,
        step: req.step,
        scenes_version: p.scenes?.version,
        params: resolved,
        quote,
        ...campaignOf(quote),
          ...detailFields(req),
        progress: 0,
        ...(method === "lifelike" ? { foveation: mockFoveation(p, req) } : {}),
        ...(req.quality ? { quality: req.quality } : {}),
        bitrate_requested: req.bitrate === undefined ? "auto" : String(req.bitrate),
        stage: "",
        eta_seconds: 0,
        method,
        waiting_for_gpu: false,
        charge_timing: payNow ? "before" : chargeTiming(quote.amount_cents),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...(payNow && !sheet ? { one_tap: oneTapOffer(quote.amount_cents) } : {}),
        ...(payNow
          ? {
              billing: {
                status: "requires_payment" as const,
                reason: "no_method" as const,
                client_secret: `pi_mock_paynow_${id}`,
                publishable_key: "pk_test_mock",
                checkout: openCheckout({
                  kind: "run",
                  conversion_id: id,
                  amount_cents: quote.amount_cents,
                }),
              },
            }
          : needs3ds
          ? {
              billing: {
                status: "requires_action" as const,
                client_secret: `pi_mock_hold_${id}`,
                publishable_key: "pk_test_mock",
              },
            }
          : precharge
            ? { billing: { status: "charge_pending" as const } }
            : {}),
      };
      mockDb.conversions.set(id, conv);
      if (idem) mockDb.idem.set(idem, id);
      return HttpResponse.json(conv);
    },
  ),

  http.get(`${GATEWAY}/v1/conversions/:id`, ({ params }) => {
    const c = mockDb.conversions.get(params.id as string);
    if (!c) return err(404, "not_found", "conversion not found");
    // while a status stream is open, the stream advances the run
    if (mockDb.openStreams === 0) {
      tick(c);
      c.updated_at = new Date().toISOString();
    }
    // 00081: Express runs say so; one waiting for a GPU starts within the cap
    if (c.method === "lifelike" && c.step === "production") {
      const express = c.params?.express === true;
      return HttpResponse.json({
        ...c,
        priority: express ? "express" : "standard",
        max_gpu_workers: express ? 8 : 4,
        ...(express && c.waiting_for_gpu ? { queue_wait_max_seconds: TIERS.expressMaxWaitS } : {}),
      });
    }
    return HttpResponse.json(c);
  }),

  // 00081: a play of View in 3D or a preview (fire-and-forget)
  http.post(`${GATEWAY}/v1/conversions/:id/plays`, async ({ params, request }) => {
    const c = mockDb.conversions.get(params.id as string);
    if (!c) return err(404, "not_found", "conversion not found");
    const body = (await request.json().catch(() => ({}))) as { file?: string; kind?: string };
    mockDb.plays.push({ conversion_id: c.conversion_id, file: body.file ?? "", kind: body.kind ?? "" });
    return HttpResponse.json({ logged: true });
  }),

  http.delete(`${GATEWAY}/v1/conversions/:id`, ({ params }) => {
    const c = mockDb.conversions.get(params.id as string);
    if (!c) return err(404, "not_found", "conversion not found");
    if (!["succeeded", "failed", "canceled", "expired"].includes(c.state)) {
      c.state = "canceled";
      c.updated_at = new Date().toISOString();
      // spec v7 N5: a balance run's hold goes back
      const held = mockDb.billing.prepaid.holds.get(c.conversion_id);
      if (held !== undefined) {
        mockDb.billing.prepaid.holds.delete(c.conversion_id);
        mockDb.billing.prepaid.month_spent_cents -= held;
        c.billing = { status: "balance_released" };
      }
      // S3D-23: a pre-charged run cancelled in line or in its first minute
      // is refunded in full; an unconfirmed one was never charged
      if (c.charge_timing === "before") {
        c.billing =
          c.billing?.status === "charged"
            ? { status: "refunded", charged_cents: c.quote.amount_cents }
            : { status: "not_charged" };
      }
    }
    return HttpResponse.json(c);
  }),

  http.post(`${GATEWAY}/v1/conversions/:id/report`, ({ params }) => {
    const c = mockDb.conversions.get(params.id as string);
    if (!c) return err(404, "not_found", "conversion not found");
    if (!["succeeded", "failed", "canceled", "expired"].includes(c.state)) {
      c.reported_at = new Date().toISOString();
      c.updated_at = c.reported_at;
    }
    return HttpResponse.json(c);
  }),

  // ADR 0137: another format for a finished run, free
  http.get(`${GATEWAY}/v1/runs/:id/formats`, ({ params }) => {
    const c = mockDb.conversions.get(params.id as string);
    if (!c) return err(404, "not_found", "run not found");
    // while a status stream is open, the stream advances the jobs
    return HttpResponse.json(runFormats(c, mockDb.openStreams === 0));
  }),
  http.post(`${GATEWAY}/v1/runs/:id/formats`, async ({ params, request }) => {
    const c = mockDb.conversions.get(params.id as string);
    if (!c) return err(404, "not_found", "run not found");
    const { format } = (await request.json().catch(() => ({}))) as { format?: string };
    const st = runFormats(c, false);
    if (format && st.have.includes(format)) return err(409, "format_exists", "the run already has that format");
    if (format && st.pending.includes(format)) return err(409, "format_in_progress", "that format is being made");
    if (!format || !st.available.includes(format)) {
      return HttpResponse.json(
        { success: false, error: "format_unavailable", message: "that format can't be made for this run", details: { reason: st.unavailable_reason ?? "half_only" } },
        { status: 409 },
      );
    }
    if (mockDb.formatServiceDown) return err(503, "repack_unavailable", "formats can't be made right now");
    const jobs = mockDb.formatJobs.get(c.conversion_id) ?? {};
    const job_id = `job_${c.conversion_id}_${format}_${Date.now()}`;
    // a rough estimate: Spatial video takes longest, parts add up
    const parts = c.parts && c.parts.length > 1 ? c.parts.length : 1;
    const estimated_seconds = (format === "mvhevc" ? 240 : 45) * parts;
    jobs[format] = { job_id, status: "pending", polls: 0, requested_at: new Date().toISOString(), finished_at: null, estimated_seconds };
    mockDb.formatJobs.set(c.conversion_id, jobs);
    return HttpResponse.json({ job_id, status: "pending", format, source: "repack", price_cents: 0, estimated_seconds }, { status: 202 });
  }),

  http.get(`${GATEWAY}/v1/conversions/:id/downloads`, ({ params }) => {
    const c = mockDb.conversions.get(params.id as string);
    if (!c) return err(404, "not_found", "conversion not found");
    if (c.state !== "succeeded")
      return err(409, "conflict", "conversion has no outputs yet");
    // S3D-24: erased files answer 410
    if (c.project_id && mockDb.projects.get(c.project_id)?.files_deleted_at)
      return err(410, "files_deleted", "this project's files have been deleted");
    // S3D-22: files stay downloadable after a failed payment
    // REAL published outputs from the captured draft job — the preview
    // players render the actual anaglyph/depth of the sample video.
    const real = downloadsFixture.downloads as Record<string, string>;
    const url = (name: string) =>
      real[name] ??
      `https://storage.googleapis.com/mock/${c.conversion_id}/${name}.${
        name.startsWith("mvhevc") ? "mov" : "mp4"
      }`;
    const projectName =
      (c.project_id && mockDb.projects.get(c.project_id)?.name) || "video";
    return HttpResponse.json({
      downloads: Object.fromEntries(
        (c.outputs ?? []).map((name) => [name, url(name)]),
      ),
      // every output with its part, as the gateway lists them
      files: (c.outputs ?? []).map((name) => {
        const m = /^(.+)_part(\d+)$/.exec(name);
        const format = m ? m[1] : name;
        const ext = format === "mvhevc" ? "mov" : "mp4";
        return {
          name,
          format,
          ...(m ? { part: Number(m[2]) } : {}),
          size_bytes: mockOutputBytes(c, format),
          // S3D-31: <original>_<resolution>[_partN]_<layout>.<ext> (the
          // part before the layout marker so players still read it), the
          // name the signed URL's Content-Disposition carries too
          filename: `${projectName}_${c.params?.preset ?? "1080p"}${
            m ? `_part${Number(m[2])}` : ""
          }${c.step === "production" ? "" : "_preview"}_${MOCK_LAYOUT_MARKERS[format] ?? format}.${ext}`,
          url: url(name),
        };
      }),
      expires_in: 86400,
    });
  }),

  http.delete(`${GATEWAY}/v1/projects/:id`, ({ params }) => {
    const p = mockDb.projects.get(params.id as string);
    if (!p) return err(404, "not_found", "project not found");
    mockDb.projects.delete(params.id as string);
    return HttpResponse.json(p);
  }),

  // China mode calls every route on the cn. host (lib/region.ts): past the
  // auth routes above, it answers like the main host. Without this a
  // sign-in's events or the billing read after it reached MSW unhandled
  // whenever they fired before the test ended (CI, 2026-11-07).
  ...(GATEWAY_CN !== GATEWAY ? [http.all(`${GATEWAY_CN}/*`, ({ request }) => forwardToMain(request))] : []),
];

/** The same request on the main mock host (MSW answers it from the
 * handlers above). */
async function forwardToMain(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  return fetch(new URL(url.pathname + url.search, GATEWAY), {
    method: request.method,
    headers: request.headers,
    body,
  });
}

/** A refund's local amount, negative like the gateway's (REV-05). */
function refundPresentment(
  p: { amount_minor: number; currency: string } | null | undefined,
): { amount_minor: number; currency: string } | null {
  return p ? { ...p, amount_minor: -p.amount_minor } : null;
}
