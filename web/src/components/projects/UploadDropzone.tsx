"use client";

/**
 * The "1 video = 1 project" entry point. Drag-drop or pick an
 * .mp4/.mov/.m4v, then:
 *
 *   POST /v1/uploads → upload (client.uploadFile: one signed PUT, or — for
 *   files over 100 MB and everything in China mode — resumable 8 MiB
 *   chunks that retry and resume after a dropped connection) →
 *   POST /v1/projects { gcs_key, name: filename stem, method: lifelike } →
 *   router.push(/projects/{id}).
 *
 * New projects are Lifelike 3D (Classic 3D takes no new projects since
 * 2026-11-04; a classic create gets 422 classic_retired), so the local
 * length check uses Lifelike's cap (methods.lifelike.max_source_duration_s,
 * 0 = unlimited). The method is always sent explicitly. While a file goes up the dropzone shows its size, progress
 * and time left, and the browser asks before the tab closes. A chunked
 * upload that fails can resume where it stopped.
 *
 * GatewayError messages are user-safe and rendered verbatim.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";

import { pushWithFallback } from "@/lib/navigation";
import { useEffect, useRef, useState } from "react";

import { projectCreatedAtom } from "@/components/projects/projectsAtoms";
import { track, upgradeSession } from "@/lib/analytics";
import { useAppSetAtom } from "@/lib/state/stores";
import { LimitsNotice } from "@/components/pay/LimitsNotice";
import { GatewayError } from "@/lib/api/client";
import {
  newProjectMethod,
  type GatewayLimits,
  type Method,
  type PublicPricing,
  type UploadTicket,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useLimits } from "@/lib/api/useLimits";
import { usePricing } from "@/lib/api/usePricing";
import { methodLimitText } from "@/components/steps/methods";
import { METHOD_NAMES } from "@/lib/glossary";
import { formatBytes, formatTimeLeft } from "@/lib/format";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
};

const ACCEPT = ".mp4,.mov,.m4v,.webm";

/** Classic's cap, for gateways from before per-method caps (which still
 * reject longer sources up front). */
const LEGACY_MAX_DURATION_S = 10 * 60;

/** The local length cap for a new project's method, in seconds; 0 =
 * unlimited, null = unknown (limits not loaded — the gateway decides).
 * The gateway re-checks after its own probe; this check just fails fast
 * before a long upload. */
export function maxDurationFor(
  limits: GatewayLimits | null,
  method: Method,
): number | null {
  if (limits === null) return null;
  const perMethod = limits.methods?.[method]?.max_source_duration_s;
  if (typeof perMethod === "number") return perMethod;
  return limits.limits?.max_duration_s ?? LEGACY_MAX_DURATION_S;
}

/** "Lifelike 3D: any length, up to 8K" (S3D-05): new projects are always
 * Lifelike (S3D-01), so the upload box states its limits only, from GET
 * /v1/limits and /v1/pricing. */
export function lengthLimits(
  limits: GatewayLimits | null,
  pricing: PublicPricing | null = null,
  t: Tr = EN,
): string {
  return t("upload.lengthLimits", {
    method: METHOD_NAMES.lifelike,
    limits: methodLimitText("lifelike", limits, pricing, t),
  });
}

/** Only after this much progress is a time-left estimate shown. */
const ETA_MIN_ELAPSED_MS = 3000;

type Phase = "idle" | "uploading" | "creating";

/** A chunked upload that failed part-way: the session keeps what arrived,
 * so "Resume upload" continues from there. */
interface Interrupted {
  file: File;
  ticket: UploadTicket;
  contentType: string;
}

interface VideoMeta {
  duration: number; // seconds
  width: number;
  height: number;
}

/** Read duration/dimensions from the file's container metadata. Resolves
 * null when the browser can't decode the file (odd codec, jsdom) — the
 * gateway's probe is the authoritative check, so null just skips the
 * fast local one. */
function readVideoMeta(file: File): Promise<VideoMeta | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    // "" = this environment can't decode the type (jsdom always; Chrome
    // for some .mov flavors) — skip the local check, the gateway decides.
    if (video.canPlayType(file.type || "video/mp4") === "") {
      resolve(null);
      return;
    }
    let url: string;
    try {
      url = URL.createObjectURL(file);
    } catch {
      resolve(null);
      return;
    }
    const done = (meta: VideoMeta | null) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    // metadata on a local blob loads near-instantly; never let a decoder
    // stall wedge the dropzone
    const timer = setTimeout(() => done(null), 5000);
    video.preload = "metadata";
    video.onloadedmetadata = () =>
      done({
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    video.onerror = () => done(null);
    video.src = url;
  });
}

