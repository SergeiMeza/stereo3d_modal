/**
 * GatewayClient uploads against the mock gateway: China mode asks for a
 * resumable ticket and uploads in chunks, surviving a failed chunk;
 * everyone else keeps the single signed PUT.
 *
 * jsdom's XHR hands MSW a Blob body as a string, so chunks go through a
 * fetch transport here; browsers use the XHR one (for progress events).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { mockDb, mockUploads } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import {
  CHUNKED_UPLOAD_THRESHOLD_BYTES,
  FILES_DELETED_MESSAGE,
  GatewayClient,
  GatewayError,
  normalizeDownloads,
  wantsChunkedUpload,
} from "./client";
import { UPLOAD_CHUNK_BYTES, type ChunkTransport } from "./resumableUpload";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  mockDb.reset();
  mockUploads.reset();
});
afterAll(() => server.close());

const fetchTransport: ChunkTransport = async (url, body, headers, onProgress) => {
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers,
      redirect: "manual", // a 308 here is "incomplete", not a redirect
      body: body === null ? null : await body.arrayBuffer(),
    });
    onProgress?.(body?.size ?? 0);
    return { status: res.status, range: res.headers.get("Range") };
  } catch {
    return { status: 0, range: null };
  }
};

/** What a browser sees: storage's completing answer carries no CORS
 * headers, so it reads as a network failure. */
const browserLikeTransport: ChunkTransport = async (...args) => {
  const a = await fetchTransport(...args);
  return a.status === 200 ? { status: 0, range: null } : a;
};

function client(chunked: boolean, transport = fetchTransport): GatewayClient {
  return new GatewayClient({
    baseUrl: GATEWAY,
    getToken: async () => "token",
    resumableUploads: () => chunked,
    chunkTransport: transport,
  });
}

/** A file just over two chunks. */
function video(): Blob {
  return new Blob([new Uint8Array(2 * UPLOAD_CHUNK_BYTES + 4096)], {
    type: "video/mp4",
  });
}

describe("GatewayClient uploads", () => {
  it("uploads in chunks with a resumable ticket in China mode", async () => {
    const c = client(true);
    const ticket = await c.createUpload("clip.mp4", "video/mp4");
    expect(ticket.resumable).toBe(true);

    const file = video();
    const progress: number[] = [];
    await c.uploadFile(ticket, file, (f) => progress.push(f));

    const session = mockUploads.sessions.get(ticket.upload_id)!;
    expect(session.done).toBe(true);
    expect(session.bytes).toBe(file.size);
    expect(session.chunks).toBe(3);
    expect(progress.at(-1)).toBe(1);
  });

  it("retries a failed chunk and resumes where the session stands", async () => {
    const c = client(true);
    const ticket = await c.createUpload("clip.mp4", "video/mp4");
    mockUploads.failNext = 1;

    const file = video();
    await c.uploadFile(ticket, file);

    const session = mockUploads.sessions.get(ticket.upload_id)!;
    expect(session.done).toBe(true);
    expect(session.bytes).toBe(file.size);
    expect(session.statusChecks).toBe(1);
  }, 15_000);

  it("confirms completion with the gateway when the browser can't see it", async () => {
    const c = client(true, browserLikeTransport);
    const ticket = await c.createUpload("clip.mp4", "video/mp4");
    const file = video();
    const progress: number[] = [];
    await c.uploadFile(ticket, file, (f) => progress.push(f));

    const session = mockUploads.sessions.get(ticket.upload_id)!;
    expect(session.done).toBe(true);
    expect(session.bytes).toBe(file.size);
    expect(session.chunks).toBe(3); // nothing sent twice
    expect(progress.at(-1)).toBe(1);
    const st = await c.uploadStatus(ticket.gcs_key);
    expect(st).toEqual({ gcs_key: ticket.gcs_key, exists: true, bytes: file.size });
  });

  it("reports a chunked upload that keeps failing as upload_failed", async () => {
    const c = client(true);
    const ticket = await c.createUpload("clip.mp4", "video/mp4");
    // Every chunk fails; the session keeps nothing.
    mockUploads.failNext = 100;
    const err = await c
      .uploadFile(ticket, new Blob([new Uint8Array(1024)]))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("upload_failed");
    expect((err as GatewayError).status).toBe(503);
  }, 30_000);

  it("keeps the single signed PUT outside China mode", async () => {
    const c = client(false);
    const ticket = await c.createUpload("clip.mp4", "video/mp4");
    expect(ticket.resumable).toBeUndefined();
    expect(ticket.upload_url).toContain("/__mock__/upload/");
    await c.uploadFile(ticket, new Blob([new Uint8Array(1024)]));
    expect(mockUploads.sessions.size).toBe(0);
  });

  it("chunks every file over 100 MB, for everyone, not only in China mode", async () => {
    expect(CHUNKED_UPLOAD_THRESHOLD_BYTES).toBe(100_000_000);
    expect(wantsChunkedUpload(100_000_000)).toBe(false);
    expect(wantsChunkedUpload(100_000_001)).toBe(true);
    expect(wantsChunkedUpload(1024, true)).toBe(true); // China mode
    expect(wantsChunkedUpload(undefined)).toBe(false);

    const c = client(false);
    const big = await c.createUpload("long.mov", "video/quicktime", 2_500_000_000);
    expect(big.resumable).toBe(true);
    expect(mockUploads.sessions.has(big.upload_id)).toBe(true);
    const small = await c.createUpload("short.mp4", "video/mp4", 50_000_000);
    expect(small.resumable).toBeUndefined();
  });

  it("resumes an interrupted upload where the session stands", async () => {
    const c = client(true); // a resumable session (big file or China mode)
    const file = video();
    const ticket = await c.createUpload("clip.mp4", "video/mp4", file.size);
    // The first chunk made it before the connection dropped.
    await fetchTransport(ticket.upload_url, file.slice(0, UPLOAD_CHUNK_BYTES), {
      "Content-Range": `bytes 0-${UPLOAD_CHUNK_BYTES - 1}/*`,
    });
    const progress: number[] = [];
    await c.uploadFile(ticket, file, (f) => progress.push(f), { resume: true });

    const session = mockUploads.sessions.get(ticket.upload_id)!;
    expect(session.done).toBe(true);
    expect(session.bytes).toBe(file.size);
    expect(session.chunks).toBe(3); // nothing sent twice
    expect(session.statusChecks).toBe(1);
    expect(progress[0]).toBeCloseTo(UPLOAD_CHUNK_BYTES / file.size);
  });
});

