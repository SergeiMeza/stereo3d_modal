/**
 * Shapes of the gateway's /v1/admin/* responses (gateway README, "Admin
 * API"; internal/api/admin.go, admin_account.go, evidence.go). Go encodes
 * empty slices as null, so every list is optional or nullable here.
 */

import type { QualityFields } from "./fileQuality";
import type { SourceInfo, SourceProbe } from "./sourceDetails";

export type CaseType =
  | "refund"
  | "dispute"
  | "efw"
  | "support"
  | "waive"
  | "balance_refund";

export type CaseStatus =
  | "waiting_for_run"
  | "open"
  | "waiting_on_customer"
  | "decided"
  | "refund_pending"
  | "closed";

export type Tab = "open" | "waiting" | "decided" | "closed" | "all";

export interface CaseRow {
  id: string;
  type: CaseType | string;
  reason: string;
  mode: string;
  status: CaseStatus | string;
  result?: string;
  opened_at: string;
  age_hours: number;
  email_masked: string;
  /** BL-29 (gateway rev 00114): the account, for the preview and E */
  uid?: string | null;
  /** BL-29 (gateway cf7c121): the customer's message on one line (~280 chars, "…"), or null */
  message_excerpt?: string | null;
  /** BL-29 (gateway cf7c121): the case's runs, maybe empty */
  run_ids?: string[] | null;
  requested_cents: number;
  max_refundable_cents?: number;
  deadline_at?: string | null;
  deadline_red?: boolean;
  dispute_due?: string | null;
  last_activity_at: string;
}

export interface CasesResponse {
  cases: CaseRow[] | null;
  counts: { open: number; overdue: number; due_today: number };
}

export interface CaseRelated {
  conversion_ids?: string[];
  project_ids?: string[];
  charge_ids?: string[];
  pi_ids?: string[];
  dispute_id?: string;
  efw_id?: string;
  topup_id?: string;
  invoice_ids?: string[];
  linked_case_ids?: string[];
  superseded_by?: string;
  duplicate_of?: string;
}

export interface CaseDecision {
  kind: string;
  items?: Record<string, number>;
  by: string;
  at: string;
  customer_template?: string;
  text?: string;
}

export interface DisputeInfo {
  id: string;
  amount_cents: number;
  reason: string;
  status: string;
  due_by?: string;
  outcome?: string;
  funds_withdrawn: boolean;
}

export interface Case {
  id: string;
  uid: string;
  customer_id?: string;
  type: CaseType | string;
  reason: string;
  mode: string;
  source: string;
  status: CaseStatus | string;
  result?: string;
  open: boolean;
  customer_visible: boolean;
  related: CaseRelated;
  requested_cents: number;
  decided_cents: number;
  items?: Record<string, number>;
  currency: string;
  decision?: CaseDecision;
  refund_ids?: string[];
  credit_note_ids?: string[];
  dispute?: DisputeInfo;
  customer_text?: string;
  evidence_n: number;
  evidence_at?: string;
  deadline_at?: string;
  reminders?: string[];
  last_activity_at: string;
  opened_at: string;
  decided_at?: string;
  closed_at?: string;
  status_since: string;
  /** The closed case a customer message reopened as this one (00107). */
  follow_up_of?: string;
  /** Cases opened as follow-ups of this one. */
  follow_up_ids?: string[] | null;
  /** RP-05: support's move of this account's plan to another account. */
  plan_move?: CasePlanMove | null;
}

export type PlanMoveState = "offered" | "accepted" | "done" | "expired" | "cancelled";

/** A plan move on a plan_move case (gateway 088d57f). */
export interface CasePlanMove {
  from_uid: string;
  to_uid: string;
  subscription_id: string;
  plan: string;
  period_end: string;
  state: PlanMoveState | string;
  offered_by: string;
  offered_at: string;
  expires_at: string;
  accepted_at?: string | null;
  auth_time?: string | null;
  done_at?: string | null;
}

export type PlanMoveBlocker =
  | "same_account"
  | "no_plan"
  | "plan_renewing"
  | "target_has_plan"
  | "target_missing"
  | "from_deleted"
  | "move_open";

