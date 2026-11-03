"use client";

/**
 * "How it looks" (2026-11): screenshots of the real web app — the projects
 * list, Make 3D with the quality options up to 8K, a run in progress and
 * the files per headset — captured in mock-gateway mode with the licensed
 * sample clips. From 640 px up: a tab strip and one large 2240×1400 shot
 * (big enough to read). On phones: every phone capture (780×1400) in a
 * horizontal snap row. Hidden images are lazy, so each viewport downloads
 * only its own. Re-shoot recipe: web/docs/LANDING.md, "Assets".
 */

import Image from "next/image";
import { useState } from "react";

interface Shot {
  id: string;
  label: string;
  detail: string;
  alt: string;
}

const SHOTS: Shot[] = [
  {
    id: "projects",
    label: "Projects",
    detail: "Drop a video in. Every project in one place.",
    alt: "Projects page of Stereo3D Studio with five videos, one marked 3D ready",
  },
  {
    id: "make-3d",
    label: "Make 3D",
    detail: "Pick your headsets and the quality, up to 8K. The price shows first.",
    alt: "Make 3D page with Apple Vision Pro and Meta Quest picked and quality options from 1080p to 8K",
  },
  {
    id: "tracker",
    label: "Progress",
    detail: "Follow each step and the time left.",
    alt: "The price and a run in progress: getting ready done, now making the 3D video",
  },
  {
    id: "files",
    label: "Files",
    detail: "Vision Pro spatial video and side by side, ready to download.",
    alt: "Files page with a Vision Pro spatial video and a side-by-side file ready to download",
  },
];

const FRAME =
  "overflow-hidden border border-edge bg-card shadow-2xl shadow-black/50";

export function ProductTour() {
  const [activeId, setActiveId] = useState(SHOTS[1].id);
  const active = SHOTS.find((s) => s.id === activeId) ?? SHOTS[0];

  return (
    <div data-testid="product-tour">
      {/* 640 px and up: tabs over one large shot */}
      <div className="hidden sm:block">
        <div role="tablist" aria-label="The app" className="flex flex-wrap gap-2">
          {SHOTS.map((shot) => {
            const selected = shot.id === active.id;
            return (
              <button
                key={shot.id}
                role="tab"
                type="button"
                aria-selected={selected}
                aria-controls="tour-panel"
                onClick={() => setActiveId(shot.id)}
                className={`rounded-md border px-3.5 py-2 text-sm transition-colors ${
                  selected
                    ? "border-primary/60 bg-secondary text-fg"
                    : "border-edge bg-card text-fg-muted hover:border-primary/40 hover:text-fg"
                }`}
              >
                {shot.label}
              </button>
            );
          })}
        </div>
        <div role="tabpanel" id="tour-panel" className="mt-5">
          <p className="text-fg-muted">{active.detail}</p>
          <div className={`mt-5 rounded-xl ${FRAME}`}>
            <Image
              key={active.id}
              src={`/landing/ui/${active.id}.webp`}
              alt={active.alt}
              width={2240}
              height={1400}
              sizes="(max-width: 1152px) 100vw, 1120px"
              className="block h-auto w-full"
            />
          </div>
        </div>
      </div>

      {/* phones: every phone shot in a snap row */}
      <ul className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:hidden">
        {SHOTS.map((shot) => (
          <li
            key={shot.id}
            data-testid={`tour-${shot.id}`}
            className="w-[72%] max-w-[300px] shrink-0 snap-center"
          >
            <figure>
              <div className={`rounded-[22px] ${FRAME}`}>
                <Image
                  src={`/landing/ui/${shot.id}-phone.webp`}
                  alt={shot.alt}
                  width={780}
                  height={1400}
                  sizes="72vw"
                  className="block h-auto w-full"
                />
              </div>
              <figcaption className="mt-3">
                <p className="font-medium text-fg">{shot.label}</p>
                <p className="mt-1 text-sm text-fg-muted">{shot.detail}</p>
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </div>
  );
}
