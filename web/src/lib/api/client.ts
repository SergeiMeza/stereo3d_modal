/**
 * Typed gateway client. All requests carry the Firebase ID token; all
 * errors surface as GatewayError with the machine code + the user-safe
 * message (which always contains the conversion/project id for support).
 */

import { pendingDeletionMessage } from "@/lib/accountDeletion";
import { EN, type Tr } from "@/lib/i18n/t";
import { isReauthCode } from "@/lib/reauth";
import type {
  AccountDeleteResult,
  PayRequest,
  PayRequestCheckout,
  AccountDeletionCancel,
  AccountPlan,
  AccountSettings,
  AccountSettingsPatch,
  BalanceEntry,
  BalanceSettings,
  BalanceSummary,
  CheckoutStart,
  OneTapAnswer,
  UsagePage,
  HandoffInfo,
  HandoffStart,
  CompanyDetails,
  Format,
  RunFormatJob,
  RunFormats,
  InvoiceList,
  APIErrorBody,
  BillingSettleResult,
  BillingSetupTicket,
  BillingHistory,
  HistoryFilter,
  BillingMethods,
  PayNowStart,
  BillingStatus,
  Conversion,
  CreateProjectRequest,
  DownloadFile,
  Downloads,
  GatewayLimits,
  Project,
  PublicPricing,
  RestoreResult,
  StepConversionRequest,
  StepQuoteResponse,
  UpdateProjectRequest,
  UpdateScenesRequest,
  UploadTicket,
} from "./types";
import type { RegistrationResponseJSON } from "@simplewebauthn/browser";

import { PASSKEY_ROUTES, type Passkey } from "@/lib/passkeys";
import {
  ResumableUploadError,
  uploadResumable,
  type ChunkTransport,
} from "./resumableUpload";

/** Files larger than this go up in resumable 8 MiB chunks for everyone
 * (retry and resume after a dropped connection); smaller ones keep the
 * single signed PUT unless the region forces chunks (China mode). */
export const CHUNKED_UPLOAD_THRESHOLD_BYTES = 100 * 1000 * 1000;

/** Whether a file of this size goes up in chunks. */
export function wantsChunkedUpload(
  sizeBytes: number | undefined,
  forced = false,
): boolean {
  return (
    forced ||
    (sizeBytes !== undefined && sizeBytes > CHUNKED_UPLOAD_THRESHOLD_BYTES)
  );
}

/** Split outputs are named "<format>_partNN" (mvhevc_part01, …), as in
 * the gateway's downloads map. The gateway also lists every output in
 * `files` ({name, format, part, filename, url}); those are folded into the
 * same name → URL map (a part without its map key gets "<format>_partNN"),
 * so the rest of the app reads one shape. A downloads list of entries is
 * accepted the same way. */
export function normalizeDownloads(raw: unknown): Downloads {
  const body = (raw ?? {}) as {
    downloads?: unknown;
    files?: unknown;
    expires_in?: number;
  };
  const out: Record<string, string> = {};
  const files: DownloadFile[] = [];
  const partKey = (base: string, part: number) =>
    /_part\d+$/.test(base) ? base : `${base}_part${String(part).padStart(2, "0")}`;
  const putEntry = (fallbackName: string, value: unknown) => {
    if (typeof value === "string") {
      out[fallbackName] = value;
      return;
    }
    if (!value || typeof value !== "object") return;
    const e = value as {
      name?: unknown;
      format?: unknown;
      part?: unknown;
      filename?: unknown;
      url?: unknown;
      size_bytes?: unknown;
    };
    if (typeof e.url !== "string") return;
    const format =
      typeof e.format === "string"
        ? e.format
        : typeof e.name === "string"
          ? e.name.replace(/_part\d+$/, "")
          : fallbackName;
    const part = typeof e.part === "number" ? e.part : undefined;
    const name =
      part !== undefined
        ? partKey(typeof e.name === "string" ? e.name : format, part)
        : typeof e.name === "string"
          ? e.name
          : fallbackName;
    out[name] = e.url;
    files.push({
      name,
      format,
      ...(part !== undefined ? { part } : {}),
      ...(typeof e.filename === "string" ? { filename: e.filename } : {}),
      ...(typeof e.size_bytes === "number" ? { size_bytes: e.size_bytes } : {}),
      url: e.url,
    });
  };
  if (Array.isArray(body.downloads)) {
    body.downloads.forEach((entry, i) => putEntry(`output${i + 1}`, entry));
  } else if (body.downloads && typeof body.downloads === "object") {
    for (const [name, value] of Object.entries(body.downloads)) {
      putEntry(name, value);
    }
  }
  if (Array.isArray(body.files)) {
    body.files.forEach((entry, i) => putEntry(`file${i + 1}`, entry));
  }
  // the map and the files listing name the same outputs: keep one entry
  // per name, the files listing's (it carries filename and size)
  const byName = new Map<string, DownloadFile>();
  for (const f of files) byName.set(f.name, { ...byName.get(f.name), ...f });
  const listed = [...byName.values()];
  return {
    downloads: out,
    expires_in: body.expires_in ?? 0,
    ...(listed.length > 0 ? { files: listed } : {}),
  };
}

/** S3D-24: what a 410 files_deleted says, wherever it comes from
 * (downloads, quotes, new runs, retries, uploads into the project). */
export function uploadAgain(t: Tr = EN): string {
  return t("errors.filesDeleted.uploadAgain");
}
export function filesDeletedMessage(t: Tr = EN): string {
  return t("errors.filesDeleted.message");
}
/** English (callers without a translator) */
export const FILES_DELETED_MESSAGE = filesDeletedMessage();