/** GET /v1/admin/cases/{id}/plan-move/preview?to= (gateway 088d57f). */
export interface PlanMovePreview {
  from_uid: string;
  to_uid: string;
  blockers: (PlanMoveBlocker | string)[] | null;
  stays: string[] | null;
  /** absent when the account has no plan to move (no_plan) */
  plan?: string;
  plan_id?: string;
  subscription_id?: string;
  period_end?: string | null;
  renews?: boolean;
  carry_cents?: number;
  moves?: string[] | null;
}

export interface RunRow {
  conversion_id: string;
  label: string;
  state: string;
  price_cents: number;
  delivered: "yes" | "partly" | "no" | string;
  paid_from: string;
  refunded_cents?: number;
  refundable_cents: number;
  owed_cents?: number;
}

export interface CaseEvent {
  id: string;
  at: string;
  who: string;
  kind: string;
  text?: string;
  data?: Record<string, unknown>;
}

export interface RefundRow {
  id: string;
  case_id: string;
  pi: string;
  charge_id: string;
  re_id?: string;
  items: Record<string, number> | null;
  total_cents: number;
  status: string;
  source: string;
  k: number;
  note?: string;
  fail_reason?: string;
  credit_note_id?: string;
  created_at: string;
  updated_at: string;
}

export interface EvidenceRun extends QualityFields, Partial<Omit<SourceInfo, "probe">> {
  conversion_id: string;
  /** owner 2026-11-07: the run's project source (gateway: to come) */
  source?: SourceInfo | null;
  probe?: SourceProbe | null;
  project_id?: string;
  step?: string;
  method?: string;
  preset?: string;
  state?: string;
  created_at?: string;
  updated_at?: string;
  payment_flow?: string;
  quote_cents?: number;
  captured_cents?: number;
  refunded_cents?: number;
  pi_status?: string;
  canceled_by?: string;
  submitted_at?: string | null;
  started_at?: string | null;
  job_id?: string;
  gpu_cost_usd?: number;
  queued_s?: number;
  error?: { code?: string; message?: string; internal?: string };
  files_delivered?: string[] | null;
  parts?: number;
  balance?: { hold_cents?: number; state?: string; settled_cents?: number };
}

export interface EvidenceDownload {
  at?: string;
  file?: string;
  kind?: string;
  ip_country?: string;
  user_agent?: string;
  conversion_id?: string;
}

export interface Evidence {
  n?: number;
  built_at?: string;
  runs?: EvidenceRun[] | null;
  /** A list once the M8 download log exists; a note until then. */
  downloads?: EvidenceDownload[] | string | null;
  payments?:
    | {
        charge_id: string;
        kind: string;
        paid_at: string;
        amount_cents: number;
        payment_intent?: string;
        invoice_state?: string;
      }[]
    | null;
  refunds?:
    | {
        id: string;
        case_id: string;
        pi: string;
        re_id?: string;
        total_cents: number;
        status: string;
        source: string;
        at: string;
      }[]
    | null;
  cases?:
    | {
        id: string;
        type: string;
        reason: string;
        status: string;
        result?: string;
        decided_cents?: number;
        opened_at?: string;
        decision?: string;
      }[]
    | null;
  links?: {
    logs_url?: string;
    stripe_urls?: string[] | null;
    modal_job_ids?: string[] | null;
    modal_urls?: string[] | null;
  };
}

export interface RelatedCase {
  id: string;
  type: string;
  reason: string;
  status: string;
  result?: string;
}

export type CaseAction =
  | "note"
  | "customer_reply"
  | "refresh_evidence"
  | "ask"
  | "approve"
  | "partial"
  | "waive"
  | "deny"
  | "no_refund"
  | "mark_out_of_band"
  | "assign"
  | "stop_run"
  | "accept_dispute"
  | "counter_dispute"
  | "counter_with_refund_proof"
  | "offer_plan_move"
  | "cancel_plan_move"
  | "close";

