"use client";

/**
 * Media page — the project's source at a glance: frame-exact preview
 * player, a READ-ONLY filmstrip timeline (scrub + zoom only — no cut
 * markers; cut furniture belongs to the Cut page), probe metadata and the
 * analyze credit. The "how this pipeline works" guide lives in the shared
 * ⓘ Guide drawer (shadcn Drawer/vaul, same as the step pages' Tips) and
 * deep-links into the other pages.
 *
 * Layout: the shared PageHeader, then the preview + timeline at FULL width
 * (theater, like the Cut page — a side column squeezed the player); the
 * Source / credit cards sit in a responsive row below.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { AnalyzeProgress } from "@/components/projects/AnalyzeBadge";
import { formatCents } from "@/components/steps/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import type { Project } from "@/lib/api/types";
import { frameToTimecode, parseRational } from "@/lib/frames";

import { FilmstripTimeline } from "./FilmstripTimeline";
import { PageHeader } from "./PageHeader";
import type { WorkspaceTabId } from "./PageTabs";
import { PreviewViewer } from "./PreviewViewer";
import { usePlayerShortcuts } from "./usePlayerShortcuts";
import { usePreviewPlayer } from "./usePreviewPlayer";
import { clampFrame } from "./utils";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes;
  let u = -1;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

const GUIDE: readonly {
  tab: WorkspaceTabId;
  n: number;
  title: string;
  blurb: string;
  price: "Free" | "Paid";
}[] = [
  {
    tab: "cut",
    n: 1,
    title: "Cut",
    blurb:
      "Fix the detected scene cuts first — every later step maps depth per scene, so wrong cuts mean wrong 3D. Cut lists import/export as PySceneDetect-style CSV.",
    price: "Free",
  },
  {
    tab: "depth",
    n: 2,
    title: "Depth",
    blurb:
      "Define the depth map — resolution is the cost/quality knob; production reuses the artifact when it matches.",
    price: "Paid",
  },
  {
    tab: "stereo",
    n: 3,
    title: "Stereo",
    blurb:
      "Per-scene 3D strength and shot type, seeded from the profiler — preview what you deliver.",
    price: "Paid",
  },
  {
    tab: "deliver",
    n: 4,
    title: "Deliver",
    blurb:
      "Full-quality production run. Compatible preview artifacts are reused and discounted automatically.",
    price: "Paid",
  },
];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="text-right font-mono text-xs">{children}</dd>
    </div>
  );
}

/** The How-it-works pipeline guide, deep-linking into the other pages —
 * the ⓘ Guide drawer's body (formerly a card on the page). */