/** POST /v1/plans/preview-change: today's charge is the new plan less
 * the unused days of the current one. */
export interface PlanChangePreview {
  from?: string;
  to: string;
  /** pass back to POST /v1/plans/change; valid 15 minutes (gateway 00102) */
  quote_at?: string;
  today_cents: number;
  new_plan_cents: number;
  /** upgrades: what the unused part of the current plan takes off — paid ×
   * min(time left, usage left) (owner 2026-11-04) */
  unused_credit_cents?: number;
  credit_basis?: { time_share: number; usage_share: number; paid_cents: number } | null;
  renews_at?: string;
  /** owner 2026-11-04: a step-down starts at the end of the paid period;
   * nothing is charged today */
  kind?: "step_up" | "step_down";
  effective_at?: string;
  currency?: string;
}

/** GET /v1/support/refund-options (gateway efa1856). */
export interface RefundOptions {
  window_days?: number;
  plan: {
    invoice_id: string;
    plan: string;
    name: string;
    paid_at: string;
    paid_cents: number;
    cancelled: boolean;
    open_request_id: string | null;
  } | null;
  runs: {
    conversion_id: string;
    label: string;
    paid_at: string;
    amount_cents: number;
    open_request_id: string | null;
  }[];
  /** RF-02: top-ups with an unspent part someone may ask about (a person
   * decides); the gateway's window_days stays internal, never shown */
  balance?: {
    window_days?: number;
    unspent_cents: number;
    topups: { topup_id: string; paid_at: string; paid_cents: number; unspent_cents: number; open_request_id: string | null }[];
  } | null;
}

export type SupportRequestState = "looking" | "asked" | "refunded" | "not_refunded" | "waived" | "closed";

/** GET /v1/support/requests: a request as its customer sees it. */
export interface SupportRequest {
  id: string;
  about: "plan" | "runs" | "balance" | "other";
  state: SupportRequestState;
  /** plain words from the gateway: "We're looking at it", … */
  status: string;
  opened_at: string;
  updated_at?: string;
  requested_cents?: number;
  refunded_cents?: number;
  your_note?: string | null;
  conversion_ids?: string[];
  /** while state is "asked": what we asked */
  question?: string | null;
  follow_up_of?: string | null;
}

/** GET /v1/account/identities (EM-02). `providers` are apple.com,
 * google.com and email; a password is reported apart. */
export interface AccountIdentities {
  providers: string[];
  email?: string;
  email_verified?: boolean;
  password?: boolean;
  passkeys?: number;
  anonymous?: boolean;
  /** gateway 00155: this account's email belongs to another account in
   * the email store (named only by how it signs in) */
  other_account?: { email_masked?: string; providers?: string[]; sign_in_with?: string } | null;
}

export type IdentityLink =
  | { provider: "apple.com" | "google.com"; id_token: string; nonce?: string }
  | { provider: "email"; email: string; code: string; replace?: boolean };

/** GET /v1/account/emails (gateway 00152): up to five, one main. */
export interface AccountEmail {
  id: string;
  email: string;
  main: boolean;
  /** an Apple Hide My Email address */
  relay: boolean;
  added_at?: string;
}

export interface AccountEmails {
  emails: AccountEmail[];
  /** a Business or Studio plan whose main email is missing or a relay */
  plan_email_needed: boolean;
  /** the main email changed: the session's ID token is stale */
  refresh_token?: boolean;
}

/** GET /v1/support/plan-moves (gateway 00155, RP-05). */
export interface PlanMoveOffer {
  id: string;
  plan: string;
  plan_id?: string;
  ends_at: string;
  from?: string[];
  moves: string[];
  stays: string[];
  carry_cents?: number;
  expires_at?: string;
}

/** POST /v1/billing/restore/find/verify (gateway 00152). */
export interface RestoreOffer {
  offer_id: string;
  plan: string;
  plan_id?: string;
  ends_at: string;
  renews: boolean;
  /** how the found plan's account signed in (apple.com, google.com, email) */
  from?: string[];
  /** plain keys: plan, app_access, current_usage, months_not_yet_given */
  moves: string[];
  /** plain keys: usage_already_used, balance, app_store_purchases, past_runs_and_files */
  stays: string[];
  carry_cents?: number;
}

export type FeedbackKind = "idea" | "problem" | "other";

export interface FeedbackBody {
  kind: FeedbackKind;
  message: string;
  email?: string;
  ok_to_contact: boolean;
  context: { route: string; project_id?: string; run_id?: string; locale: string };
}

export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export type TokenProvider = () => Promise<string>;

export interface ClientOptions {
  /** e.g. https://api.stereo3d.studio; a function is read per request
   * (the region, lib/region.ts, is only settled in the browser). */
  baseUrl: string | (() => string);
  getToken: TokenProvider;
  fetchFn?: typeof fetch; // injectable for tests
  /** Force resumable upload tickets for every file (China mode: the cn.
   * hosts carry at most 25 MB per request, so files go up in chunks). Read
   * per upload. Files over CHUNKED_UPLOAD_THRESHOLD_BYTES are chunked for
   * everyone regardless. */
  resumableUploads?: () => boolean;
  /** Chunk PUTs (default XHR, for progress); injectable for tests. */
  chunkTransport?: ChunkTransport;
  /** Owner 2026-11-06: a sensitive route answered 401 reauth_required;
   * resolves once the person has signed in again (lib/reauth), and the
   * request is tried once more. Rejects when they don't. */
  onReauthRequired?: () => Promise<void>;
  /** The reader's language for the errors the client words itself (the
   * gateway's own messages stay as sent); English when absent. */
  t?: Tr;
  /** BL-34: settles the route before a request (before the token too, so
   * the token comes from the sign-in the route uses). */
  prepare?: () => Promise<void>;
  /** BL-34: a request failed before any answer (fetch threw); the route
   * looks again. HTTP statuses never reach it. */
  onConnectionFailure?: (error: unknown) => void;
}

