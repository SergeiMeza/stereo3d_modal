/**
 * Typed gateway client. All requests carry the Firebase ID token; all
 * errors surface as GatewayError with the machine code + the user-safe
 * message (which always contains the conversion/project id for support).
 */

import type {
  APIErrorBody,
  Conversion,
  CreateProjectRequest,
  Downloads,
  Project,
  StepConversionRequest,
  StepQuoteResponse,
  UpdateProjectRequest,
  UpdateScenesRequest,
  UploadTicket,
} from "./types";

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
  baseUrl: string; // e.g. https://stereo3d-gateway-test-....run.app
  getToken: TokenProvider;
  fetchFn?: typeof fetch; // injectable for tests
}

export class GatewayClient {
  constructor(private readonly opts: ClientOptions) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const f = this.opts.fetchFn ?? fetch;
    const token = await this.opts.getToken();
    const res = await f(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
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
      throw new GatewayError(
        parsed?.error ?? "server_error",
        parsed?.message ?? `request failed (${res.status})`,
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

  // ------------------------------------------------------------ uploads

  createUpload(filename: string, contentType: string): Promise<UploadTicket> {
    return this.request("POST", "/v1/uploads", {
      filename,
      content_type: contentType,
    });
  }

  /** PUT the file to the signed URL (no auth header — the URL is the auth). */
  async uploadFile(
    ticket: UploadTicket,
    file: Blob,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
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
          : reject(new GatewayError("upload_failed", `upload failed (${xhr.status})`, xhr.status));
      xhr.onerror = () => reject(new GatewayError("upload_failed", "upload network error", 0));
      xhr.send(file);
    });
  }

  // ----------------------------------------------------------- projects

  createProject(req: CreateProjectRequest): Promise<Project> {
    return this.request("POST", "/v1/projects", req);
  }

  /** Active (non-archived) projects by default; archived=true lists ONLY
   * the archived ones. */
  listProjects(archived = false): Promise<{ projects: Project[] }> {
    return this.request("GET", archived ? "/v1/projects?archived=1" : "/v1/projects");
  }

  getProject(id: string): Promise<Project> {
    return this.request("GET", `/v1/projects/${id}`);
  }

  updateProject(id: string, req: UpdateProjectRequest): Promise<Project> {
    return this.request("PATCH", `/v1/projects/${id}`, req);
  }

  archiveProject(id: string): Promise<Project> {
    return this.request("DELETE", `/v1/projects/${id}`);
  }

  updateScenes(id: string, req: UpdateScenesRequest): Promise<{ scenes: Project["scenes"] }> {
    return this.request("PATCH", `/v1/projects/${id}/scenes`, req);
  }

  quoteStep(id: string, req: StepConversionRequest): Promise<StepQuoteResponse> {
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

  getDownloads(id: string): Promise<Downloads> {
    return this.request("GET", `/v1/conversions/${id}/downloads`);
  }
}
