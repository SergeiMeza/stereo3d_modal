import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

import { AdminSession } from "./adminSession";
import type {
  AccountActionBody,
  Passkey,
  BusinessFunnel,
  AccountPage,
  CaseActionBody,
  CasePage,
  CasesResponse,
  DisputeSummary,
  MailPreviewsResponse,
  OnboardingHeadsets,
  PlansSurfaces,
  FeedbackList,
  Grant,
  GrantBody,
  RevokeResult,
  OpenCaseBody,
  PlanMovePreview,
  AccountHit,
  FeedbackSeen,
  OpenEfw,
  AdminDeletion,
  AdminGrant,
  RunLookup,
  CampaignSummary,
  AllCreditGrants,
  CreditGrant,
  CreditGrantBody,
  CreditGrantPreview,
  CreditGrantResult,
  CreditGrantRevokeResult,
  PasskeyAdoption,
  PolicyResponse,
  Tab,
} from "./types";

/** A gateway error: `{success:false, error, message, details}`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | null;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Codes that end or block the whole session rather than one request. */
export type SessionProblem = "invalid_token" | "no_access";

/** The gateway's answer when the passkey session is missing or over: the
 * token is dropped and the console asks for the passkey again.
 * session_expired: past exp; invalid_session: bad signature, another
 * account's, or ended by a break-glass reset (which also deletes the
 * passkeys, so the step then offers "Set up a passkey"). */
const SESSION_CODES = new Set(["session_required", "session_expired", "invalid_session"]);

/** Passkey routes (ADR 0135), as the gateway serves them (test rev 00110). */
export const PASSKEY_ROUTES = {
  sessionOptions: "/v1/admin/session/options",
  sessionVerify: "/v1/admin/session/verify",
  registerOptions: "/v1/admin/passkeys/register/options",
  registerVerify: "/v1/admin/passkeys/register/verify",
  list: "/v1/admin/passkeys",
  remove: (id: string) => `/v1/admin/passkeys/${encodeURIComponent(id)}`,
};

export type PasskeyPurpose = "sign_in" | "reassert";

/** The gateway sends `{options: {publicKey: …}, expires_at}`; a wrapped
 * `{options: …}`, a bare `{publicKey: …}` or the bare options also work.
 * What @simplewebauthn takes as optionsJSON is the publicKey part. */
export function optionsOf<T extends object>(r: unknown): T {
  let o = r as Record<string, unknown> | null;
  if (o && typeof o.options === "object" && o.options) o = o.options as Record<string, unknown>;
  if (o && typeof o.publicKey === "object" && o.publicKey) o = o.publicKey as Record<string, unknown>;
  return o as T;
}

export interface AdminApiOptions {
  baseUrl: string;
  /** Firebase ID token; `force` refreshes it (after a 401 or a re-auth). */
  getToken: (force?: boolean) => Promise<string | null>;
  onSessionProblem?: (problem: SessionProblem) => void;
  fetchImpl?: typeof fetch;
  /** The passkey session token (ADR 0135); a new sessionStorage-backed one by default. */
  session?: AdminSession;
}

export interface CaseListQuery {
  tab: Tab;
  type?: string;
  reason?: string;
  mode?: string;
  cap?: "" | "over" | "under";
  q?: string;
}

export class AdminApi {
  private readonly baseUrl: string;
  private readonly getToken: AdminApiOptions["getToken"];
  private readonly onSessionProblem?: AdminApiOptions["onSessionProblem"];
  private readonly fetchImpl: typeof fetch;
  /** X-Admin-Session, sent on every admin call when there is one. */
  readonly session: AdminSession;