export interface CasePage {
  case: Case;
  runs: RunRow[] | null;
  max_refundable_cents: number;
  events: CaseEvent[] | null;
  evidence: Evidence | null;
  related_cases: RelatedCase[] | null;
  hints: string[] | null;
  banners: string[] | null;
  account: { uid: string; email: string; payment_method?: string };
  refunds: RefundRow[] | null;
  actions: CaseAction[] | null;
}

export interface CaseActionBody {
  action: CaseAction;
  items?: Record<string, number>;
  expected_max_cents?: number;
  template?: "delivered" | "outside_terms" | "other";
  text?: string;
  method?: string;
  reference?: string;
  /** offer_plan_move (RP-05): the receiving account and the plan's
   * subscription the preview showed (409 subscription_changed). */
  to_uid?: string;
  expected_subscription_id?: string;
}

export interface OpenCaseBody {
  uid: string;
  conversion_ids?: string[];
  reason: string;
  text?: string;
  topup_id?: string;
}

export interface BalanceSummary {
  balance_cents: number;
  held_cents: number;
  held_runs: number;
  frozen_cents: number;
  available_cents: number;
  expires_at: string | null;
  expired: boolean;
  never_topped_up: boolean;
  auto_reload: {
    enabled: boolean;
    below_cents: number;
    add_cents: number;
    paused_reason?: string;
  };
  spend_limit_cents: number;
  month_spent_cents: number;
  low_balance_cents: number;
  currency: string;
}

/** BL-29 (gateway rev 00114): the account's runs, newest first, paged. */
/** owner 2026-11-07 (Option B): what a card paid in its own currency, in
 * that currency's minor units; null: US dollars. */
export interface Presentment {
  amount_minor: number;
  /** lower-case ISO 4217 ("jpy") */
  currency: string;
}

export interface AccountRun extends QualityFields {
  id: string;
  presentment?: Presentment | null;
  project_id?: string | null;
  status: string;
  kind?: string | null;
  created_at: string;
  amount_cents?: number | null;
}

export interface AccountRuns {
  count: number;
  items: AccountRun[] | null;
  /** pass as ?runs_before= for the next page; null at the end */
  next_before?: string | null;
}

/** BL-29: usage in the plan period, or the calendar month without a plan. */
export interface AccountUsage {
  period: "plan" | "month" | string;
  period_start?: string | null;
  period_end?: string | null;
  tier?: string | null;
  runs: number;
  succeeded: number;
  spent_cents: number;
  free_preview_runs?: number | null;
  free_previews?: { allowance?: number; used?: number; remaining?: number } | null;
  plan_credit_cents?: number | null;
  plan_credit_left_cents?: number | null;
  plan_credit_used_cents?: number | null;
}

/** BL-29: from Firebase Authentication; methods null when it can't be read. */
export interface AccountSignIn {
  methods: string[] | null;
  passkey_count?: number | null;
  firebase_created_at?: string | null;
  last_sign_in_at?: string | null;
}

