"use client";

/**
 * The "1 video = 1 project" entry point. Drag-drop or pick an
 * .mp4/.mov/.m4v, then:
 *
 *   POST /v1/uploads → PUT to the signed URL (client.uploadFile, XHR for
 *   progress) → POST /v1/projects { gcs_key, name: filename stem } →
 *   router.push(/projects/{id}).
 *
 * GatewayError messages are user-safe and rendered verbatim.
 */

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { GatewayError } from "@/lib/api/client";
import { useGateway } from "@/lib/api/useGateway";

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
};

const ACCEPT = ".mp4,.mov,.m4v";

type Phase = "idle" | "uploading" | "creating";

function contentTypeFor(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return null;
  return CONTENT_TYPES[filename.slice(dot + 1).toLowerCase()] ?? null;
}

/** Filename without its extension — the new project's name. */
function stem(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

export function UploadDropzone() {
  const gateway = useGateway();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);

  const busy = phase !== "idle";

  async function startUpload(file: File) {
    if (busy) return;
    const contentType = contentTypeFor(file.name);
    if (contentType === null) {
      setError("Unsupported file type — choose an .mp4, .mov, or .m4v video.");
      return;
    }
    setError(null);
    setFileName(file.name);
    setProgress(0);
    setPhase("uploading");
    try {
      const ticket = await gateway.createUpload(file.name, contentType);
      await gateway.uploadFile(ticket, file, setProgress);
      setProgress(1);
      setPhase("creating");
      // The billing profile must exist before any paid conversion; ensure
      // it (idempotent) before the project so the sign-in-time ensure has a
      // guaranteed backstop.
      await gateway.ensureCustomer();
      const project = await gateway.createProject({
        gcs_key: ticket.gcs_key,
        name: stem(file.name),
      });
      router.push(`/projects/${project.project_id}`);
    } catch (e) {
      setError(
        e instanceof GatewayError ? e.message : "Upload failed — please try again.",
      );
      setPhase("idle");
    }
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
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={handleDrop}
      className={`rounded-lg border border-dashed p-6 transition-colors ${
        dragActive ? "border-primary bg-surface-2" : "border-edge bg-surface-1"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        aria-label="Upload video"
        className="hidden"
        disabled={busy}
        onChange={handleChange}
      />
      <div className="flex flex-col items-center gap-2 text-center">
        <p className="text-fg">
          Drag &amp; drop a video to start a project
        </p>
        <p className="text-xs text-fg-muted">
          One video per project · .mp4, .mov, or .m4v
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="mt-1 rounded-md bg-primary px-3 py-1.5 font-medium text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Choose video
        </button>
      </div>

      {busy && (
        <div className="mx-auto mt-4 max-w-md">
          <div className="flex items-baseline justify-between text-xs text-fg-muted">
            <span className="truncate">
              {phase === "uploading"
                ? `Uploading ${fileName ?? "video"}…`
                : "Creating project…"}
            </span>
            <span className="ml-3 shrink-0 font-mono">{percent}%</span>
          </div>
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

      {error !== null && (
        <p role="alert" className="mt-4 text-center text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