  constructor(opts: AdminApiOptions) {
    this.session = opts.session ?? new AdminSession();
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.getToken = opts.getToken;
    this.onSessionProblem = opts.onSessionProblem;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  private async send(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: unknown,
    force: boolean,
  ): Promise<Response> {
    const token = await this.getToken(force);
    if (!token) {
      throw new ApiError(401, "invalid_token", "You're signed out.");
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/csv",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const session = this.session.get();
    if (session) headers["X-Admin-Session"] = session;
    return this.fetchImpl(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  }

  private async raw(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.send(method, path, body, false);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(0, "network", "Couldn't reach the gateway.");
    }
    if (res.status === 401) {
      const err = await toApiError(res);
      // No passkey session, or it's over (ADR 0135): drop the token and the
      // passkey step comes back, whatever `methods` the gateway lists.
      if (SESSION_CODES.has(err.code)) this.session.clear();
      if (err.code !== "invalid_token") throw err;
      // A token can expire between the SDK's refreshes: retry once with a
      // fresh one before calling the session over.
      try {
        res = await this.send(method, path, body, true);
      } catch {
        this.onSessionProblem?.("invalid_token");
        throw err;
      }
      if (res.status === 401) {
        const again = await toApiError(res);
        if (again.code === "invalid_token") {
          this.onSessionProblem?.("invalid_token");
        }
        throw again;
      }
    }
    if (!res.ok) {
      const err = await toApiError(res);
      if (err.code === "no_access") this.onSessionProblem?.("no_access");
      throw err;
    }
    return res;
  }

  private async json<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.raw(method, path, body);
    return (await res.json()) as T;
  }

  listCases(q: CaseListQuery): Promise<CasesResponse> {
    const p = new URLSearchParams({ tab: q.tab });
    for (const k of ["type", "reason", "mode", "cap", "q"] as const) {
      const v = q[k]?.trim();
      if (v) p.set(k, v);
    }
    return this.json("GET", `/v1/admin/cases?${p}`);
  }

  getCase(id: string): Promise<CasePage> {
    return this.json("GET", `/v1/admin/cases/${encodeURIComponent(id)}`);
  }

  caseAction(id: string, body: CaseActionBody): Promise<CasePage> {
    return this.json(
      "POST",
      `/v1/admin/cases/${encodeURIComponent(id)}/actions`,
      body,
    );
  }

  openCase(body: OpenCaseBody): Promise<{ cases: CasePage[] | null }> {
    return this.json("POST", "/v1/admin/cases", body);
  }

  /** RP-05: what moving the case's plan to `to` would do, and what blocks it. */
  planMovePreview(caseId: string, to: string): Promise<PlanMovePreview> {
    const q = new URLSearchParams({ to });
    return this.json("GET", `/v1/admin/cases/${encodeURIComponent(caseId)}/plan-move/preview?${q}`);
  }

  /** Grant Pro (gateway 00106): an account's grants. */
  listGrants(uid: string): Promise<{ grants: Grant[] | null }> {
    return this.json("GET", `/v1/admin/accounts/${encodeURIComponent(uid)}/grants`);
  }

  /** 201 {grant}; 401 reauth_required; 502 grant_failed (details.grant);
   * 503 rc_unavailable. */
  async createGrant(uid: string, body: GrantBody): Promise<Grant> {
    const r = await this.json<{ grant: Grant }>("POST", `/v1/admin/accounts/${encodeURIComponent(uid)}/grants`, body);
    return r.grant;
  }

  /** 200, or 202 when some regrants wait for tonight's retry; 409
   * grant_not_active. */
  async revokeGrant(uid: string, id: string, reason: string): Promise<RevokeResult & { partial: boolean }> {
    const res = await this.raw(
      "DELETE",
      `/v1/admin/accounts/${encodeURIComponent(uid)}/grants/${encodeURIComponent(id)}`,
      { reason },
    );
    const body = (await res.json()) as RevokeResult;
    return { ...body, partial: res.status === 202 };
  }

  /** Grant credit (gateway 00178): what a grant would do; nothing granted. */
  creditGrantPreview(uid: string, body: Pick<CreditGrantBody, "amount_cents" | "reason" | "expires_days">): Promise<CreditGrantPreview> {
    return this.json("POST", `/v1/admin/accounts/${encodeURIComponent(uid)}/credit-grants/preview`, body);
  }

  /** Fresh sign-in; once per request_id. 409 over_cap without
   * confirm_over_cap; 409 request_id_reused. */
  createCreditGrant(uid: string, body: CreditGrantBody): Promise<CreditGrantResult> {
    return this.json("POST", `/v1/admin/accounts/${encodeURIComponent(uid)}/credit-grants`, body);
  }

  async listCreditGrants(uid: string): Promise<CreditGrant[]> {
    const r = await this.json<{ grants: CreditGrant[] | null }>("GET", `/v1/admin/accounts/${encodeURIComponent(uid)}/credit-grants`);
    return r.grants ?? [];
  }

  /** Fresh sign-in: removes only what's left of the grant. */
  revokeCreditGrant(uid: string, id: string): Promise<CreditGrantRevokeResult> {
    return this.json(
      "POST",
      `/v1/admin/accounts/${encodeURIComponent(uid)}/credit-grants/${encodeURIComponent(id)}/revoke`,
      {},
    );
  }

  /** Every credit grant (newest 500) with monthly totals. */
  async allCreditGrants(): Promise<AllCreditGrants> {
    const r = await this.json<AllCreditGrants>("GET", "/v1/admin/credit-grants");
    return { ...r, grants: r.grants ?? [], months: r.months ?? [] };
  }

  /** One account; `runs` pages its runs list (gateway rev 00114). */
  /** POST /v1/admin/events/ticket (owner 2026-11-07): the console stream's
   * ticket, two minutes, under the passkey session. */
  eventsTicket(): Promise<{ ticket: string; expires_at: string; url: string }> {
    return this.json("POST", "/v1/admin/events/ticket", {});
  }

  /** A gateway path as a full address (the stream's EventSource). */
  urlOf(path: string): string {
    return this.baseUrl + path;
  }

  getAccount(uid: string, runs?: { limit?: number; before?: string }): Promise<AccountPage> {
    const q = new URLSearchParams();
    if (runs?.limit) q.set("runs_limit", String(runs.limit));
    if (runs?.before) q.set("runs_before", runs.before);
    const qs = q.toString();
    return this.json("GET", `/v1/admin/accounts/${encodeURIComponent(uid)}${qs ? `?${qs}` : ""}`);
  }

  accountAction(uid: string, body: AccountActionBody): Promise<AccountPage> {
    return this.json(
      "POST",
      `/v1/admin/accounts/${encodeURIComponent(uid)}/actions`,
      body,
    );
  }

  /** gateway 00166: Cancel deletion / Process now (the latter needs a fresh
   * sign-in). The account page after it, or only {deletion} for an account
   * without a billing record. */
  deletionAction(
    uid: string,
    action: "cancel_deletion" | "process_deletion_now",
  ): Promise<AccountPage | { deletion: AdminDeletion | null }> {
    return this.json("POST", `/v1/admin/accounts/${encodeURIComponent(uid)}/actions`, { action });
  }

  /** gateway 00166: the 48-hour deletions in one state, soonest first. */
  async listDeletions(state: AdminDeletion["state"]): Promise<AdminDeletion[]> {
    const r = await this.json<{ deletions: AdminDeletion[] | null }>("GET", `/v1/admin/deletions?state=${encodeURIComponent(state)}`);
    return r.deletions ?? [];
  }

  /** Feedback from the web and the apps, read only (owner 2026-11-04). */
  feedback(days: number, platform: string): Promise<FeedbackList> {
    const q = new URLSearchParams({ days: String(days), ...(platform ? { platform } : {}) });
    return this.json("GET", `/v1/admin/feedback?${q.toString()}`);
  }

  plansSurfaces(days: number): Promise<PlansSurfaces> {
    return this.json("GET", `/v1/admin/plans/surfaces?days=${days}`);
  }

  /** Business/Studio setup steps and answers (main use, team size). */
  businessFunnel(days: number): Promise<BusinessFunnel> {
    return this.json("GET", `/v1/admin/onboarding/business_funnel?days=${days}`);
  }

  onboardingHeadsets(days: number): Promise<OnboardingHeadsets> {
    return this.json("GET", `/v1/admin/onboarding/headsets?days=${days}`);
  }

  disputes(months: number): Promise<DisputeSummary> {
    return this.json("GET", `/v1/admin/disputes/summary?months=${months}`);
  }

  async disputesCsv(months: number): Promise<Blob> {
    const res = await this.raw(
      "GET",
      `/v1/admin/disputes/summary?months=${months}&format=csv`,
    );
    return res.blob();
  }

  /** Passkey sign-in or re-assertion options; 409 no_passkey when the
   * account has none yet. */
  async sessionOptions(purpose: PasskeyPurpose): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const r = await this.json<{ registered?: boolean }>("POST", PASSKEY_ROUTES.sessionOptions, { purpose });
    if (r && r.registered === false) throw new ApiError(409, "no_passkey", "No passkey on this account yet.");
    return optionsOf<PublicKeyCredentialRequestOptionsJSON>(r);
  }

