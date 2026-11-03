"use client";

/**
 * The hero's before/after (mock 12, 2026-11 samples): one moment of a
 * sample clip as the 2D source on the left and as Lifelike 3D in red-cyan
 * on the right, with a divider to drag. Two stills, no video, so the hero
 * stays light (it is the page's largest paint). The divider is a plain
 * range input stretched over the picture: keyboard and screen readers get
 * it for free.
 */

import Image from "next/image";
import { useState } from "react";

import { HERO_COMPARE } from "@/lib/samples";

export function HeroCompare() {
  const [split, setSplit] = useState(50);

  return (
    <figure className="relative">
      <div className="ll-edge overflow-hidden rounded-2xl p-px">
        <div
          data-testid="hero-compare"
          className="relative aspect-video w-full overflow-hidden rounded-2xl bg-black"
        >
          <Image
            src={HERO_COMPARE.before}
            alt={`${HERO_COMPARE.title}, the 2D video`}
            fill
            priority
            sizes="(max-width: 1024px) 100vw, 640px"
            className="object-cover"
          />
          <div
            className="absolute inset-0"
            style={{ clipPath: `inset(0 0 0 ${split}%)` }}
          >
            <Image
              src={HERO_COMPARE.after}
              alt={`${HERO_COMPARE.title} in Lifelike 3D, shown in red-cyan`}
              fill
              priority
              sizes="(max-width: 1024px) 100vw, 640px"
              className="object-cover"
            />
          </div>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-white/90"
            style={{ left: `${split}%` }}
          >
            <span className="absolute top-1/2 left-1/2 flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-xs font-semibold text-black shadow">
              ⇆
            </span>
          </div>
          <span className="pointer-events-none absolute top-3 left-3 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white">
            Your video
          </span>
          <span className="pointer-events-none absolute top-3 right-3 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white">
            Lifelike 3D
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={split}
            onChange={(e) => setSplit(Number(e.target.value))}
            aria-label="Compare your video with Lifelike 3D"
            className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
          />
        </div>
      </div>
      <figcaption className="mt-3 text-xs text-fg-muted">
        Drag to compare. Red-cyan glasses show the depth.{" "}
        <a href="#samples" className="text-primary hover:underline">
          Watch it in your headset
        </a>
      </figcaption>
    </figure>
  );
}
