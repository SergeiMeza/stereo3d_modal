"use client";

/**
 * Landing-page workflow explorer: the app's five rooms (Media, Cut,
 * Depth, Stereo, Deliver) as an interactive tab strip over real product
 * screenshots. Mirrors the studio's own left-nav order and icons so the
 * landing is a preview of the actual UI, not a stylized mockup.
 */

import {
  Clapperboard,
  Glasses,
  Layers,
  Scissors,
  Upload,
  type LucideIcon,
} from "lucide-react";
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
    label: "Media",
    icon: Clapperboard,
    title: "Know your source, frame by frame",
    detail:
      "Resolution, frame rate, duration, scene count — reviewed on a frame-exact player before you spend anything.",
    image: "/landing/media-tab.webp",
    dims: { width: 1600, height: 1705 },
    alt: "Media page of Stereo3D Studio showing a frame-exact source player, filmstrip and source details",
  },
  {
    id: "cut",
    label: "Cut",
    icon: Scissors,
    title: "Scene cuts you can trust",
    detail:
      "Cuts are detected automatically and stay fully editable — add, merge, import or export, every boundary exact to the frame. Depth resets exactly where your scenes do.",
    image: "/landing/cut-tab.webp",
    dims: { width: 1600, height: 1705 },
    alt: "Cut page of Stereo3D Studio showing editable scene-cut markers on a filmstrip and a grid of detected scenes",
  },
  {
    id: "depth",
    label: "Depth",
    icon: Layers,
    title: "Depth you can see before you pay for it",
    detail:
      "AI depth maps rendered side by side with your footage, stable across the whole shot. Pick the quality knob, exclude scenes that should stay 2D, export the map or bring your own.",
    image: "/landing/depth-tab.webp",
    dims: { width: 1600, height: 1734 },
    alt: "Depth page of Stereo3D Studio showing the source frame next to its computed depth map and per-scene 3D toggles",
  },
  {
    id: "stereo",
    label: "Stereo",
    icon: Glasses,
    title: "3D directed scene by scene",
    detail:
      "Every scene is measured and classified automatically — close-up, standard, wide. Review against the real footage, override the depth strength only where it matters, keep credits and logos flat.",
    image: "/landing/stereo-tab.webp",
    dims: { width: 1600, height: 1734 },
    alt: "Stereo page of Stereo3D Studio showing per-scene 3D classification with manual overrides next to a live depth preview",
  },
  {
    id: "deliver",
    label: "Deliver",
    icon: Upload,
    title: "One render, every format",
    detail:
      "The production render inherits your preview work — approved depth, scene tweaks — and reuses it at a discount. Pick a preset up to 4K and check every format you need.",
    image: "/landing/deliver-tab.webp",
    dims: { width: 1600, height: 1734 },
    alt: "Deliver page of Stereo3D Studio showing inherited preview settings, a quality preset picker and output format checkboxes",
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
