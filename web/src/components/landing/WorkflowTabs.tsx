"use client";

/**
 * Landing-page workflow explorer: the app's rooms a new (Lifelike)
 * project has — Overview, Scenes, Make 3D — as a tab strip over real product
 * screenshots. Mirrors the studio's own left-nav order and icons so the
 * landing is a preview of the actual UI, not a stylized mockup.
 */

import { Clapperboard, Scissors, Upload, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { BrowserFrame } from "@/components/landing/BrowserFrame";

interface Tab {
  id: string;
  label: string;
  icon: LucideIcon;
  title: string;
  detail: string;
  image: string;
  /** Intrinsic size of the webp — the panel shows the full screenshot. */
  dims: { width: number; height: number };
  alt: string;
}

const TABS: Tab[] = [
  {
    id: "media",
    label: "Overview",
    icon: Clapperboard,
    title: "Know your video, frame by frame",
    detail:
      "Length, quality, frame rate and scenes — checked on a frame-exact player, with the price for your video, before you spend anything.",
    image: "/landing/media-tab.webp",
    dims: { width: 1600, height: 1705 },
    alt: "Overview page of Stereo3D Studio showing a frame-exact player, filmstrip and video details",
  },
  {
    id: "cut",
    label: "Scenes",
    icon: Scissors,
    title: "Scene changes you can trust",
    detail:
      "Scene changes are found automatically and stay editable, every boundary exact to the frame. Each scene gets its own 3D.",
    image: "/landing/cut-tab.webp",
    dims: { width: 1600, height: 1705 },
    alt: "Scenes page of Stereo3D Studio showing editable scene markers on a filmstrip and a grid of scenes",
  },
  {
    id: "deliver",
    label: "Make 3D",
    icon: Upload,
    title: "One run, every format",
    detail:
      "Say where you'll watch it, pick the quality and the files you need — the whole video or just a part. The price shows before anything runs.",
    image: "/landing/deliver-tab.webp",
    dims: { width: 1600, height: 1734 },
    alt: "Make 3D page of Stereo3D Studio showing the quality picker and the files you get",
  },
];

export function WorkflowTabs() {
  // hero already shows the Stereo room — open on Cut for visual variety
  const [activeId, setActiveId] = useState("cut");
  const active = TABS.find((t) => t.id === activeId) ?? TABS[0];

  return (
    <div>
      <div
        role="tablist"
        aria-label="Studio workflow"
        className="flex flex-wrap gap-2"
      >
        {TABS.map((tab, i) => {
          const selected = tab.id === active.id;
          return (
            <button
              key={tab.id}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`workflow-panel-${tab.id}`}
              onClick={() => setActiveId(tab.id)}
              className={`flex items-center gap-2 rounded-md border px-3.5 py-2 text-sm transition-colors ${
                selected
                  ? "border-primary/60 bg-secondary text-fg"
                  : "border-edge bg-card text-fg-muted hover:border-primary/40 hover:text-fg"
              }`}
            >
              <span
                className={`font-mono text-[10px] ${selected ? "text-primary" : ""}`}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <tab.icon aria-hidden className="size-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`workflow-panel-${active.id}`}
        className="mt-6 space-y-5"
      >
        <div className="max-w-2xl">
          <h3 className="text-lg font-medium text-fg">{active.title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
            {active.detail}
          </p>
        </div>
        <BrowserFrame src={active.image} alt={active.alt} dims={active.dims} />
      </div>
    </div>
  );
}