export class GatewayClient {
  constructor(private readonly opts: ClientOptions) {}

  private base(): string {
    return typeof this.opts.baseUrl === "function" ? this.opts.baseUrl() : this.opts.baseUrl;
  }

  /** fetch, telling the route about a failure before any answer. */
  private async send(url: string, init: RequestInit): Promise<Response> {
    const f = this.opts.fetchFn ?? fetch;
    try {
      return await f(url, init);
    } catch (e) {
      this.opts.onConnectionFailure?.(e);
      throw e;
    }
  }

  private get t(): Tr {
    return this.opts.t ?? EN;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    opts: { anonymous?: boolean; reauth?: "auto" | "manual" } = {},
  ): Promise<T> {
    try {
      return await this.requestOnce<T>(method, path, body, headers, opts);
    } catch (e) {
      // owner 2026-11-06: one shared "Confirm it's you", then once more
      // ("manual": the caller asks itself, e.g. a passkey prompt that has
      // to come from a click)
      if (
        e instanceof GatewayError &&
        e.status === 401 &&
        isReauthCode(e.code) &&
        opts.reauth !== "manual" &&
        this.opts.onReauthRequired
      ) {
        await this.opts.onReauthRequired();
        return this.requestOnce<T>(method, path, body, headers, opts);
      }
      throw e;
    }
  }