describe("normalizeDownloads", () => {
  it("keeps the name → URL map as is", () => {
    expect(
      normalizeDownloads({ downloads: { sbs: "u1", mvhevc_part01: "u2" }, expires_in: 60 }),
    ).toEqual({ downloads: { sbs: "u1", mvhevc_part01: "u2" }, expires_in: 60 });
  });

  it("folds per-part entries into <name>_partNN keys", () => {
    expect(
      normalizeDownloads({
        downloads: [
          { name: "mvhevc", part: 1, url: "a", filename: "Clip 3D Part 1.mov" },
          { name: "mvhevc", part: 2, url: "b", filename: "Clip 3D Part 2.mov" },
          { name: "sbs", url: "c" },
        ],
        expires_in: 60,
      }).downloads,
    ).toEqual({ mvhevc_part01: "a", mvhevc_part02: "b", sbs: "c" });
    expect(
      normalizeDownloads({ downloads: { mvhevc: { url: "a", part: 3 } } })
        .downloads,
    ).toEqual({ mvhevc_part03: "a" });
  });

  it("reads the gateway's files listing for split parts", () => {
    const d = normalizeDownloads({
      downloads: { mvhevc_part01: "a", mvhevc_part02: "b" },
      files: [
        { name: "mvhevc_part01", format: "mvhevc", part: 1, filename: "Trip 3D Part 1.mov", url: "a" },
        { name: "mvhevc_part02", format: "mvhevc", part: 2, filename: "Trip 3D Part 2.mov", url: "b" },
      ],
      expires_in: 60,
    });
    expect(d.downloads).toEqual({ mvhevc_part01: "a", mvhevc_part02: "b" });
    expect(d.files?.map((f) => [f.format, f.part, f.filename])).toEqual([
      ["mvhevc", 1, "Trip 3D Part 1.mov"],
      ["mvhevc", 2, "Trip 3D Part 2.mov"],
    ]);
  });
});

describe("410 files_deleted (S3D-24)", () => {
  it("reads the same plain sentence wherever it comes from", async () => {
    const id = [...mockDb.projects.keys()][0];
    mockDb.projects.get(id)!.files_deleted_at = "2026-10-30T00:00:00Z";
    const err = await client(false)
      .quoteStep(id, { step: "production", preset: "1080p", formats: ["sbs"] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).status).toBe(410);
    expect((err as GatewayError).code).toBe("files_deleted");
    expect((err as GatewayError).message).toBe(FILES_DELETED_MESSAGE);
    expect(FILES_DELETED_MESSAGE).toBe(
      "This project's files have been deleted. Upload the video again to make new 3D.",
    );
  });
});