export interface AccountPage {
  account: {
    uid: string;
    email: string;
    stripe_customer_id?: string;
    deleted?: boolean;
    blocked?: boolean;
    /** BL-29 */
    created_at?: string | null;
  };
  runs?: AccountRuns | null;
  usage?: AccountUsage | null;
  sign_in?: AccountSignIn | null;
  billing_state: {
    flow_state?: string;
    sheet_only?: boolean;
    sheet_only_reason?: string;
    all_methods_failed?: boolean;
    last_good_method?: string;
    under_review?: boolean;
    lifetime_paid_cents?: number;
    backup_order?: string[] | null;
  };
  owed_cents: number;
  /** the account's passkeys (gateway rev 00113); absent on older gateways */
  passkey_count?: number | null;
  balance?: BalanceSummary | null;
  plan?: {
    plan: string;
    name?: string;
    status?: string;
    active?: boolean;
    cancel_at_period_end?: boolean;
    monthly_cents?: number;
    credit_cents?: number;
    credit_left_cents?: number;
    current_period_end?: string;
  } | null;
  ledger?: { id: string; kind: string; cents: number; at: string }[] | null;
  /** gateway 00106: Grant Pro records */
  grants?: Grant[] | null;
  /** promo entitlements the gateway grants again (e.g. after a refund) */
  promo_regrants?: PromoRegrant[] | null;
  /** gateway 00159 (PRO-07): Pro's monthly usage credit, its grants (last
   * 24 months), how often the account refunded Pro, and the repeat flag */
  pro_credit?: ProCreditAdmin | null;
  /** gateway 00166: the account's 48-hour deletion, when there is one */
  deletion?: AdminDeletion | null;
  /** company detail changes, newest last (the last 20) */
  company_changes?: { at: string; by: string; fields: string[] | null }[] | null;
  /** owner 2026-11-04: the business details on the account's invoices */
  company?: {
    company_name?: string | null;
    address?: { line1?: string; line2?: string; city?: string; postal_code?: string; state?: string; country?: string } | null;
    tax_id?: { type: string; value: string; verification?: string } | null;
    billing_email?: string | null;
    po_reference?: string | null;
  } | null;
  methods?: { id: string; label: string; type: string }[] | null;
  cases?: Case[] | null;
  charges?:
    | {
        charge_id: string;
        kind: string;
        amount_cents: number;
        currency: string;
        paid_at: string;
        lines:
          | {
              conversion_id: string;
              project_id?: string;
              amount_cents: number;
              description: string;
            }[]
          | null;
        invoice_state: string;
        presentment?: Presentment | null;
      }[]
    | null;
  refunds?: RefundRow[] | null;
}

export type AccountAction =
  | "clear_review"
  | "clear_sheet_only"
  | "block"
  | "unblock"
  | "resend_e2"
  | "write_off_owed"
  | "adjust_balance"
  | "restore_promo_grants"
  /** gateway 00166: the 48-hour deletion (process_deletion_now needs a fresh sign-in) */
  | "cancel_deletion"
  | "process_deletion_now";

export interface AccountActionBody {
  action: AccountAction;
  cents?: number;
  case_id?: string;
  note?: string;
}

export interface DisputeMonth {
  month: string;
  charges: number;
  disputes_activity: number;
  disputed_cents_activity: number;
  disputes_by_payment: number;
  activity_pct: number;
  won: number;
  lost: number;
  accepted: number;
  countered: number;
  lost_cents: number;
  /** BL-29: recovered by won disputes; absent on older gateways */
  won_cents?: number;
  dispute_fees_cents: number;
  efw: number;
  efw_cents: number;
  efw_refunded: number;
  efw_became_disputes: number;
}

export interface OpenDispute {
  dispute_id: string;
  amount_cents: number;
  reason: string;
  status: string;
  payment_intent: string;
  due_by?: string;
  case_id?: string;
}

/** GET /v1/admin/onboarding/headsets?days= — the welcome's headset
 * answers (event onboarding_headsets; owner 2026-11-04). A person counts
 * once per device they picked; "converted" = paid for a full 3D run after
 * answering. */
export interface OnboardingHeadsets {
  days: number;
  /** answers per day and device */
  by_day: { day: string; device: string; count: number }[] | null;
  /** answers per plan at the time and device */
  by_plan: { plan: string; device: string; count: number }[] | null;
  /** people per device and how many of them converted */
  conversion: { device: string; people: number; converted: number }[] | null;
  /** owner 2026-11-04: answers per welcome variant ("app_pro" | "default")
   * and device; converted when the gateway counts it (absent on older
   * gateways) */
  by_variant?: { variant: string; device: string; count: number; converted?: number }[] | null;
  /** owner 2026-11-04: the Business/Studio setup funnel — people per step
   * (opened, plan_picked, details_done, checkout_started, purchased), by
   * plan where the step has one */
  business_setup?: { step: string; people: number; by_plan?: Partial<Record<"business" | "studio", number>> }[] | null;
  generated_at: string;
}

/** GET /v1/admin/plans/surfaces?days= (gateway 00093): each plans surface's
 * views, dismissals, clicks and the plan starts attributed to it (last
 * click within 7 days). */