  private async requestOnce<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    opts: { anonymous?: boolean } = {},
  ): Promise<T> {
    await this.opts.prepare?.();
    const token = opts.anonymous ? null : await this.opts.getToken();
    const res = await this.send(`${this.base()}${path}`, {
      method,
      headers: {
        ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let parsed: APIErrorBody | undefined;
      try {
        parsed = (await res.json()) as APIErrorBody;
      } catch {
        /* non-JSON error body */
      }
      const code = parsed?.error ?? "server_error";
      throw new GatewayError(
        code,
        code === "files_deleted"
          ? filesDeletedMessage(this.t)
          : code === "account_pending_deletion"
            ? pendingDeletionMessage(parsed?.details?.delete_after, this.t)
            : (parsed?.message ?? this.t("errors.requestFailed", { status: res.status })),
        res.status,
        parsed?.details,
      );
    }
    if (res.status === 204) return undefined as T; // e.g. a DELETE with no body
    return (await res.json()) as T;
  }

  // ---------------------------------------------------------- customers

  ensureCustomer(): Promise<{ customer_id: string }> {
    return this.request("POST", "/v1/customers", {});
  }

  /** Stripe customer-portal session (manage saved payment methods and
   * receipts); the portal returns the user to returnUrl when done. */
  createBillingPortalSession(returnUrl: string): Promise<{ url: string }> {
    return this.request("POST", "/v1/billing/portal", {
      return_url: returnUrl,
    });
  }

  /** Delete the account. The gateway charges what is owed first and
   * refuses with 402 balance_due (details: amount_cents, requires_action,
   * client_secret, publishable_key) or 409 active_runs; with a prepaid
   * balance, 409 balance_remaining {cents} until balance_confirmed, then
   * 202 deletion_pending while the balance is refunded (00081). */
  deleteAccount(opts: { balance_confirmed?: boolean } = {}): Promise<AccountDeleteResult> {
    return this.request("POST", "/v1/account/delete", opts.balance_confirmed ? { balance_confirmed: true } : {});
  }

  /** gateway 00166: keep the account while its deletion waits (a fresh
   * sign-in; 409 not_pending_deletion when nothing waits). */
  cancelAccountDeletion(): Promise<AccountDeletionCancel> {
    return this.request("POST", "/v1/account/delete/cancel", {});
  }

  // ------------------------------------------------------------- billing

  /** Pay-as-you-go billing status — also ensures the billing profile and
   * heals the default payment method after onboarding / a portal edit. */
  getBilling(): Promise<BillingStatus> {
    return this.request("GET", "/v1/billing");
  }

  /** Restore Purchases: resync this account's web purchases (no charge;
   * 429 rate_limited after 5 an hour, 403 account_deleted). */
  restorePurchases(): Promise<RestoreResult> {
    return this.request("POST", "/v1/billing/restore", {});
  }

  /** Saved payment methods, read-only (S3D-62: managed in the customer
   * portal). */
  getPaymentMethods(): Promise<BillingMethods> {
    return this.request("GET", "/v1/billing/methods");
  }

  /** Pay a pay-now run without the Payment Element (China mode, S3D-61):
   * Alipay answers with a redirect, WeChat Pay with a QR code. */
  startPayNow(
    conversionId: string,
    method: "alipay" | "wechat_pay",
    returnUrl: string,
  ): Promise<PayNowStart> {
    return this.request("POST", `/v1/conversions/${encodeURIComponent(conversionId)}/pay-now`, {
      method,
      return_url: returnUrl,
    });
  }

  /** Card charges as on the statement (S3D-57). */
  /** spec v6 F: 25 rows a page; `after` = the last row_id seen. */
  getBillingHistory(after?: string, filter?: HistoryFilter): Promise<BillingHistory> {
    const q = new URLSearchParams({ limit: "25" });
    if (after) q.set("starting_after", after);
    if (filter) q.set("filter", filter);
    return this.request("GET", `/v1/billing/history?${q.toString()}`);
  }

  /** SetupIntent material for the onboarding card capture. */
  createBillingSetupIntent(): Promise<BillingSetupTicket> {
    return this.request("POST", "/v1/billing/setup-intent", {});
  }

  /** Retry the outstanding automatic charges on the current default card. */
  // ----------------------------------------- spec v7 N13: the balance

  /** P17: a top-up payment; 422 amount_out_of_range {min, max}; China
   * mode passes {method} for the server path */
  topUp(
    amountCents: number,
    method?: "alipay",
  ): Promise<{
    checkout?: { client_secret: string; expires_at: string };
    topup_id: string;
    /** BUX-23 (proposal): the bonus credit this top-up adds once paid */
    bonus_cents?: number;
    publishable_key?: string;
    redirect_url?: string;
    qr_image_url?: string;
  }> {
    return this.request(
      "POST",
      "/v1/billing/balance/topup",
      method
        ? {
            amount_cents: amountCents,
            method,
            // BUX-04: the return page confirms the top-up by its amount
            return_url:
              typeof window !== "undefined"
                ? `${window.location.origin}/pay/return?topup=1&amount=${amountCents}`
                : undefined,
          }
        : { amount_cents: amountCents, ui: "elements" },
    );
  }

  /** P18/P19; 409 method_needed (auto-reload without a saved method) */
  saveBalanceSettings(s: BalanceSettings): Promise<BalanceSummary> {
    return this.request("PUT", "/v1/billing/balance/settings", s);
  }

  getUsage(month: string, after?: string): Promise<UsagePage> {
    const q = `?month=${encodeURIComponent(month)}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`;
    return this.request("GET", `/v1/billing/usage${q}`);
  }

  /** The CSV download's address for a month. */
  usageCsvUrl(month: string): string {
    return `${this.base()}/v1/billing/usage?month=${encodeURIComponent(month)}&format=csv`;
  }

  /** the CSV itself (signed request), for a download */
  async usageCsv(month: string): Promise<string> {
    await this.opts.prepare?.();
    const token = await this.opts.getToken();
    const res = await this.send(this.usageCsvUrl(month), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new GatewayError("server_error", this.t("errors.csvDownloadFailed"), res.status);
    return res.text();
  }

  getBalanceEntries(after?: string): Promise<{ entries: BalanceEntry[]; has_more?: boolean }> {
    return this.request("GET", `/v1/billing/balance/entries${after ? `?starting_after=${encodeURIComponent(after)}` : ""}`);
  }

  // ------------------------------------------------- refund requests

  /** Owner 2026-11-06: what can be asked for a refund (paid in the last
   * 30 days): finished, paid, unrefunded runs and the plan's latest
   * invoice, each with its open request. */
  getRefundOptions(): Promise<RefundOptions> {
    return this.request("GET", "/v1/support/refund-options");
  }

  /** A refund request, always reviewed by a person. Needs a fresh sign-in
   * (the shared Confirm it's you). 400 not_refundable, text_too_long; 409
   * too_many_open; 429 rate_limited; 403 account_deleted /
   * deletion_pending. */
  requestRefund(body: { plan?: boolean; conversion_ids?: string[]; balance?: boolean; text?: string }): Promise<{
    requests: { id: string; state: SupportRequestState; status: string; merged?: boolean }[];
  }> {
    return this.request("POST", "/v1/support/refund-requests", body);
  }

  /** The account's requests, newest first, status in plain words. */
  async getSupportRequests(): Promise<SupportRequest[]> {
    const r = await this.request<{ requests?: SupportRequest[] | null }>("GET", "/v1/support/requests");
    return r.requests ?? [];
  }

  /** A message on a request (a closed one gets a follow-up). */
  replyToSupportRequest(id: string, text: string): Promise<SupportRequest> {
    return this.request("POST", `/v1/support/requests/${encodeURIComponent(id)}/reply`, { text });
  }

  // ------------------------------------------------- emails (00152)

  getEmails(): Promise<AccountEmails> {
    return this.request("GET", "/v1/account/emails");
  }

  /** A code to that address (always 202, whoever holds it). */
  startAddEmail(email: string, language?: string): Promise<{ sent?: boolean; resend_after_s?: number }> {
    return this.request("POST", "/v1/account/emails/start", { email, ...(language ? { language } : {}) });
  }

  /** Add it with its code (fresh sign-in). 409 credential_in_use
   * {providers}, relay_not_main, too_many_emails. */
  addEmail(body: { email: string; code: string; make_main?: boolean }): Promise<AccountEmails> {
    return this.request("POST", "/v1/account/emails", body);
  }

  /** Make it main (fresh). 409 relay_not_main, email_unverified. */
  makeMainEmail(id: string): Promise<AccountEmails> {
    return this.request("POST", `/v1/account/emails/${encodeURIComponent(id)}/main`, {});
  }

  /** Remove it (fresh). 409 main_email_not_removable, last_method. */
  removeEmail(id: string): Promise<AccountEmails> {
    return this.request("DELETE", `/v1/account/emails/${encodeURIComponent(id)}`);
  }

  // ------------------------------------------------- restore move (00152)

  /** A code to that address (always 202, found or not). */
  restoreFind(email: string, language?: string): Promise<{ sent?: boolean; resend_after_s?: number }> {
    return this.request("POST", "/v1/billing/restore/find", { email, ...(language ? { language } : {}) });
  }

  /** {} matches the caller's own sign-ins and emails; {email, code} the
   * address it proved. found: [] when nothing matches. 409
   * restored_elsewhere {providers}. */
  restoreFindVerify(body: { email?: string; code?: string } = {}): Promise<{ proof_id: string | null; found: RestoreOffer[] }> {
    return this.request("POST", "/v1/billing/restore/find/verify", body);
  }

  /** Move the found plan here (fresh sign-in). 409 has_own_plan,
   * restored_elsewhere; 400 proof_invalid; 502 restore_unavailable. */
  restoreMove(proofId: string, offerId: string): Promise<{ restored: boolean; message?: string }> {
    return this.request("POST", "/v1/billing/restore/move", { proof_id: proofId, offer_id: offerId });
  }

  // ------------------------------------------------- support plan moves (00155)

  /** Plans support offered to move to this account (RP-05). */
  async getPlanMoves(): Promise<PlanMoveOffer[]> {
    const r = await this.request<{ moves?: PlanMoveOffer[] | null }>("GET", "/v1/support/plan-moves");
    return r.moves ?? [];
  }

  /** Accept it (fresh sign-in). 409 a blocker (the offer stays open), 410
   * move_expired, 404 move_not_found. */
  acceptPlanMove(id: string): Promise<{ moved: boolean }> {
    return this.request("POST", `/v1/support/plan-moves/${encodeURIComponent(id)}/accept`, {});
  }

  // ------------------------------------------------- sign-in methods

  /** EM-02 (owner 2026-11-06): the account's ways in, from the gateway
   * (not the Firebase SDK, so China mode can read them too). */
  getIdentities(): Promise<AccountIdentities> {
    return this.request("GET", "/v1/account/identities");
  }

  /** Link Apple or Google (an ID token and the raw nonce from the
   * browser's own sign-in) or an email (a code from /v1/auth/email/start)
   * onto this account (gateway 00152: an email is added; replace: true
   * makes it main and keeps the old one). 409 credential_in_use
   * {providers}; 400 invalid_credential. */
  linkIdentity(body: IdentityLink): Promise<AccountIdentities> {
    return this.request("POST", "/v1/account/identities/link", body);
  }

  /** Remove apple.com, google.com or password. 409 last_method, 404
   * not_linked, 409 email_not_removable. */
  unlinkIdentity(provider: string): Promise<AccountIdentities> {
    return this.request("DELETE", `/v1/account/identities/${encodeURIComponent(provider)}`);
  }

  /** ADR 0136: the account's passkeys */
  async listPasskeys(): Promise<Passkey[]> {
    const r = await this.request<{ passkeys?: Passkey[] | null }>("GET", PASSKEY_ROUTES.list);
    return r.passkeys ?? [];
  }

  /** ADR 0136: options to create a passkey; 401 reauth_required when the
   * sign-in is older than 5 minutes. */
  passkeyRegisterOptions(name: string): Promise<unknown> {
    // the passkey prompt after it has to come from a click: the add
    // dialog asks "Confirm it's you" itself, then the person presses Add
    return this.request("POST", PASSKEY_ROUTES.registerOptions, { name }, undefined, { reauth: "manual" });
  }

  /** ADR 0136: save the new passkey; 409 passkey_exists. */
  passkeyRegisterVerify(response: RegistrationResponseJSON, name: string): Promise<{ passkey?: Passkey }> {
    return this.request("POST", PASSKEY_ROUTES.registerVerify, { response, name });
  }

  /** ADR 0136: rename a passkey. */
  async renamePasskey(id: string, name: string): Promise<Passkey | null> {
    const r = await this.request<{ passkey?: Passkey }>("PATCH", PASSKEY_ROUTES.item(id), { name });
    return r.passkey ?? null;
  }

  /** ADR 0136: remove a passkey. */
  async removePasskey(id: string): Promise<void> {
    await this.request("DELETE", PASSKEY_ROUTES.item(id));
  }

  /** BL-25: the account's settings */
  getAccountSettings(): Promise<AccountSettings> {
    return this.request("GET", "/v1/account/settings");
  }

  /** BL-25: change them */
  patchAccountSettings(patch: AccountSettingsPatch): Promise<AccountSettings> {
    return this.request("PATCH", "/v1/account/settings", patch);
  }

  /** Plans canvas, Nudge C: a sales enquiry ("Talk to us"); a person
   * replies by email. */
  /** gateway 00094: a sales enquiry; 400 invalid_request, 429 rate_limited
   * (5 a day) */
  contactSales(body: {
    topic: "business" | "studio" | "other";
    message: string;
    company?: string;
    team_size?: string;
  }): Promise<{ sent: boolean }> {
    return this.request("POST", "/v1/contact", body);
  }

  /** Ask the gateway to read the Pro state again (after a purchase; it
   * attributes the plan start). */
  refreshPro(): Promise<{ pro?: boolean }> {
    return this.request("POST", "/v1/pro/refresh", {});
  }

  /** Owner 2026-11-04: what changing a web Pro to `to` costs today, before
   * anything is charged. */
  previewPlanChange(to: string): Promise<PlanChangePreview> {
    return this.request("POST", "/v1/plans/preview-change", { to });
  }

  /** Keep the current plan: drop a scheduled step-down. */
  cancelScheduledChange(): Promise<unknown> {
    return this.request("DELETE", "/v1/plans/scheduled-change");
  }

  /** Change the plan after the person confirmed the preview. */
  changePlan(
    to: string,
    quoteAt?: string,
  ): Promise<{ plan: string; status?: string }> {
    return this.request("POST", "/v1/plans/change", {
      to,
      confirm: true,
      ...(quoteAt ? { quote_at: quoteAt } : {}),
    });
  }

  /** In-app feedback (owner 2026-11-04; the app's store): with the
   * account's token when signed in, without one otherwise. */
  sendFeedback(body: FeedbackBody, opts: { signedIn: boolean }): Promise<{ sent?: boolean; id?: string }> {
    return this.request("POST", "/v1/feedback", body, undefined, { anonymous: !opts.signedIn });
  }

  /** Our own product events (onboarding answers etc.), stored by the
   * gateway with the account; never throws into product code. */
  logEvent(name: string, props: Record<string, unknown>): void {
    void this.request("POST", "/v1/events", { name, props }).catch(() => {});
  }

  /** pricing 2026-11: start a Business or Studio plan (409 plan_active) */
  startPlan(plan: "business" | "studio" | string): Promise<{
    plan: string;
    publishable_key?: string;
    checkout: { client_secret: string; expires_at: string };
    url?: string;
  }> {
    return this.request("POST", "/v1/billing/plan", { plan, ui: "elements" });
  }

  /** cancels at the period's end, or resumes */
  cancelPlan(resume = false): Promise<AccountPlan> {
    return this.request("POST", "/v1/billing/plan/cancel", resume ? { resume: true } : {});
  }

  /** 00081: a play of View in 3D or a preview (fire-and-forget) */
  logPlay(conversionId: string, file: string, kind: "view_in_3d" | "preview"): void {
    void this.request("POST", `/v1/conversions/${encodeURIComponent(conversionId)}/plays`, { file, kind }).catch(() => {});
  }

  /** N9: pay what's owed from the balance */
  settleFromBalance(): Promise<BillingSettleResult> {
    return this.request("POST", "/v1/billing/settle", { source: "balance" });
  }

  // ---------------------------------------------- spec v6 F: hand-off

  /** P7: a code and link to pay this run on another device; email mails it */
  createHandoff(conversionId: string, email = false): Promise<HandoffStart> {
    return this.request(
      "POST",
      `/v1/conversions/${encodeURIComponent(conversionId)}/handoff`,
      email ? { email: true } : {},
    );
  }

  /** P8 (public): what the link pays for; 404 bad link, 429 too many */
  /** D7 (public): the payment a failure mail links to */
  getPayRequest(token: string): Promise<PayRequest> {
    return this.request("GET", `/v1/pay-requests/${encodeURIComponent(token)}`, undefined, undefined, {
      anonymous: true,
    });
  }

  /** D7 (public): our payment form, the hosted invoice, or a step-up's
   * bank confirmation */
  startPayRequest(token: string): Promise<PayRequestCheckout> {
    const back = typeof window !== "undefined" ? `${window.location.origin}/pay/${encodeURIComponent(token)}` : undefined;
    return this.request(
      "POST",
      `/v1/pay-requests/${encodeURIComponent(token)}/checkout`,
      { ui: "elements", ...(back ? { return_url: back } : {}) },
      undefined,
      { anonymous: true },
    );
  }

  getHandoff(code: string): Promise<HandoffInfo> {
    return this.request("GET", `/v1/handoff/${encodeURIComponent(code)}`, undefined, undefined, {
      anonymous: true,
    });
  }

  /** P8 (public): outside China {url} of a hosted page; China {method} →
   * redirect_url or qr_image_url */
  payHandoff(
    code: string,
    method?: "alipay" | "wechat_pay",
  ): Promise<{ url?: string; redirect_url?: string; qr_image_url?: string; expires_at?: string }> {
    return this.request(
      "POST",
      `/v1/handoff/${encodeURIComponent(code)}/pay`,
      method ? { method, return_url: `${window.location.origin}/p/${code}?back=1` } : { return_url: `${window.location.origin}/p/${code}?back=1` },
      undefined,
      { anonymous: true },
    );
  }

  // ------------------------------------------- spec v6.2: our Billing UI

  /** P15: a setup session for adding a method; 409 too_many_methods */
  setupPaymentMethod(makeDefault: boolean): Promise<{ client_secret: string; publishable_key?: string }> {
    return this.request("POST", "/v1/billing/methods/setup", { make_default: makeDefault });
  }

  setDefaultMethod(id: string): Promise<BillingMethods> {
    return this.request("POST", `/v1/billing/methods/${encodeURIComponent(id)}/default`, {});
  }

  /** the backup order (all ids, default first) */
  orderMethods(ids: string[]): Promise<BillingMethods> {
    return this.request("PUT", "/v1/billing/methods/order", { ids });
  }

  /** 409 method_needed while it's the last one and something is owed */
  removeMethod(id: string): Promise<BillingMethods> {
    return this.request("DELETE", `/v1/billing/methods/${encodeURIComponent(id)}`);
  }

  getCompany(): Promise<CompanyDetails> {
    return this.request("GET", "/v1/billing/company");
  }

  /** Saving changes the details on future invoices; a 400 carries
   * Stripe's tax ID message. */
  putCompany(c: CompanyDetails): Promise<CompanyDetails> {
    return this.request("PUT", "/v1/billing/company", c);
  }


  getInvoices(after?: string): Promise<InvoiceList> {
    const q = after ? `?limit=25&starting_after=${encodeURIComponent(after)}` : "?limit=25";
    return this.request("GET", `/v1/billing/invoices${q}`);
  }

  /** spec v6 F: the run's open payment for our sheet (opened, or the live
   * one reused; replace = Try again / Pay here instead). */
  payNowCheckout(conversionId: string, replace = false): Promise<CheckoutStart> {
    return this.request(
      "POST",
      `/v1/conversions/${encodeURIComponent(conversionId)}/pay-now`,
      { ui: "elements", ...(replace ? { replace: true } : {}) },
    );
  }

  /** BUX-20: pay a pay-first run with one tap on the saved default, for
   * the amount the button showed. 409 one_tap_unavailable,
   * amount_changed {amount_cents}, payment_in_progress, already_paid,
   * expired, not_payable. The answer is the run with the tap's fields
   * over it (read the tap with tapStateOf: older gateways put it in the
   * run's `state`). */
  payRunOneTap(conversionId: string, amountCents: number): Promise<Omit<Conversion, "state"> & OneTapAnswer> {
    return this.request("POST", `/v1/conversions/${encodeURIComponent(conversionId)}/pay-one-tap`, {
      amount_cents: amountCents,
    });
  }

  /** BUX-20: pay what the account owes with one tap (same answers). */
  settleOneTap(amountCents: number, settleId?: string): Promise<CheckoutStart & OneTapAnswer & { settled?: boolean }> {
    return this.request("POST", "/v1/billing/settle/one-tap", {
      amount_cents: amountCents,
      ...(settleId ? { settle_id: settleId } : {}),
    });
  }

  /** spec v6 F/C11: the payment for what the account owes (P2). */
  settleCheckout(): Promise<CheckoutStart> {
    return this.request("POST", "/v1/billing/settle", { ui: "elements" });
  }

  settleBilling(): Promise<BillingSettleResult> {
    return this.request("POST", "/v1/billing/settle", {});
  }

  /** Charge the pending balance (open batch) now instead of waiting for
   * the window or the cap. */
  payBillingNow(): Promise<BillingSettleResult> {
    return this.request("POST", "/v1/billing/pay-now", {});
  }

  // ------------------------------------------------------------ uploads

  /** sizeBytes picks the upload kind: over 100 MB (or always, in China
   * mode) the gateway opens a resumable session for chunked upload. */
  createUpload(
    filename: string,
    contentType: string,
    sizeBytes?: number,
  ): Promise<UploadTicket> {
    const chunked = wantsChunkedUpload(
      sizeBytes,
      this.opts.resumableUploads?.() ?? false,
    );
    return this.request("POST", "/v1/uploads", {
      filename,
      content_type: contentType,
      ...(chunked ? { resumable: true } : {}),
    });
  }

  /** Upload the file with its ticket (no auth header — the URL is the
   * auth): one PUT to the signed URL, or 8 MiB chunks with retries when
   * the ticket is resumable (lib/api/resumableUpload.ts). */
  async uploadFile(
    ticket: UploadTicket,
    file: Blob,
    onProgress?: (fraction: number) => void,
    opts: { resume?: boolean } = {},
  ): Promise<void> {
    if (ticket.resumable === true) {
      try {
        await uploadResumable(ticket.upload_url, file, onProgress, {
          transport: this.opts.chunkTransport,
          // a retry of a failed upload continues where the session stands
          resume: opts.resume,
          verifyComplete: async () => {
            const st = await this.uploadStatus(ticket.gcs_key);
            return st.exists && st.bytes === file.size;
          },
        });
      } catch (e) {
        if (e instanceof ResumableUploadError) {
          throw new GatewayError("upload_failed", e.message, e.status);
        }
        throw e;
      }
      return;
    }
    // XHR (not fetch) for upload progress events.
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", ticket.upload_url);
      for (const [k, v] of Object.entries(ticket.headers)) {
        xhr.setRequestHeader(k, v);
      }
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(
              new GatewayError(
                "upload_failed",
                this.t("errors.upload.failedStatus", { status: xhr.status }),
                xhr.status,
              ),
            );
      xhr.onerror = () =>
        reject(new GatewayError("upload_failed", this.t("errors.upload.network"), 0));
      xhr.send(file);
    });
  }

  /** Whether an upload landed, and its size (the browser can't read the
   * answer to a resumable upload's last chunk). */
  uploadStatus(
    gcsKey: string,
  ): Promise<{ gcs_key: string; exists: boolean; bytes: number }> {
    return this.request("POST", "/v1/uploads/status", { gcs_key: gcsKey });
  }

  /** Hard limits before an upload — the web reads the per-method source
   * caps (methods.<method>.max_source_duration_s, 0 = unlimited). */
  getLimits(): Promise<GatewayLimits> {
    return this.request("GET", "/v1/limits");
  }

  /** Public price list (no sign-in needed, S3D-18). */
  getPricing(): Promise<PublicPricing> {
    return this.request("GET", "/v1/pricing", undefined, undefined, {
      anonymous: true,
    });
  }

  // ----------------------------------------------------------- projects

  createProject(req: CreateProjectRequest): Promise<Project> {
    return this.request("POST", "/v1/projects", req);
  }

  /** Active (non-archived) projects by default; archived=true lists ONLY
   * the archived ones. */
  listProjects(archived = false): Promise<{ projects: Project[] }> {
    return this.request(
      "GET",
      archived ? "/v1/projects?archived=1" : "/v1/projects",
    );
  }

  getProject(id: string): Promise<Project> {
    return this.request("GET", `/v1/projects/${id}`);
  }

  updateProject(id: string, req: UpdateProjectRequest): Promise<Project> {
    return this.request("PATCH", `/v1/projects/${id}`, req);
  }

  /** Delete a project and its files from the account (S3D-24); refused
   * (409) while a run is active. */
  /** S3D-24: keep a project's files past their scheduled deletion. */
  keepProject(id: string): Promise<{ project_id: string; files_delete_at?: string | null }> {
    return this.request("POST", `/v1/projects/${encodeURIComponent(id)}/keep`, {});
  }

  deleteProject(id: string): Promise<{ project_id: string; deleted: boolean }> {
    return this.request("POST", `/v1/projects/${id}/delete`, {});
  }

  archiveProject(id: string): Promise<Project> {
    return this.request("DELETE", `/v1/projects/${id}`);
  }

  updateScenes(
    id: string,
    req: UpdateScenesRequest,
  ): Promise<{ scenes: Project["scenes"] }> {
    return this.request("PATCH", `/v1/projects/${id}/scenes`, req);
  }

  /** Register an uploaded depth video on the project (gcs_key from
   * createUpload + uploadFile). The gateway ffprobe-validates it as
   * frame-exact against the source; 400s carry the actionable reason.
   * Returns the updated project (depth_upload set). */
  setProjectDepthMap(
    id: string,
    req: { gcs_key: string; name?: string },
  ): Promise<Project> {
    return this.request("POST", `/v1/projects/${id}/depth-map`, req);
  }

  /** Forget the registered depth-map upload. */
  deleteProjectDepthMap(id: string): Promise<Project> {
    return this.request("DELETE", `/v1/projects/${id}/depth-map`);
  }

  /** Free standalone shot profiling (empty JSON body). Returns the full
   * project; poll GET /v1/projects/{id} while project.profile is running.
   * 409 conflict when a profile is already running. */
  profileProject(id: string): Promise<Project> {
    return this.request("POST", `/v1/projects/${id}/profile`, {});
  }

  /** Re-run the free analyze job on a FAILED project (transient failures
   * shouldn't force a re-upload). 409 unless analyze.state === "failed".
   * Returns the project with analyze back in "running" — resume polling. */
  retryAnalyze(id: string): Promise<Project> {
    return this.request("POST", `/v1/projects/${id}/analyze`, {});
  }

  quoteStep(
    id: string,
    req: StepConversionRequest,
  ): Promise<StepQuoteResponse> {
    return this.request("POST", `/v1/projects/${id}/quotes`, req);
  }

  /** idempotencyKey makes retries safe — reuse the SAME key when retrying
   * a create that may have reached the server. */
  createStepConversion(
    id: string,
    req: StepConversionRequest,
    idempotencyKey: string,
  ): Promise<Conversion> {
    return this.request("POST", `/v1/projects/${id}/conversions`, req, {
      "Idempotency-Key": idempotencyKey,
    });
  }

  // -------------------------------------------------------- live status

  /**
   * GET /v1/events (owner 2026-11-07): the signed-in user's status stream,
   * read with fetch so it carries the bearer token (refreshed on every
   * connect). Resumes after lastEventId. The body once it answered 200;
   * a GatewayError with the status otherwise (401: a bad token).
   */
  async openEvents(lastEventId: string | null, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    await this.opts.prepare?.();
    const token = await this.opts.getToken();
    const res = await this.send(`${this.base()}/v1/events`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${token}`,
        ...(lastEventId !== null ? { "Last-Event-ID": lastEventId } : {}),
      },
      cache: "no-store",
      signal,
    });
    if (!res.ok || res.body === null) {
      void res.body?.cancel().catch(() => {});
      throw new GatewayError("events_unavailable", this.t("errors.eventsUnavailable"), res.status);
    }
    return res.body;
  }

  // -------------------------------------------------------- conversions

  getConversion(id: string): Promise<Conversion> {
    return this.request("GET", `/v1/conversions/${id}`);
  }

  cancelConversion(id: string): Promise<Conversion> {
    return this.request("DELETE", `/v1/conversions/${id}`);
  }

  /** Tell us an overdue run looks stuck; the note is optional. */
  reportConversion(id: string, note: string): Promise<Conversion> {
    return this.request("POST", `/v1/conversions/${id}/report`, { note });
  }

  /** ADR 0137: the formats a finished run can still get (free). */
  async getRunFormats(id: string): Promise<RunFormats> {
    const r = await this.request<RunFormats>("GET", `/v1/runs/${encodeURIComponent(id)}/formats`);
    return { ...r, available: r.available ?? [], have: r.have ?? [], pending: r.pending ?? [] };
  }

  /** ADR 0137: make another format; 202 {job_id, status, format}. 409
   * format_exists | format_in_progress | format_unavailable {reason}; 429
   * rate_limited; 502/503 repack_unavailable. */
  requestRunFormat(id: string, format: Format): Promise<RunFormatJob & { format: Format }> {
    return this.request("POST", `/v1/runs/${encodeURIComponent(id)}/formats`, { format });
  }

  async getDownloads(id: string): Promise<Downloads> {
    return normalizeDownloads(
      await this.request<unknown>("GET", `/v1/conversions/${id}/downloads`),
    );
  }
}
