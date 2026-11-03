"use client";

/**
 * A muted, looping landing clip: `<base>.mp4` (H.264) first, then
 * `<base>.webm` (VP9), with `<base>.jpg` as the poster. H.264 leads
 * because iPhone Safari picks a VP9 WebM it then paints as a black box. It plays only while on screen
 * and never when the viewer asked for reduced motion — then the poster is
 * all they see.
 */

import { useEffect, useRef } from "react";

export function LoopVideo({
  base,
  label,
  className,
}: {
  base: string;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    const sync = () => {
      if (visible && !motion.matches) {
        // play() is a promise in browsers and missing in some test DOMs
        Promise.resolve()
          .then(() => video.play())
          .catch(() => {});
      } else {
        video.pause();
      }
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            ([entry]) => {
              visible = entry.isIntersecting;
              sync();
            },
            { rootMargin: "200px" },
          );
    if (observer) {
      observer.observe(video);
    } else {
      visible = true;
      sync();
    }
    motion.addEventListener("change", sync);
    return () => {
      observer?.disconnect();
      motion.removeEventListener("change", sync);
    };
  }, []);

  return (
    <video
      ref={ref}
      loop
      muted
      playsInline
      preload="none"
      poster={`${base}.jpg`}
      aria-label={label}
      className={className}
    >
      <source src={`${base}.mp4`} type="video/mp4" />
      <source src={`${base}.webm`} type="video/webm" />
    </video>
  );
}