export interface PlansSurfaceRow {
  placement: string;
  views: number;
  viewers: number;
  dismissals: number;
  clicks: number;
  conversions: number;
  conversions_by_product: Partial<Record<"pro" | "business" | "studio", number>>;
  click_rate: number;
  conversion_rate: number;
}

/** A plan start in the window (BL-29, gateway rev 00114), newest first. */
export interface PlanStart {
  uid: string;
  email: string;
  product: "pro" | "business" | "studio" | string;
  /** the web plan id for a Checkout start */
  plan?: string | null;
  source: string;
  /** what the first period cost; null for an App Store start */
  price_cents: number | null;
  started_at: string;
  placement?: string | null;
}

export interface PlansSurfaces {
  days: number;
  /** BL-29: absent on older gateways */
  starts?: PlanStart[] | null;
  generated_at: string;
  placements: PlansSurfaceRow[] | null;
  unattributed: { conversions: number; by_product: Partial<Record<"pro" | "business" | "studio", number>> };
  /** owner 2026-11-04: the same counts per placement and reason
   * (source_8k, source_fps, quote_size, run_length, company_email); absent
   * on older gateways */
  by_reason?: (Omit<PlansSurfaceRow, "conversions_by_product"> & {
    reason: string;
    conversions_by_product?: PlansSurfaceRow["conversions_by_product"];
  })[] | null;
}

export interface DisputeSummary {
  months: DisputeMonth[] | null;
  /** open EFW cases plus caseless fraud-warning holds (header badge) */
  open_efws?: number | null;
  reference_pct: number;
  win_rate: number;
  /** BL-29 window totals: won = recovered */
  won_cents?: number | null;
  lost_cents?: number | null;
  counter_rate: number;
  open: OpenDispute[] | null;
  by_method: Record<string, number> | null;
  by_flow: Record<string, number> | null;
  by_country: Record<string, number> | null;
  scope: string;
  account_wide: string;
  denominator: string;
  generated_at: string;
}

export interface RefundPolicy {
  reasons: Record<string, "auto" | "manual" | string>;
  manual_above_cents: number;
  cap_exempt: string[] | null;
  deadline_business_days: number;
  reminder_hours: number;
  timezone: string;
  dispute_alert_pct: number;
  notify: { slack_channel: string; owner_emails: string[] | null };
}

export interface PolicyResponse {
  policy: RefundPolicy;
  edit_in: string;
}

export interface MailPreview {
  id: string;
  subject: string;
  text: string;
}

export interface MailPreviewsResponse {
  mails: MailPreview[] | null;
  deny_templates: Record<string, string> | null;
}

/** GET /v1/admin/feedback?days=&platform= (owner 2026-11-04): what people
 * sent from the web app and the apps, newest first. */
export interface FeedbackItem {
  id: string;
  /** BL-29: studio | business | pro | free (the sender's web plan, else the app's) */
  plan_tier?: string | null;
  created_at: string;
  /** "web", or the app's platform ("ios", "macos", "visionos"…) */
  platform: string;
  kind: string;
  message: string;
  email?: string | null;
  uid?: string | null;
  ok_to_contact?: boolean;
  app_version?: string | null;
  context?: { route?: string; project_id?: string; run_id?: string; locale?: string } | null;
}

export interface FeedbackList {
  days: number;
  items: FeedbackItem[] | null;
}

/** Grant Pro (gateway 00106). */
export type GrantStatus = "active" | "expired" | "revoked" | "failed" | "granting";

export interface Grant {
  id: string;
  uid: string;
  entitlement: "pro" | "business" | "studio" | string;
  ends_at: string;
  granted_by: string;
  reason: string;
  created_at: string;
  status: GrantStatus;
  rc_error?: string | null;
  revoked_at?: string | null;
  revoked_by?: string | null;
  revoke_reason?: string | null;
}

export interface GrantBody {
  entitlement: "pro" | "business" | "studio";
  /** RFC 3339, 1 hour to 5 years ahead */
  ends_at: string;
  /** up to 500 characters */
  reason: string;
}

export interface RevokeResult {
  grant: Grant;
  regrant?: { id: string; status: string; regranted?: number; skipped?: number } | null;
}

