/**
 * Chunked upload to a resumable session: chunk boundaries and headers,
 * progress, retry with resume from the session's committed offset (a lost
 * chunk, a lost answer), and giving up.
 */

import { describe, expect, it } from "vitest";

import {
  committedBytes,
  ResumableUploadError,
  UPLOAD_CHUNK_BYTES,
  uploadResumable,
  type ChunkAnswer,
  type ChunkTransport,
} from "./resumableUpload";

const URL = "https://cn.media.example/bucket/stereo3d/test/k.mp4?upload_id=x";
const noWait = () => Promise.resolve();

function bytes(n: number): Uint8Array<ArrayBuffer> {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * 31 + 7) % 251;
  return a;
}

interface Call {
  range: string;
  size: number;
}

/** A storage session in memory. fail(i) lets a test break call i:
 * "drop" fails it before the session takes the bytes, "lose" takes them
 * and loses the answer, a number answers that status. */
function fakeSession(
  fail: (i: number, call: Call) => "drop" | "lose" | number | null = () => null,
  /** Answer 200s as a network failure, as a browser sees storage's
   * completion answer (no CORS headers). */
  hideCompletion = false,
) {
  const parts: Uint8Array[] = [];
  const received = { length: 0 };
  let total: number | null = null;
  const calls: Call[] = [];
  const range = () =>
    received.length > 0 ? `bytes=0-${received.length - 1}` : null;
  const transport: ChunkTransport = async (url, body, headers, onProgress) => {
    expect(url).toBe(URL);
    const cr = headers["Content-Range"];
    const call = { range: cr, size: body?.size ?? 0 };
    calls.push(call);
    const verdict = fail(calls.length - 1, call);
    if (typeof verdict === "number") return { status: verdict, range: null };
    if (verdict === "drop") return { status: 0, range: null };
    const check = /^bytes \*\/(\d+)$/.exec(cr);
    if (check) {
      if (total !== null && received.length === total) {
        return { status: 200, range: null };
      }
      return { status: 308, range: range() };
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(cr);
    if (!m || body === null) return { status: 400, range: null };
    const start = Number(m[1]);
    if (start !== received.length) return { status: 308, range: range() };
    const chunk = new Uint8Array(await body.arrayBuffer());
    onProgress?.(chunk.length / 2);
    onProgress?.(chunk.length);
    parts.push(chunk);
    received.length += chunk.length;
    if (m[3] !== "*") total = Number(m[3]);
    const answer: ChunkAnswer =
      total !== null && received.length === total
        ? { status: 200, range: null }
        : { status: 308, range: range() };
    if (verdict === "lose") return { status: 0, range: null };
    return answer;
  };
  const hidden: ChunkTransport = async (...args) => {
    const a = await transport(...args);
    return hideCompletion && a.status === 200 ? { status: 0, range: null } : a;
  };
  const bytesReceived = () => {
    const out = new Uint8Array(received.length);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const complete = async () => total !== null && received.length === total;
  return { transport: hidden, calls, received, bytesReceived, complete };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe("committedBytes", () => {
  it("reads the Range header of a 308", () => {
    expect(committedBytes("bytes=0-8388607")).toBe(8388608);
    expect(committedBytes(null)).toBe(0);
    expect(committedBytes("nonsense")).toBe(0);
  });
});

describe("uploadResumable", () => {
  it("sends 8 MiB chunks, the last one with the total size", async () => {
    const size = 2 * UPLOAD_CHUNK_BYTES + 1234;
    const data = bytes(size);
    const s = fakeSession();
    const progress: number[] = [];
    await uploadResumable(URL, new Blob([data]), (f) => progress.push(f), {
      transport: s.transport,
    });
    const M = UPLOAD_CHUNK_BYTES;
    expect(s.calls).toEqual([
      { range: `bytes 0-${M - 1}/*`, size: M },
      { range: `bytes ${M}-${2 * M - 1}/*`, size: M },
      { range: `bytes ${2 * M}-${size - 1}/${size}`, size: 1234 },
    ]);
    expect(s.received.length).toBe(size);
    expect(sameBytes(s.bytesReceived(), data)).toBe(true);
    expect(progress.at(-1)).toBe(1);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it("resumes from the committed offset after a failed chunk", async () => {
    const data = bytes(10_000);
    // The second chunk fails on the network before the session gets it.
    const s = fakeSession((i) => (i === 1 ? "drop" : null));
    await uploadResumable(URL, new Blob([data]), undefined, {
      transport: s.transport,
      chunkBytes: 4096,
      backoff: noWait,
    });
    expect(s.calls.map((c) => c.range)).toEqual([
      "bytes 0-4095/*",
      "bytes 4096-8191/*", // dropped
      "bytes */10000", // where does the session stand?
      "bytes 4096-8191/*", // resent from the committed offset
      "bytes 8192-9999/10000",
    ]);
    expect(sameBytes(s.bytesReceived(), data)).toBe(true);
  });

  it("doesn't resend a chunk the session took when only its answer was lost", async () => {
    const data = bytes(10_000);
    const s = fakeSession((i) => (i === 1 ? "lose" : null));
    await uploadResumable(URL, new Blob([data]), undefined, {
      transport: s.transport,
      chunkBytes: 4096,
      backoff: noWait,
    });
    expect(s.calls.map((c) => c.range)).toEqual([
      "bytes 0-4095/*",
      "bytes 4096-8191/*", // taken, answer lost
      "bytes */10000",
      "bytes 8192-9999/10000",
    ]);
    expect(sameBytes(s.bytesReceived(), data)).toBe(true);
  });

  it("finishes when the status check says the session is complete", async () => {
    const data = bytes(5000);
    const s = fakeSession((i) => (i === 1 ? "lose" : null));
    await uploadResumable(URL, new Blob([data]), undefined, {
      transport: s.transport,
      chunkBytes: 4096,
      backoff: noWait,
    });
    expect(s.calls.map((c) => c.range)).toEqual([
      "bytes 0-4095/*",
      "bytes 4096-4999/5000", // taken, answer lost
      "bytes */5000", // 200: done
    ]);
  });

  it("asks the gateway when the completing answer is hidden from the browser", async () => {
    const data = bytes(10_000);
    const s = fakeSession(() => null, true);
    let asked = 0;
    await uploadResumable(URL, new Blob([data]), undefined, {
      transport: s.transport,
      chunkBytes: 4096,
      backoff: noWait,
      verifyComplete: async () => {
        asked++;
        return s.complete();
      },
    });
    expect(asked).toBe(1);
    expect(s.calls.map((c) => c.range)).toEqual([
      "bytes 0-4095/*",
      "bytes 4096-8191/*",
      "bytes 8192-9999/10000", // completed; the browser saw a failure
    ]);
    expect(sameBytes(s.bytesReceived(), data)).toBe(true);
  });

  it("resends a last chunk that really failed, then confirms with the gateway", async () => {
    const data = bytes(10_000);
    const s = fakeSession((i) => (i === 2 ? "drop" : null), true);
    let asked = 0;
    await uploadResumable(URL, new Blob([data]), undefined, {
      transport: s.transport,
      chunkBytes: 4096,
      backoff: noWait,
      verifyComplete: async () => {
        asked++;
        return s.complete();
      },
    });
    expect(s.calls.map((c) => c.range)).toEqual([
      "bytes 0-4095/*",
      "bytes 4096-8191/*",
      "bytes 8192-9999/10000", // dropped: the gateway says not complete
      "bytes */10000", // 308, 8192 committed
      "bytes 8192-9999/10000", // completed, hidden: the gateway says complete
    ]);
    expect(asked).toBe(2);
    expect(sameBytes(s.bytesReceived(), data)).toBe(true);
  });

  it("doesn't ask the gateway before the last chunk went out", async () => {
    const s = fakeSession((i) => (i === 0 ? "drop" : null));
    let asked = 0;
    await uploadResumable(URL, new Blob([bytes(5000)]), undefined, {
      transport: s.transport,
      chunkBytes: 4096,
      backoff: noWait,
      verifyComplete: async () => {
        asked++;
        return false;
      },
    });
    expect(asked).toBe(0);
  });

  it("retries server errors and gives up after the last attempt", async () => {
    const s = fakeSession((_, call) => (call.size > 0 ? 503 : null));
    const err = await uploadResumable(URL, new Blob([bytes(5000)]), undefined, {
      transport: s.transport,
      chunkBytes: 4096,
      maxAttempts: 3,
      backoff: noWait,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResumableUploadError);
    expect((err as ResumableUploadError).status).toBe(503);
    expect(s.calls.filter((c) => c.size > 0)).toHaveLength(3);
    expect(s.received.length).toBe(0);
  });

  it("fails at once when the session is gone", async () => {
    const s = fakeSession(() => 404);
    const err = await uploadResumable(URL, new Blob([bytes(100)]), undefined, {
      transport: s.transport,
      backoff: noWait,
    }).catch((e: unknown) => e);
    expect((err as ResumableUploadError).status).toBe(404);
    expect(s.calls).toHaveLength(1);
  });
});