  /** Verifies the assertion; the session token goes into `session`. */
  async sessionVerify(response: AuthenticationResponseJSON, purpose: PasskeyPurpose): Promise<void> {
    const r = await this.json<{ session?: string; token?: string; expires_at?: string; last_assertion_at?: string }>(
      "POST",
      PASSKEY_ROUTES.sessionVerify,
      { purpose, response },
    );
    const token = r.session ?? r.token;
    if (!token) throw new ApiError(502, "no_session", "The gateway didn't start a session. Try again.");
    this.session.set(token, { expires_at: r.expires_at, last_assertion_at: r.last_assertion_at });
  }

  async registerOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return optionsOf<PublicKeyCredentialCreationOptionsJSON>(await this.json("POST", PASSKEY_ROUTES.registerOptions, {}));
  }

  async registerVerify(response: RegistrationResponseJSON, name: string): Promise<Passkey | null> {
    const r = await this.json<{ passkey?: Passkey }>("POST", PASSKEY_ROUTES.registerVerify, { response, name });
    return r.passkey ?? null;
  }

  async listPasskeys(): Promise<Passkey[]> {
    const r = await this.json<{ passkeys?: Passkey[] | null }>("GET", PASSKEY_ROUTES.list);
    return r.passkeys ?? [];
  }

  /** 409 last_passkey: the last one can't go. */
  async removePasskey(id: string): Promise<void> {
    await this.raw("DELETE", PASSKEY_ROUTES.remove(id));
  }

  /** ⌘K account search (gateway rev 00114): q is 2–320 characters. */
  async searchAccounts(q: string): Promise<AccountHit[]> {
    const r = await this.json<{ accounts: AccountHit[] | null }>("GET", `/v1/admin/accounts?q=${encodeURIComponent(q)}`);
    return r.accounts ?? [];
  }

  /** One run by id (gateway rev 00114); null on 404 run_not_found. */
  async getRun(id: string): Promise<RunLookup | null> {
    try {
      const r = await this.json<{ run: RunLookup }>("GET", `/v1/admin/runs/${encodeURIComponent(id)}`);
      return r.run ?? null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  /** Every admin grant, active first (gateway rev 00114). */
  async allGrants(): Promise<AdminGrant[]> {
    const r = await this.json<{ grants: AdminGrant[] | null }>("GET", "/v1/admin/grants");
    return r.grants ?? [];
  }

  /** Open early fraud warnings (gateway rev 00114). */
  async openEfws(): Promise<OpenEfw[]> {
    const r = await this.json<{ efws: OpenEfw[] | null }>("GET", "/v1/admin/efws");
    return r.efws ?? [];
  }

  /** How far the console has read the feedback (gateway rev 00114). */
  feedbackSeen(): Promise<FeedbackSeen> {
    return this.json("GET", "/v1/admin/feedback/seen");
  }

  setFeedbackSeen(seenAt: string): Promise<FeedbackSeen> {
    return this.json("POST", "/v1/admin/feedback/seen", { seen_at: seenAt });
  }

  /** The launch offer's runs and money (owner 2026-11-07, gateway 00175). */
  campaign(): Promise<CampaignSummary> {
    return this.json("GET", "/v1/admin/campaign");
  }

  /** Customer passkey adoption (gateway rev 00113). */
  passkeyAdoption(): Promise<PasskeyAdoption> {
    return this.json("GET", "/v1/admin/passkey-adoption");
  }

  policy(): Promise<PolicyResponse> {
    return this.json("GET", "/v1/admin/policy");
  }

  mailPreviews(): Promise<MailPreviewsResponse> {
    return this.json("GET", "/v1/admin/mail-previews");
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: { error?: unknown; message?: unknown; details?: unknown } = {};
  try {
    body = await res.json();
  } catch {
    // Not JSON (a proxy page, an empty body): keep the status only.
  }
  const code = typeof body.error === "string" ? body.error : `http_${res.status}`;
  const message =
    typeof body.message === "string" ? body.message : `HTTP ${res.status}`;
  const extra = body as Record<string, unknown>;
  const details =
    body.details && typeof body.details === "object"
      ? (body.details as Record<string, unknown>)
      : // 502 grant_failed carries the failed grant beside the message
        extra.grant && typeof extra.grant === "object"
        ? { grant: extra.grant }
        : // 401 reauth_required names the method: {method: "passkey"}
          typeof extra.method === "string"
          ? { method: extra.method }
          : null;
  return new ApiError(res.status, code, message, details);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
