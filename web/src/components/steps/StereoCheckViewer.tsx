"use client";

/**
 * A free 3D check on this screen (S3D-32) for a side-by-side clip: play it
 * as it is, as red-cyan (glasses), or as a wiggle that swaps the eyes a
 * few times a second. Red-cyan and wiggle are drawn in the browser on a
 * canvas from the one video element — compositing only (multiply by red /
 * cyan, then add), never reading pixels back, so a signed download link
 * from another origin still draws.
 */

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

export type CheckMode = "sbs" | "anaglyph" | "wiggle";

// owner 2026-11-07: Red-cyan first (and the first-time choice), then Wiggle, then Side by side
export const CHECK_MODES: readonly { id: CheckMode; label: string }[] = [
  { id: "anaglyph", label: "Red-cyan" },
  { id: "wiggle", label: "Wiggle" },
  { id: "sbs", label: "Side by side" },
];

export const DEFAULT_CHECK_MODE: CheckMode = "anaglyph";

/** Eye swaps per second in wiggle mode. */
const WIGGLE_HZ = 6;
/** Canvas width cap (per eye) — plenty for a check, cheap to draw. */
const MAX_EYE_WIDTH = 960;

function drawFrame(
  canvas: HTMLCanvasElement,
  scratch: HTMLCanvasElement,
  video: HTMLVideoElement,
  mode: CheckMode,
  now: number,
  aspect: number,
): void {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw === 0 || vh === 0) return;
  const eyeW = vw / 2;
  const w = Math.min(MAX_EYE_WIDTH, Math.round(eyeW));
  // one eye's real shape (a half-size side by side is squeezed)
  const h = Math.round(w / aspect);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    scratch.width = w;
    scratch.height = h;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.globalCompositeOperation = "source-over";
  if (mode === "wiggle") {
    const right = Math.floor((now / 1000) * WIGGLE_HZ) % 2 === 1;
    ctx.drawImage(video, right ? eyeW : 0, 0, eyeW, vh, 0, 0, w, h);
    return;
  }
  // red-cyan: left eye × red + right eye × cyan
  ctx.drawImage(video, 0, 0, eyeW, vh, 0, 0, w, h);
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, w, h);
  const sctx = scratch.getContext("2d");
  if (!sctx) return;
  sctx.globalCompositeOperation = "source-over";
  sctx.drawImage(video, eyeW, 0, eyeW, vh, 0, 0, w, h);
  sctx.globalCompositeOperation = "multiply";
  sctx.fillStyle = "#00ffff";
  sctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "lighter";
  ctx.drawImage(scratch, 0, 0);
  ctx.globalCompositeOperation = "source-over";
}

export function StereoCheckViewer({
  url,
  aspect,
  mode,
  onPlay,
}: {
  url: string;
  /** 00081: the clip started playing */
  onPlay?: () => void;
  /** one eye's width / height */
  aspect: number;
  mode: CheckMode;
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [scratch] = useState(() =>
    typeof document === "undefined" ? null : document.createElement("canvas"),
  );

  useEffect(() => {
    if (mode === "sbs") return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !scratch) return;
    let raf = 0;
    const tick = (now: number) => {
      drawFrame(canvas, scratch, video, mode, now, aspect);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode, scratch, url, aspect]);

  const canvasMode = mode !== "sbs";
  return (
    <div
      data-testid="stereo-check"
      data-mode={mode}
      className="relative w-full overflow-hidden rounded-md border border-edge bg-black"
      style={{ aspectRatio: canvasMode ? `${aspect}` : `${aspect * 2}` }}
    >
      <video
        ref={videoRef}
        key={url}
        src={url}
        onPlay={onPlay}
        autoPlay
        loop
        muted
        playsInline
        controls={!canvasMode}
        preload="auto"
        data-testid="lifelike-preview-video"
        className={
          canvasMode
            ? "pointer-events-none absolute inset-0 h-full w-full opacity-0"
            : "absolute inset-0 h-full w-full object-contain"
        }
      />
      {canvasMode ? (
        <>
          <canvas
            ref={canvasRef}
            aria-label={mode === "anaglyph" ? "Red-cyan view" : "Wiggle view"}
            className="absolute inset-0 h-full w-full object-contain"
            onClick={() => {
              const v = videoRef.current;
              if (!v) return;
              if (v.paused) void v.play();
              else v.pause();
            }}
          />
          <span className="pointer-events-none absolute top-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
            {mode === "anaglyph" ? "Red-cyan" : "Wiggle"}
          </span>
        </>
      ) : (
        <>
          <span className="pointer-events-none absolute top-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
            Left eye
          </span>
          <span className="pointer-events-none absolute top-2 left-[calc(50%+0.5rem)] rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
            Right eye
          </span>
        </>
      )}
    </div>
  );
}
