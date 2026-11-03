"use client";

/**
 * "What happens to your video" — the three conversion passes, each
 * illustrated with a short looping clip made from our own footage
 * (2026-11): a glowing line sweeps across the clip and shows how near or
 * far everything is; the scene seen from a swaying viewpoint, then its two
 * eye views; the result on a floating window, a headset and XR glasses.
 * Copy rules from web/docs/LANDING.md apply: say what it does, no internal
 * pipeline terms.
 *
 * Each clip has a WebM (VP9) and an MP4 (H.264) source and a poster. The
 * video plays only while on screen and never when the viewer asked for
 * reduced motion: then the poster is all they see.
 */

import { useEffect, useRef } from "react";

const STEPS = [
  {
    number: "01",
    tag: "Depth",
    title: "We understand the shape of every scene",
    detail:
      "We work out how far away everything is in every frame, steady from frame to frame — the base the 3D is built on.",
    clip: "/landing/steps/depth",
    label:
      "A glowing line sweeps across the footage and shows near things warm and far things blue, then the picture again",
  },
  {
    number: "02",
    tag: "3D",
    title: "Two eyes from one camera",
    detail:
      "A left and a right view are made for every frame, and the areas each eye newly sees are filled in naturally. Here the viewpoint sways so you can see the depth on any screen.",
    clip: "/landing/steps/stereo",
    label:
      "The same footage seen from a gently swaying viewpoint, then its left-eye and right-eye views side by side",
  },
  {
    number: "03",
    tag: "Files",
    title: "Plays like it was shot in 3D",
    detail:
      "Your 3D video comes as Vision Pro spatial video and side by side — ready for Apple Vision Pro, Samsung Galaxy XR, Meta Quest, Pico and 3D displays.",
    clip: "/landing/steps/delivery",
    label:
      "The 3D video on a floating window in a living room, on a big screen in a headset, through the headset's lenses and in XR glasses",
  },
];

/** A muted loop that plays only while visible and only if motion is OK. */
function StepClip({ clip, label }: { clip: string; label: string }) {
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
      poster={`${clip}.jpg`}
      aria-label={label}
      className="aspect-video w-full rounded-lg border border-edge bg-card object-cover"
    >
      <source src={`${clip}.webm`} type="video/webm" />
      <source src={`${clip}.mp4`} type="video/mp4" />
    </video>
  );
}

export function PipelineSteps() {
  return (
    <div className="space-y-12">
      {STEPS.map((step, index) => (
        <div
          key={step.number}
          className="grid items-center gap-6 lg:grid-cols-2 lg:gap-12"
        >
          <div className={index % 2 === 1 ? "lg:order-2" : undefined}>
            <p className="font-mono text-[11px] tracking-wide text-primary uppercase">
              {step.number} · {step.tag}
            </p>
            <h3 className="mt-2 text-xl font-semibold tracking-tight text-fg">
              {step.title}
            </h3>
            <p className="mt-2 max-w-xl leading-relaxed text-fg-muted">
              {step.detail}
            </p>
          </div>
          <div className={index % 2 === 1 ? "lg:order-1" : undefined}>
            <StepClip clip={step.clip} label={step.label} />
          </div>
        </div>
      ))}
    </div>
  );
}
