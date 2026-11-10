"use client";

/**
 * One sample on /vision-pro: its poster, its name and "Watch in 3D". The
 * tap loads the sample's spatial video (MV-HEVC, on the samples CDN), plays
 * it and puts it in full screen, where Vision Pro Safari shows it in 3D
 * (inline it plays flat, lib/headset). Leaving full screen stops it and
 * hides it again. Nothing loads before the tap: the files are 130–320 MB.
 */

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import {
  SampleRegionNotice,
  useSampleBlocked,
} from "@/components/SampleRegionNotice";
import { track } from "@/lib/analytics";
import { enterFullscreen, isFullscreen } from "@/lib/headset";

export interface SpatialSampleProps {
  slug: string;
  title: string;
  poster: string;
  src: string;
  watchLabel: string;
}

export function SpatialSample({
  slug,
  title,
  poster,
  src,
  watchLabel,
}: SpatialSampleProps): JSX.Element {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const blocked = useSampleBlocked(src);

  // full screen left (either API): stop and go back to the poster
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const stop = (): void => {
      if (isFullscreen()) return;
      v.pause();
      setPlaying(false);
    };
    document.addEventListener("fullscreenchange", stop);
    document.addEventListener("webkitfullscreenchange", stop);
    v.addEventListener("webkitendfullscreen", stop);
    return () => {
      document.removeEventListener("fullscreenchange", stop);
      document.removeEventListener("webkitfullscreenchange", stop);
      v.removeEventListener("webkitendfullscreen", stop);
    };
  }, []);

  function watch(): void {
    const v = video.current;
    if (!v) return;
    if (!v.getAttribute("src")) v.src = src;
    setPlaying(true);
    track("vision_pro_sample_play", { slug });
    // full screen first, inside the tap; play follows
    enterFullscreen(v);
    void v.play().catch(() => {});
  }

  return (
    <li
      className="flex flex-col gap-3"
      data-testid={`vision-pro-sample-${slug}`}
    >
      <div className="ll-edge overflow-hidden rounded-2xl p-px">
        <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local poster at its own size */}
          <img
            src={poster}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
          <video
            ref={video}
            preload="none"
            playsInline
            loop
            poster={poster}
            aria-label={title}
            className={
              playing
                ? "absolute inset-0 h-full w-full object-contain"
                : "hidden"
            }
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-base font-medium text-fg">{title}</p>
        {blocked ? (
          <SampleRegionNotice />
        ) : (
          <button
            type="button"
            onClick={watch}
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80"
          >
            {watchLabel}
          </button>
        )}
      </div>
    </li>
  );
}