/** A promotional grant in a re-grant record; no expires_at = lifetime. */
export interface PromoGrant {
  entitlement: string;
  product?: string;
  expires_at?: string | null;
  error?: string;
}

/** A refund, dispute, EFW or plan end that took promotional grants away and
 * gives them back (gateway promo_regrants_{env}). */
export interface PromoRegrant {
  id: string;
  uid?: string;
  event: string;
  policy?: string;
  reason?: string;
  status: string;
  snapshot?: PromoGrant[] | null;
  ours?: PromoGrant[] | null;
  to_grant?: PromoGrant[] | null;
  regranted?: PromoGrant[] | null;
  skipped?: PromoGrant[] | null;
  uncertain?: boolean;
  amount_cents?: number;
  case_id?: string;
  outcome?: string;
  merged_into?: string;
  restored_by?: string;
  restore_note?: string;
  last_error?: string;
  created_at: string;
  updated_at?: string;
  resolved_at?: string | null;
}

/** GET /v1/admin/onboarding/business_funnel?days= (Business setup request
 * 2026-11-04): the setup steps and what people answered. */
export interface BusinessFunnel {
  days: number;
  steps?: { step: string; people: number; events: number; rate_from_previous: number }[] | null;
  by_plan?: { step: string; plan: string; people: number }[] | null;
  answers?: {
    accounts: number;
    by_main_use?: { main_use: string; count: number }[] | null;
    by_team_size?: { team_size: string; count: number }[] | null;
  } | null;
  generated_at: string;
}

/** A passkey on the admin account (ADR 0135). */
export interface Passkey {
  id: string;
  name: string;
  created_at: string;
  last_used_at?: string | null;
}

/** GET /v1/admin/passkey-adoption (gateway rev 00113): customer passkeys
 * (ADR 0136) and sign-ins by method over 7 and 30 days. */
/** Grant credit (owner 2026-11-07, gateway 00178): usage credit an admin
 * adds to an account. */
export type CreditGrantReason = "support_goodwill" | "refund_as_credit" | "promo" | "test" | "other";

export interface CreditGrant {
  id: string;
  uid?: string;
  amount_cents: number;
  reason: CreditGrantReason | string;
  reason_text?: string | null;
  expires_at?: string | null;
  over_cap?: boolean;
  admin?: string;
  request_id?: string;
  notify_user?: boolean;
  message?: string | null;
  /** sent | dry_run | skipped | null */
  mail_state?: string | null;
  /** pending | active | revoked */
  state: string;
  /** what's left of it; null on the all-grants list */
  unspent_cents?: number | null;
  revoked_cents?: number;
  revoked_at?: string | null;
  revoked_by?: string | null;
  created_at: string;
}

export interface CreditGrantBody {
  amount_cents: number;
  reason: CreditGrantReason;
  reason_text?: string;
  /** absent = 90, null = no end */
  expires_days?: number | null;
  notify_user?: boolean;
  message?: string;
  request_id: string;
  confirm_over_cap?: boolean;
}

export interface CreditGrantPreview {
  amount_cents: number;
  cap_cents: number;
  over_cap: boolean;
  expires_at: string | null;
  balance_before_cents: number;
  balance_after_cents: number;
}

export interface CreditBalanceAfter {
  balance_cents: number;
  credits: { kind: string; cents: number; expires_at?: string | null }[];
}

export interface CreditGrantResult {
  grant: CreditGrant;
  balance_after: CreditBalanceAfter | null;
  replay?: boolean;
}

export interface CreditGrantRevokeResult {
  grant: CreditGrant;
  revoked_cents: number;
  balance_after: CreditBalanceAfter | null;
}

export interface AllCreditGrants {
  grants: CreditGrant[];
  months: { month: string; grants: number; cents: number; revoked_cents: number }[];
  truncated?: boolean;
}

/** GET /v1/admin/campaign (owner 2026-11-07, gateway 00175): discounted =
 * succeeded runs; quoted = every run the offer was on, by state (lowercase). */