/** The length limit, when the gateway sets one (Lifelike: any length,
 * any size — bigger sources are scaled down to 8K by the service). */
function lengthLimitError(
  meta: VideoMeta,
  maxDurationS: number | null,
  t: Tr = EN,
): string | null {
  if (
    maxDurationS !== null &&
    maxDurationS > 0 &&
    Number.isFinite(meta.duration) &&
    meta.duration > maxDurationS
  ) {
    const m = Math.floor(meta.duration / 60);
    const s = Math.round(meta.duration % 60);
    return t("upload.tooLong", { m, s, max: Math.round(maxDurationS / 60) });
  }
  return null;
}

function contentTypeFor(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return null;
  return CONTENT_TYPES[filename.slice(dot + 1).toLowerCase()] ?? null;
}

/** Filename without its extension — the new project's name. */
function stem(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

export function UploadDropzone({
  first = false,
}: {
  /** no projects yet: the drop zone is the empty state too (owner 2026-11-05) */
  first?: boolean;
} = {}) {
  const t = useT();
  const gateway = useGateway();
  const createdProject = useAppSetAtom(projectCreatedAtom);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [limited, setLimited] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [interrupted, setInterrupted] = useState<Interrupted | null>(null);
  const [timeLeftS, setTimeLeftS] = useState<number | null>(null);
  // progress timing for the time-left estimate: start of this attempt and
  // the fraction it started from (a resume starts part-way)
  const timingRef = useRef<{ startedAt: number; from: number } | null>(null);

  const busy = phase !== "idle";
  // Per-method source caps; unknown (null) just skips the local check.
  const limits = useLimits();
  const pricing = usePricing();
  const method = newProjectMethod(limits);
  const maxDurationS = maxDurationFor(limits, method);

  // Closing the tab mid-upload loses it: ask first. Not once the project
  // exists and the page itself loads it in full (owner bug 2026-11-07).
  const leaving = useRef(false);
  useEffect(() => {
    if (!busy) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leaving.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [busy]);

  function onProgress(fraction: number) {
    setProgress(fraction);
    const timing = timingRef.current;
    if (timing === null) return;
    const elapsed = Date.now() - timing.startedAt;
    const done = fraction - timing.from;
    if (elapsed < ETA_MIN_ELAPSED_MS || done <= 0) return;
    setTimeLeftS(((elapsed / done) * (1 - fraction)) / 1000);
  }

  /** Upload (or resume) and create the project. */
  async function send(
    file: File,
    contentType: string,
    resume: Interrupted | null,
  ): Promise<void> {
    let ticket: UploadTicket | null = resume?.ticket ?? null;
    try {
      ticket ??= await gateway.createUpload(file.name, contentType, file.size);
      timingRef.current = { startedAt: Date.now(), from: resume ? progress : 0 };
      setTimeLeftS(null);
      await gateway.uploadFile(ticket, file, onProgress, {
        resume: resume !== null,
      });
      setInterrupted(null);
      setProgress(1);
      setTimeLeftS(null);
      setPhase("creating");
      // The billing profile must exist before any paid conversion; ensure
      // it (idempotent) before the project so the sign-in-time ensure has a
      // guaranteed backstop.
      await gateway.ensureCustomer();
      const project = await gateway.createProject({
        gcs_key: ticket.gcs_key,
        name: stem(file.name),
        // gateway 00175: Source details names the file as it was picked
        source_filename: file.name,
        method,
      });
      track("project_created");
      // the list has it before Projects reads again
      createdProject(project);
      upgradeSession("uploaded-video");
      // owner bug 2026-11-07: a push that never lands becomes a full load
      pushWithFallback(router, `/projects/${project.project_id}`, () => {
        leaving.current = true;
      });
    } catch (e) {
      track("upload_failed");
      // a chunked session keeps what arrived: offer to continue from there
      const resumable =
        ticket?.resumable === true &&
        e instanceof GatewayError &&
        e.code === "upload_failed";
      setInterrupted(
        resumable && ticket ? { file, ticket, contentType } : null,
      );
      // P11: past the free limits the gateway answers 403
      setLimited(e instanceof GatewayError && e.code === "save_method_for_more");
      setError(
        e instanceof GatewayError && e.code === "save_method_for_more"
          ? null
          : resumable
            ? t("upload.stopped")
            : e instanceof GatewayError
              ? e.message
              : t("upload.failed"),
      );
      setTimeLeftS(null);
      setPhase("idle");
    }
  }

  async function startUpload(file: File) {
    if (busy) return;
    const contentType = contentTypeFor(file.name);
    if (contentType === null) {
      setError(t("upload.unsupported"));
      return;
    }
    const meta = await readVideoMeta(file);
    if (meta !== null) {
      const limitError = lengthLimitError(meta, maxDurationS, t);
      if (limitError !== null) {
        setError(limitError);
        return;
      }
    }
    setError(null);
    setInterrupted(null);
    setFileName(file.name);
    setFileSize(file.size);
    setProgress(0);
    setPhase("uploading");
    track("upload_started", {
      content_type: contentType,
      size_mb: Math.round(file.size / 1_000_000),
      ...(meta !== null && Number.isFinite(meta.duration)
        ? { duration_s: Math.round(meta.duration) }
        : {}),
    });
    await send(file, contentType, null);
  }

  async function resumeUpload() {
    if (busy || interrupted === null) return;
    setError(null);
    setPhase("uploading");
    track("upload_resumed");
    await send(interrupted.file, interrupted.contentType, interrupted);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void startUpload(file);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (file) void startUpload(file);
  }

  const percent = Math.round(progress * 100);

  return (
    <div
      data-testid="upload-dropzone"
      data-first={first || undefined}
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={handleDrop}
      className={`rounded-lg border border-dashed ${first ? "p-8" : "p-6"} transition-colors ${
        dragActive ? "border-primary bg-surface-2" : "border-edge bg-surface-1"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        aria-label={t("upload.inputLabel")}
        className="hidden"
        disabled={busy}
        onChange={handleChange}
      />
      <div className="flex flex-col items-center gap-2 text-center">
        <p className={first ? "font-medium text-fg" : "text-fg"}>
          {first ? t("upload.firstProject") : t("upload.dragDrop")}
        </p>
        <p data-testid="upload-limits" className="text-xs text-fg-muted">
          {t("upload.formats", { limits: lengthLimits(limits, pricing, t) })}
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="mt-1 rounded-md bg-primary px-3 py-1.5 font-medium text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("upload.choose")}
        </button>
        <Link href="/pricing" className="mt-1 text-xs text-primary hover:underline">
          {t("upload.seePrices")}
        </Link>
      </div>

      {busy && (
        <div className="mx-auto mt-4 max-w-md">
          <div className="flex items-baseline justify-between text-xs text-fg-muted">
            <span className="truncate">
              {phase === "uploading"
                ? t("upload.uploading", { name: fileName ?? t("upload.videoFallback") })
                : t("upload.creating")}
            </span>
            <span className="ml-3 shrink-0 font-mono">{percent}%</span>
          </div>
          {phase === "uploading" ? (
            <p
              data-testid="upload-detail"
              className="mt-1 flex justify-between gap-3 text-[11px] text-fg-muted"
            >
              <span>
                {fileSize !== null
                  ? t("upload.bytes", {
                      done: formatBytes(Math.round(fileSize * progress)),
                      total: formatBytes(fileSize),
                    })
                  : null}
              </span>
              <span>
                {timeLeftS !== null ? formatTimeLeft(timeLeftS) : t("upload.estimating")}
              </span>
            </p>
          ) : null}
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-150"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      )}

      {limited ? (
        <div className="mt-4">
          <LimitsNotice force />
        </div>
      ) : null}
      {error !== null && (
        <p role="alert" className="mt-4 text-center text-xs text-red-400">
          {error}
        </p>
      )}
      {interrupted !== null && !busy ? (
        <div className="mt-2 flex justify-center">
          <button
            type="button"
            onClick={() => void resumeUpload()}
            className="rounded-md border border-edge bg-surface-2 px-3 py-1.5 text-xs text-fg transition-colors hover:bg-surface-1"
          >
            {t("upload.resume", { pct: Math.round(progress * 100) })}
          </button>
        </div>
      ) : null}
    </div>
  );
}
