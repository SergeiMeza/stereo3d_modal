import type {
  AccountActionBody,
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
export type SessionProblem = "invalid_token" | "no_access" | "mfa_required";

export interface AdminApiOptions {
  baseUrl: string;
  /** Firebase ID token; `force` refreshes it (after a 401 or a re-auth). */
  getToken: (force?: boolean) => Promise<string | null>;
  onSessionProblem?: (problem: SessionProblem) => void;
  fetchImpl?: typeof fetch;
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

  constructor(opts: AdminApiOptions) {
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
      if (err.code === "no_access" || err.code === "mfa_required") {
        this.onSessionProblem?.(err.code);
      }
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

  getAccount(uid: string): Promise<AccountPage> {
    return this.json("GET", `/v1/admin/accounts/${encodeURIComponent(uid)}`);
  }

  accountAction(uid: string, body: AccountActionBody): Promise<AccountPage> {
    return this.json(
      "POST",
      `/v1/admin/accounts/${encodeURIComponent(uid)}/actions`,
      body,
    );
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
        : null;
  return new ApiError(res.status, code, message, details);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