function GuideList({
  onNavigate,
}: {
  onNavigate: (tab: WorkspaceTabId) => void;
}): JSX.Element {
  return (
    <>
      <ol className="flex flex-col gap-3">
        {GUIDE.map((g) => (
          <li key={g.tab} className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-2 font-mono text-[10px] text-fg-muted"
            >
              {g.n}
            </span>
            <div className="min-w-0 flex-1 text-xs">
              <button
                type="button"
                onClick={() => onNavigate(g.tab)}
                className="font-medium text-fg hover:text-primary"
              >
                {g.title} →
              </button>
              <Badge
                variant={g.price === "Free" ? "outline" : "secondary"}
                className={`ml-2 h-4 px-1.5 text-[10px] ${
                  g.price === "Free"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "text-fg-muted"
                }`}
              >
                {g.price}
              </Badge>
              <p className="mt-0.5 text-fg-muted">{g.blurb}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-3 border-t border-edge pt-3 text-[11px] text-fg-muted">
        Previews are optional — you can go straight to Deliver. Every paid
        step shows an exact quote before checkout.
      </p>
    </>
  );
}

export interface MediaTabProps {
  project: Project;
  onNavigate: (tab: WorkspaceTabId) => void;
}

export function MediaTab({ project, onNavigate }: MediaTabProps): JSX.Element {
  const { probe, scenes } = project;
  const fps = useMemo(
    () => (probe ? parseRational(probe.fps_rational) : null),
    [probe],
  );

  // Minimal self-contained transport (the editable one lives on Cut).
  const numFrames = probe?.num_frames ?? 1;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const playheadRef = useRef(0);
  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);
  const onFrame = useCallback(
    (f: number) => setPlayhead(clampFrame(f, numFrames)),
    [numFrames],
  );
  const player = usePreviewPlayer(
    videoRef,
    fps ?? { num: 24, den: 1 },
    onFrame,
  );
  const step = useCallback(
    (delta: number) => {
      player.pause();
      const f = clampFrame(playheadRef.current + delta, numFrames);
      setPlayhead(f);
      player.seekToFrame(f);
    },
    [numFrames, player],
  );
  /** Timeline click-scrub: pause, then frame-exact seek (read-only page —
   * scrubbing is inspection, not transport, so it always parks). */
  const scrub = useCallback(
    (frame: number) => {
      player.pause();
      const f = clampFrame(frame, numFrames);
      setPlayhead(f);
      player.seekToFrame(f);
    },
    [numFrames, player],
  );

  // Shared transport keys (the SAME hook the Cut page uses): Space
  // play/pause, ←/→ ±1 frame, Shift ±1 s.
  const secondFrames = fps ? Math.max(1, Math.round(fps.num / fps.den)) : 1;
  usePlayerShortcuts({ toggle: player.toggle, step, secondFrames });

  return (
    <div data-testid="media-tab" className="space-y-4">
      <PageHeader
        title="Media"
        description="The source at a glance — frame-exact preview, read-only timeline, probe details. All editing lives on the Cut page."
        actions={
          <Drawer direction="right">
            <DrawerTrigger asChild>
              <Button
                variant="outline"
                size="xs"
                data-testid="media-guide-button"
              >
                ⓘ Guide
              </Button>
            </DrawerTrigger>
            <DrawerContent
              data-testid="media-guide-drawer"
              aria-label="How this pipeline works"
              aria-describedby={undefined}
              className="data-[vaul-drawer-direction=right]:w-96 data-[vaul-drawer-direction=right]:max-w-[90vw] data-[vaul-drawer-direction=right]:sm:max-w-[90vw]"
            >
              <DrawerHeader className="flex-row items-center justify-between">
                <DrawerTitle className="text-sm font-semibold">
                  How this works
                </DrawerTitle>
                <DrawerClose asChild>
                  <Button variant="ghost" size="xs" aria-label="Close guide">
                    ×
                  </Button>
                </DrawerClose>
              </DrawerHeader>
              <div className="overflow-y-auto px-4 pb-4">
                <GuideList onNavigate={onNavigate} />
              </div>
            </DrawerContent>
          </Drawer>
        }
      />

      <div className="min-w-0">
        {probe && fps ? (
          <div className="space-y-4">
            <PreviewViewer
              probe={probe}
              fps={fps}
              playhead={playhead}
              previewUrl={project.preview_url}
              thumbs={project.strip_thumbs ?? []}
              crop={project.crop}
              player={player}
              videoRef={videoRef}
              onStep={step}
            />
            <FilmstripTimeline
              readOnly
              thumbs={project.strip_thumbs ?? []}
              numFrames={numFrames}
              fps={fps}
              playhead={playhead}
              previewUrl={project.preview_url}
              aspect={probe.width / probe.height}
              onScrub={scrub}
            />
          </div>
        ) : (
          <div
            data-testid="analyzing-state"
            className="flex items-center gap-3 rounded-md border border-edge bg-surface-1 p-6 text-fg-muted"
          >
            {project.analyze.state === "running" ? (
              <>
                <span
                  aria-hidden
                  className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent"
                />
                <div className="min-w-0 flex-1">
                  <AnalyzeProgress analyze={project.analyze} />
                  <p className="mt-1 text-sm">
                    The source preview appears here once analysis finishes.
                    This page refreshes automatically.
                  </p>
                </div>
              </>
            ) : (
              <p>The source preview appears here once analysis finishes.</p>
            )}
          </div>
        )}
      </div>

      <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
              Source
            </CardTitle>
          </CardHeader>
          <CardContent>
          {probe && fps ? (
            <dl className="flex flex-col gap-1.5 text-xs">
              <Row label="Resolution">
                {probe.width}×{probe.height}
              </Row>
              <Row label="Frame rate">
                {probe.fps_rational}{" "}
                <span className="text-fg-muted">
                  (~{(fps.num / fps.den).toFixed(3)})
                </span>
              </Row>
              <Row label="Duration">{frameToTimecode(numFrames, fps)}</Row>
              <Row label="Frames">{numFrames}</Row>
              <Row label="File size">{formatBytes(project.source_bytes)}</Row>
              {project.crop ? (
                <Row label="Active picture">{project.crop.split(":").slice(0, 2).join("×")}</Row>
              ) : null}
              {scenes ? (
                <Row label="Scene cuts">
                  {scenes.cuts.length}{" "}
                  <span className="text-fg-muted">
                    ({scenes.edited ? "edited" : "auto"} · v{scenes.version})
                  </span>
                </Row>
              ) : null}
            </dl>
          ) : (
            <p className="text-xs text-fg-muted">
              Analyzing — probing the video, detecting scene cuts and crop,
              rendering thumbnails.
            </p>
          )}
          </CardContent>
        </Card>

        {project.analyze.credit_available ? (
          <Card
            size="sm"
            className="bg-emerald-500/10 text-xs text-emerald-300 ring-emerald-500/30"
          >
            <CardContent>
              <span className="font-medium">
                {formatCents(project.analyze.credit_cents)} analyze credit
              </span>{" "}
              — the free analysis is credited against this project&apos;s
              first paid conversion.
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
