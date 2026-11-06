"use client";

/**
 * "View in 3D" (S3D-47) for a preview or a finished run: on a headset it
 * plays the file that headset shows in 3D — Vision Pro spatial video on
 * Apple Vision Pro, side by side on Quest (half size) and Pico (full) — in
 * full screen on the <video> itself, from the tap. Quest and Pico get a
 * one-line hint to pick the 3D side-by-side mode in their player. On a
 * computer or phone the same button is a plain "Full screen".
 */

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { PayLink, useOutstandingCents } from "@/components/billing/PayToDownload";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  detectClient,
  enterFullscreen,
  exitFullscreen,
  GALAXY_XR,
  HEADSET_HINT,
  isFullscreen,
  playChoice,
  type Client,
} from "@/lib/headset";

/** This browser's client, read once (the workspace renders client-side).
 * Chrome's reduced user agent can hide the Galaxy XR model, so an
 * Android desktop guess asks userAgentData for it. */
export function useClient(): Client {
  const [client, setClient] = useState<Client>(() => detectClient());
  useEffect(() => {
    if (client !== "desktop") return;
    const data = (
      navigator as Navigator & {
        userAgentData?: {
          platform?: string;
          getHighEntropyValues?: (h: string[]) => Promise<{ model?: string }>;
        };
      }
    ).userAgentData;
    if (data?.platform !== "Android" || !data.getHighEntropyValues) return;
    let cancelled = false;
    data
      .getHighEntropyValues(["model"])
      .then((v) => {
        if (!cancelled && v.model && GALAXY_XR.test(v.model)) setClient("galaxyxr");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client]);
  return client;
}

export function ViewIn3D({
  files,
  size = "sm",
  hideHint = false,
  onPlay,
  flatLabel = "Full screen",
}: {
  /** the button's words where the file plays flat (a computer or phone) */
  flatLabel?: string;
  /** 00081: tell the gateway a play started (POST .../plays) */
  onPlay?: (format: string) => void;
  /** a run's files: format (downloads key) → URL; null while loading */
  files: Partial<Record<string, string>> | null;
  size?: "xs" | "sm" | "lg";
  /** hide the one-line player hint (the page shows it once) */
  hideHint?: boolean;
}): JSX.Element | null {
  const client = useClient();
  // S3D-35: playing the file is the same access as downloading it
  const owed = useOutstandingCents();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const choice = files ? playChoice(client, files) : null;

  // leaving full screen stops the video and frees it
  useEffect(() => {
    if (!playing) return;
    const v = videoRef.current;
    const onChange = () => {
      if (isFullscreen()) return;
      stop();
    };
    const stop = () => {
      if (!v) return;
      v.pause();
      v.removeAttribute("src");
      v.load();
      setPlaying(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    v?.addEventListener("webkitendfullscreen", stop);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
      v?.removeEventListener("webkitendfullscreen", stop);
    };
  }, [playing]);

  // unmounting mid-play leaves full screen too
  useEffect(() => {
    const v = videoRef.current;
    return () => {
      if (v && isFullscreen()) exitFullscreen(v);
    };
  }, []);

  if (!choice) return null;
  if (owed > 0) {
    return (
      <PayLink
        cents={owed}
        verb="play"
        className={buttonVariants({ variant: "outline", size })}
      />
    );
  }
  const label = choice.stereo ? "View in 3D" : flatLabel;
  const hint = choice.stereo && !hideHint ? HEADSET_HINT[client] : undefined;

  function play(): void {
    const v = videoRef.current;
    if (!v || !choice) return;
    // src, full screen and play all inside the tap
    v.src = choice.url;
    enterFullscreen(v);
    setPlaying(true);
    onPlay?.(choice.format);
    void v.play()?.catch?.(() => {});
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        variant={choice.stereo ? "default" : "outline"}
        size={size}
        data-testid="view-in-3d"
        data-format={choice.format}
        onClick={play}
      >
        {label}
      </Button>
      {hint ? (
        <span data-testid="view-in-3d-hint" className="text-[11px] text-fg-muted">
          {hint}
        </span>
      ) : client === "vision" && !choice.stereo && !hideHint ? (
        <span data-testid="view-in-3d-hint" className="text-[11px] text-fg-muted">
          Plays flat here. Vision Pro spatial video plays in 3D.
        </span>
      ) : null}
      <video
        ref={videoRef}
        playsInline
        preload="none"
        aria-hidden={!playing}
        data-testid="view-in-3d-video"
        className="pointer-events-none fixed top-0 left-0 h-px w-px opacity-0 [&:fullscreen]:pointer-events-auto [&:fullscreen]:opacity-100"
      />
    </span>
  );
}