export interface CampaignSummary {
  campaign: {
    active: boolean;
    pct?: number;
    percent?: number;
    max_preset?: string;
    presets?: string[];
    starts_at?: string;
    ends_at?: string | null;
    label?: string;
  } | null;
  totals: {
    runs: number;
    quoted_cents: number;
    discounted_runs: number;
    discounted_cents: number;
    by_state?: Record<string, { runs: number; cents: number }>;
  };
  by_month?: { month: string; runs: number; cents: number }[];
  truncated?: boolean;
}

export interface PasskeyAdoption {
  accounts_with_passkey: number;
  passkeys: number;
  sign_ins: Partial<Record<"7d" | "30d", Record<string, number>>>;
  generated_at: string;
}

/** GET /v1/admin/accounts?q= (BL-29 ⌘K): an exact uid first, then emails starting with q, at most 20. */
export interface AccountHit {
  uid: string;
  email: string;
  created_at?: string | null;
  plan?: string | null;
  /** gateway 8f04bda */
  deleted?: boolean;
  found_by?: "record" | "stripe";
}

/** GET /v1/admin/runs/{id} (BL-29 ⌘K); 404 run_not_found. */
export interface RunLookup {
  id: string;
  uid: string;
  project_id?: string | null;
  status: string;
  created_at: string;
  amount_cents?: number | null;
  currency?: string | null;
  kind?: string | null;
  method?: string | null;
  presentment?: Presentment | null;
}

/** GET /v1/admin/grants (BL-29, gateway rev 00114): every admin grant
 * (Grant Pro), active first, then newest; kind is the entitlement. */
export interface AdminGrant {
  id: string;
  uid: string;
  email?: string | null;
  kind: string;
  granted_by: string;
  start: string;
  end: string;
  status: GrantStatus | string;
  reason: string;
  revoked_at?: string | null;
  revoked_by?: string | null;
  revoke_reason?: string | null;
}

/** GET /v1/admin/efws (BL-29, gateway rev 00114): open early fraud
 * warnings, newest first; case_id null for a caseless fraud-warning hold. */
export interface OpenEfw {
  id: string;
  uid?: string | null;
  charge?: string | null;
  payment_intent?: string | null;
  amount_cents?: number | null;
  created?: string | null;
  case_id?: string | null;
}

/** GET/POST /v1/admin/feedback/seen (BL-29): one console-wide marker. */
export interface FeedbackSeen {
  seen_at: string | null;
  updated_at?: string | null;
}

/** One month of Pro credit (gateway 00159, pro_credit_grants_{env}). */
export interface ProCreditGrant {
  id: string;
  /** 0 = the first month from the purchase */
  month: number;
  period_start: string;
  period_end: string;
  cents: number;
  /** pro_weekly … pro_lifetime */
  kind: string;
  /** app_store | mac_app_store | rc_billing | web */
  source: string;
  /** the store's period type ("trial", "normal", "intro"), when sent */
  period_type?: string;
  state: "granting" | "granted" | "removed";
  granted_at: string;
  removed_at?: string;
  removed_cents?: number;
}

/** The account page's pro_credit. */
export interface ProCreditAdmin {
  grants: ProCreditGrant[] | null;
  /** Pro purchases this account refunded */
  refunds: number;
  /** refunded Pro more than once: the gateway also alerts on it */
  refund_flag: boolean;
}

/** gateway 00166: an account's 48-hour deletion (GET /v1/admin/deletions,
 * the account page's `deletion`). */
export interface AdminDeletion {
  uid: string;
  state: "pending" | "cancelled" | "done";
  requested_at: string;
  delete_after: string;
  balance_confirmed?: boolean;
  /** where it was asked: web, app, … */
  source?: string;
  /** the scheduled run couldn't delete it yet (stays pending, tried again) */
  blocked?: boolean;
  blocked_reason?: string;
  blocked_at?: string | null;
  next_attempt_at?: string | null;
  attempts?: number;
  cancelled_at?: string | null;
  cancelled_by?: string;
  processed_at?: string | null;
  processed_by?: string;
  outcome?: string;
}
