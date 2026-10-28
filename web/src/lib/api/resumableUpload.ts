/**
 * Chunked upload to a resumable upload session (China mode, lib/region.ts).
 *
 * The gateway opens the session (POST /v1/uploads {resumable: true}) and
 * answers its URL; requests to that host carry at most 25 MB, so the file
 * goes up in 8 MiB chunks (a multiple of 256 KiB, as the session requires):
 *
 *   PUT <session>  Content-Range: bytes a-b/*      → 308, Range: bytes=0-b
 *   PUT <session>  Content-Range: bytes a-b/total  → 200/201 (last chunk)
 *
 * A failed chunk is retried a few times. Before each retry the session is
 * asked how much it has (an empty PUT whose Content-Range is "bytes", a
 * star, "/total": 308 with Range, or 200/201 when it already has
 * everything) and the upload resumes from there, so nothing is skipped.
 *
 * Storage sends the answer that completes the upload (and any status check
 * after it) without CORS headers, so in a browser the last chunk always
 * looks like a network failure. Whenever a request fails that way after the
 * last chunk went out, verifyComplete (the gateway's POST
 * /v1/uploads/status) says whether the object is in fact complete.
 */

export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
/** Tries per chunk (first try included) before the upload fails. */
export const MAX_CHUNK_ATTEMPTS = 4;

export interface ChunkAnswer {
  status: number; // 0: network failure
  /** The Range response header ("bytes=0-8388607"), if any. */
  range: string | null;
}

/** Sends one PUT; onProgress gets the bytes of this body sent so far. */
export type ChunkTransport = (
  url: string,
  body: Blob | null,
  headers: Record<string, string>,
  onProgress?: (loaded: number) => void,
) => Promise<ChunkAnswer>;

export class ResumableUploadError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ResumableUploadError";
  }
}

export interface ResumableUploadOptions {
  chunkBytes?: number;
  maxAttempts?: number;
  transport?: ChunkTransport;
  /** Wait before retry n (1-based); tests pass () => Promise.resolve(). */
  backoff?: (attempt: number) => Promise<void>;
  /** Whether the object is complete, asked when a request fails without
   * an answer after the last chunk went out (see above). */
  verifyComplete?: () => Promise<boolean>;
}

const done = (status: number) => status === 200 || status === 201;
const INCOMPLETE = 308;

/** The session's committed byte count from a 308's Range header. */
export function committedBytes(range: string | null): number {
  if (!range) return 0;
  const m = /bytes=(\d+)-(\d+)/.exec(range);
  return m ? Number(m[2]) + 1 : 0;
}

/** Network failures, timeouts, throttling and server errors are worth another try. */
function retryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function defaultBackoff(attempt: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** (attempt - 1))));
}

/** XHR (not fetch) so each chunk reports upload progress. */
export const xhrTransport: ChunkTransport = (url, body, headers, onProgress) =>
  new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded);
      };
    }
    xhr.onload = () =>
      resolve({ status: xhr.status, range: xhr.getResponseHeader("Range") });
    xhr.onerror = () => resolve({ status: 0, range: null });
    xhr.ontimeout = () => resolve({ status: 0, range: null });
    xhr.send(body);
  });

export async function uploadResumable(
  sessionUrl: string,
  file: Blob,
  onProgress?: (fraction: number) => void,
  opts: ResumableUploadOptions = {},
): Promise<void> {
  const chunk = opts.chunkBytes ?? UPLOAD_CHUNK_BYTES;
  const maxAttempts = opts.maxAttempts ?? MAX_CHUNK_ATTEMPTS;
  const send = opts.transport ?? xhrTransport;
  const backoff = opts.backoff ?? defaultBackoff;
  const total = file.size;
  const report = (sent: number) =>
    onProgress?.(total > 0 ? Math.min(1, sent / total) : 1);

  let lastSent = false; // the chunk carrying the total went out at least once
  // A request without an answer after the last chunk may be a completed
  // upload whose answer the browser hid: ask the gateway.
  const completedUnseen = async (a: ChunkAnswer): Promise<boolean> => {
    if (a.status !== 0 || !lastSent || !opts.verifyComplete) return false;
    try {
      return await opts.verifyComplete();
    } catch {
      return false;
    }
  };

  if (total === 0) {
    lastSent = true;
    const a = await send(sessionUrl, null, { "Content-Range": "bytes */0" });
    if (!done(a.status) && !(await completedUnseen(a))) {
      throw new ResumableUploadError(`upload failed (${a.status})`, a.status);
    }
    report(0);
    return;
  }

  let offset = 0;
  let failures = 0;
  while (offset < total) {
    const end = Math.min(offset + chunk, total);
    const last = end === total;
    const start = offset;
    if (last) lastSent = true;
    const a = await send(
      sessionUrl,
      file.slice(start, end),
      { "Content-Range": `bytes ${start}-${end - 1}/${last ? total : "*"}` },
      (loaded) => report(start + loaded),
    );
    if (done(a.status) || (await completedUnseen(a))) break;
    if (a.status === INCOMPLETE) {
      offset = committedBytes(a.range);
      if (offset > start) {
        failures = 0;
        report(offset);
        continue;
      }
      // The session took nothing: count it as a failure below.
    } else if (!retryable(a.status)) {
      throw new ResumableUploadError(`upload failed (${a.status})`, a.status);
    }

    // Retry: wait, then ask the session where it stands.
    failures++;
    if (failures >= maxAttempts) {
      throw new ResumableUploadError(
        a.status === 0 ? "upload network error" : `upload failed (${a.status})`,
        a.status,
      );
    }
    await backoff(failures);
    const q = await send(sessionUrl, null, {
      "Content-Range": `bytes */${total}`,
    });
    if (done(q.status) || (await completedUnseen(q))) break;
    if (q.status === INCOMPLETE) {
      offset = committedBytes(q.range);
      report(offset);
    } else if (!retryable(q.status)) {
      throw new ResumableUploadError(`upload failed (${q.status})`, q.status);
    }
    // A failed status check keeps the old offset; the next PUT's answer
    // (or the next check) corrects it.
  }
  report(total);
}
