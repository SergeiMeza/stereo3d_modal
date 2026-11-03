/**
 * Typed gateway client. All requests carry the Firebase ID token; all
 * errors surface as GatewayError with the machine code + the user-safe
 * message (which always contains the conversion/project id for support).
 */

import type {
  CheckoutStart,
  APIErrorBody,
  BillingSettleResult,
  BillingSetupTicket,
  BillingHistory,
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
  StepConversionRequest,
  StepQuoteResponse,
  UpdateProjectRequest,
  UpdateScenesRequest,
  UploadTicket,
} from "./types";
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
export const UPLOAD_AGAIN = "Upload the video again to make new 3D";
export const FILES_DELETED_MESSAGE = `This project's files have been deleted. ${UPLOAD_AGAIN}.`;

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
}

export class GatewayClient {
  constructor(private readonly opts: ClientOptions) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    opts: { anonymous?: boolean } = {},
  ): Promise<T> {
    const f = this.opts.fetchFn ?? fetch;
    const token = opts.anonymous ? null : await this.opts.getToken();
    const base =
      typeof this.opts.baseUrl === "function"
        ? this.opts.baseUrl()
        : this.opts.baseUrl;
    const res = await f(`${base}${path}`, {
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
          ? FILES_DELETED_MESSAGE
          : (parsed?.message ?? `request failed (${res.status})`),
        res.status,
        parsed?.details,
      );
    }
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
   * client_secret, publishable_key) or 409 active_runs. */
  deleteAccount(): Promise<{ deleted: boolean }> {
    return this.request("POST", "/v1/account/delete", {});
  }

  // ------------------------------------------------------------- billing

  /** Pay-as-you-go billing status — also ensures the billing profile and
   * heals the default payment method after onboarding / a portal edit. */
  getBilling(): Promise<BillingStatus> {
    return this.request("GET", "/v1/billing");
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
  getBillingHistory(): Promise<BillingHistory> {
    return this.request("GET", "/v1/billing/history");
  }

  /** SetupIntent material for the onboarding card capture. */
  createBillingSetupIntent(): Promise<BillingSetupTicket> {
    return this.request("POST", "/v1/billing/setup-intent", {});
  }

  /** Retry the outstanding automatic charges on the current default card. */
  /** spec v6 F: the run's open payment for our sheet (opened, or the live
   * one reused; replace = Try again / Pay here instead). */
  payNowCheckout(conversionId: string, replace = false): Promise<CheckoutStart> {
    return this.request(
      "POST",
      `/v1/conversions/${encodeURIComponent(conversionId)}/pay-now`,
      { ui: "elements", ...(replace ? { replace: true } : {}) },
    );
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
                `upload failed (${xhr.status})`,
                xhr.status,
              ),
            );
      xhr.onerror = () =>
        reject(new GatewayError("upload_failed", "upload network error", 0));
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

  async getDownloads(id: string): Promise<Downloads> {
    return normalizeDownloads(
      await this.request<unknown>("GET", `/v1/conversions/${id}/downloads`),
    );
  }
}
