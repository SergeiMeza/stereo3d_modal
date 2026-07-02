"use client";

/**
 * Depth page (step depth_preview) — "define the depth map".
 *
 * The only knobs that matter here are the depth-map RESOLUTION (the
 * cost/quality axis — production inherits it via artifact reuse) and the
 * PREVIEW frame rate (reuse keys on fps). No displacement, no preset, no
 * formats — those belong to the Stereo and Deliver pages.
 *
 * Layout mirrors the Cut tab: ONE frame-exact source preview up top
 * (usePreviewPlayer over the project proxy, Space/←/→ transport), a
 * FilmstripTimeline for scrubbing, and the scene grid (auto-scrolling the
 * active scene to the top while playing, like Cut). When a depth run has
 * succeeded, its depth_vis renders BESIDE the main preview as a follower of
 * the SAME transport: play/pause/seek/speed mirror the master video's
 * element events, position syncs by fraction of duration (the depth video
 * runs at its own fps — frame doctrine applies only to the source proxy,
 * never derived outputs).
 *
 * Depth-map export/import (the Cut tab's cuts-CSV pattern, applied to the
 * depth artifact): Export downloads the run's RAW full-precision depth file
 * (the `depth` output the later steps consume — an explanatory dialog makes
 * clear it is NOT the 8-bit depth_vis preview); Import loads a local depth
 * video into the compare slot as a review aid (nothing is uploaded).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode, RefObject } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FilmstripTimeline } from "@/components/workspace/FilmstripTimeline";
import { PreviewViewer } from "@/components/workspace/PreviewViewer";
import { useScrollActiveSceneToTop } from "@/components/workspace/SceneList";
import { usePlayerShortcuts } from "@/components/workspace/usePlayerShortcuts";
import { usePreviewPlayer } from "@/components/workspace/usePreviewPlayer";
import { clampFrame } from "@/components/workspace/utils";
import type { Conversion, Project, StepConversionRequest } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import {
  clampDepthRes,
  DEFAULT_DEPTH_RES,
  depthResChoices,
  depthResLabel,
} from "@/lib/depthRes";
import {
  cutsToRanges,
  defaultPreviewFPS,
  fpsOptions,
  frameToTimecode,
  parseRational,
  type RationalFPS,
} from "@/lib/frames";
import { blurAfterMouseClick } from "@/lib/interactions";

import { Field, selectClass } from "./controls";
import { setRowPassthrough, useStereoDraft } from "./stereoStore";
import { PlayerBadge, videoDims, type VideoDims } from "./PlayerBadge";
import { StepCheckoutSection, useStepCheckout } from "./useStepCheckout";

export { DEFAULT_DEPTH_RES };

export interface DepthPanelProps {
  project: Project;
  onProjectChanged: () => void;
}

export function DepthPanel({
  project,
  onProjectChanged,
}: DepthPanelProps): JSX.Element {
  const ck = useStepCheckout(project, onProjectChanged);
  // SAME draft the Stereo page edits (shared localStorage key): the scene
  // grid below flips per-scene 2D passthrough in it.
  const [draft, setDraft] = useStereoDraft(
    project.project_id,
    project.scenes?.version ?? 0,
  );

  const sourceFps =
    project.analyze.state === "succeeded" && project.probe
      ? parseRational(project.probe.fps_rational)
      : null;

  // depth_res can never exceed the SOURCE short side (see lib/depthRes).
  const shortSide = project.probe
    ? Math.min(project.probe.width, project.probe.height)
    : DEFAULT_DEPTH_RES;
  const resChoices = depthResChoices(shortSide);
  const [depthRes, setDepthRes] = useState(() =>
    clampDepthRes(DEFAULT_DEPTH_RES, resChoices),
  );
  const [targetFps, setTargetFps] = useState<number | undefined>(undefined);

  const lastSucceeded = (project.conversions ?? [])
    .filter((c) => c.step === "depth_preview" && c.state === "succeeded")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] as
    | Conversion
    | undefined;

  if (sourceFps === null || !project.probe) {
    return (
      <PanelShell>
        <p className="text-sm text-fg-muted">
          Analysis is still running — quotes unlock when it finishes.
        </p>
      </PanelShell>
    );
  }

  const fps = targetFps ?? defaultPreviewFPS(sourceFps).value;
  const request: StepConversionRequest = {
    step: "depth_preview",
    depth_res: depthRes,
    target_fps: fps,
    platform: "web",
  };

  return (
    <PanelShell>
      <DepthReview
        project={project}
        sourceFps={sourceFps}
        lastSucceeded={lastSucceeded}
        draft={draft}
        setDraft={setDraft}
      />

      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="depth-res"
              label="Depth-map resolution"
              hint={
                <>
                  The cost/quality knob. Production inherits it: run depth once
                  at your final resolution and the production quote discounts
                  the whole depth stage. Capped at the source resolution.
                </>
              }
            >
              <select
                id="depth-res"
                value={depthRes}
                onChange={(e) => {
                  setDepthRes(Number(e.target.value));
                  ck.invalidate();
                }}
                className={selectClass}
              >
                {resChoices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {depthResLabel(c)}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              id="depth-fps"
              label="Preview frame rate"
              hint={
                <>
                  Defaults to the source rate. Depth reuse keys on fps — a
                  production run at a different rate re-runs the depth stage at
                  full price.
                </>
              }
            >
              <select
                id="depth-fps"
                value={fps}
                onChange={(e) => {
                  setTargetFps(Number(e.target.value));
                  ck.invalidate();
                }}
                className={selectClass}
              >
                {fpsOptions(sourceFps).map((o) => (
                  <option key={o.divisor} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <StepCheckoutSection
            checkout={ck}
            request={request}
            trackerDownloads={false}
          />
        </CardContent>
      </Card>
    </PanelShell>
  );
}

/** Page frame: the review area + params stack, full width. The page
 * title/description live in the shared PageHeader (StepTab). */
function PanelShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div data-testid="depth-panel" className="flex flex-col gap-6">
      {children}
    </div>
  );
}

/** The latest succeeded run's signed depth links: the browser-playable
 * depth_vis and the raw full-precision depth file (for Export). */
function useDepthDownloads(
  conversion: Conversion | undefined,
): { depthVis: string | null; depthRaw: string | null } | null {
  const client = useGateway();
  const id = conversion?.conversion_id ?? null;
  const [fetched, setFetched] = useState<{
    id: string;
    depthVis: string | null;
    depthRaw: string | null;
  } | null>(null);

  useEffect(() => {
    if (id === null || fetched?.id === id) return;
    let cancelled = false;
    client
      .getDownloads(id)
      .then((d) => {
        if (cancelled) return;
        setFetched({
          id,
          depthVis: d.downloads.depth_vis ?? null,
          depthRaw: d.downloads.depth ?? null,
        });
      })
      .catch(() => {
        if (!cancelled) setFetched({ id, depthVis: null, depthRaw: null });
      });
    return () => {
      cancelled = true;
    };
  }, [client, id, fetched]);

  return id !== null && fetched?.id === id ? fetched : null;
}

/**
 * Keep the depth <video> a strict FOLLOWER of the master preview video, off
 * the master's own element events (so every transport path — buttons, Space,
 * timeline scrubs, scene-card jumps — is covered without extra wiring):
 * play/pause/ratechange mirror; seeked/timeupdate sync the position by
 * FRACTION of duration (the depth video is a derived artifact at its own
 * fps — never frame-math it). The follower stays muted (audio belongs to
 * the master).
 */
function useFollowerVideo(
  masterRef: RefObject<HTMLVideoElement | null>,
  followerRef: RefObject<HTMLVideoElement | null>,
  url: string | null,
): void {
  useEffect(() => {
    const m = masterRef.current;
    const f = followerRef.current;
    if (!m || !f || url === null) return;

    const sync = () => {
      if (!m.duration || !f.duration) return;
      const target = (m.currentTime / m.duration) * f.duration;
      // small tolerance so playback isn't stuttered by constant micro-seeks
      if (Math.abs(f.currentTime - target) > 0.15) f.currentTime = target;
    };
    const onPlay = () => {
      f.playbackRate = m.playbackRate;
      const p = f.play();
      if (p instanceof Promise) p.catch(() => {});
    };
    const onPause = () => {
      f.pause();
      sync();
    };
    const onRate = () => {
      f.playbackRate = m.playbackRate;
    };

    m.addEventListener("play", onPlay);
    m.addEventListener("pause", onPause);
    m.addEventListener("seeked", sync);
    m.addEventListener("timeupdate", sync);
    m.addEventListener("ratechange", onRate);
    // durations arrive asynchronously — sync once the follower has one
    f.addEventListener("loadedmetadata", sync);

    // Adopt the master's CURRENT state (it may already be playing when the
    // first depth run lands, or when an import swaps the follower element).
    f.muted = true;
    onRate();
    sync();
    if (!m.paused) onPlay();

    return () => {
      m.removeEventListener("play", onPlay);
      m.removeEventListener("pause", onPause);
      m.removeEventListener("seeked", sync);
      m.removeEventListener("timeupdate", sync);
      m.removeEventListener("ratechange", onRate);
      f.removeEventListener("loadedmetadata", sync);
      f.pause();
    };
  }, [masterRef, followerRef, url]);
}

/**
 * Cut-style review area with ONE transport: the frame-exact source preview
 * (master), the depth map beside it (follower, when available), the
 * timeline, and the scene grid with per-scene 3D toggles. Also owns the
 * depth-map Export (raw 10-bit file, behind an explanatory dialog) and
 * Import (local review file) actions.
 */
function DepthReview({
  project,
  sourceFps,
  lastSucceeded,
  draft,
  setDraft,
}: {
  project: Project;
  sourceFps: RationalFPS;
  lastSucceeded: Conversion | undefined;
  draft: ReturnType<typeof useStereoDraft>[0];
  setDraft: ReturnType<typeof useStereoDraft>[1];
}): JSX.Element {
  const probe = project.probe!;
  const numFrames = probe.num_frames;

  // Frame-exact preview player over the project proxy — same hook the Cut
  // tab uses. The playhead drives the timeline and the scene highlight.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const handleVideoFrame = useCallback(
    (frame: number) => setPlayhead(clampFrame(frame, numFrames)),
    [numFrames],
  );
  const player = usePreviewPlayer(videoRef, sourceFps, handleVideoFrame);

  const scrub = useCallback(
    (frame: number) => {
      const f = clampFrame(frame, numFrames);
      setPlayhead(f);
      player.seekToFrame(f);
    },
    [numFrames, player],
  );
  const step = useCallback(
    (delta: number) => {
      player.pause();
      const f = clampFrame(playhead + delta, numFrames);
      setPlayhead(f);
      player.seekToFrame(f);
    },
    [numFrames, player, playhead],
  );

  const secondFrames = Math.max(1, Math.round(sourceFps.num / sourceFps.den));
  usePlayerShortcuts({ toggle: player.toggle, step, secondFrames });

  // ------------------------------------------------ depth map beside source
  const downloads = useDepthDownloads(lastSucceeded);
  // Locally imported depth video (object URL) — overrides the run's
  // depth_vis in the compare slot. Review aid only; nothing is uploaded.
  const [imported, setImported] = useState<{ name: string; url: string } | null>(
    null,
  );
  const importedRef = useRef(imported);
  useEffect(() => {
    importedRef.current = imported;
  }, [imported]);
  useEffect(
    () => () => {
      if (importedRef.current) URL.revokeObjectURL(importedRef.current.url);
    },
    [],
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function importDepthFile(file: File): void {
    const url = URL.createObjectURL(file);
    setImported((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { name: file.name, url };
    });
  }
  function clearImported(): void {
    setImported((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  }

  const depthUrl = imported?.url ?? downloads?.depthVis ?? null;
  const depthRef = useRef<HTMLVideoElement | null>(null);
  useFollowerVideo(videoRef, depthRef, depthUrl);
  const [depthDims, setDepthDims] = useState<VideoDims | null>(null);

  const [exportOpen, setExportOpen] = useState(false);
  const exportUrl = downloads?.depthRaw ?? null;

  const aside =
    depthUrl !== null ? (
      <div
        className="relative w-full overflow-hidden rounded-md border border-edge bg-black"
        style={{ aspectRatio: `${probe.width} / ${probe.height}` }}
      >
        <video
          ref={depthRef}
          key={depthUrl}
          src={depthUrl}
          muted
          playsInline
          preload="auto"
          data-testid="depth-video"
          onLoadedMetadata={(e) => setDepthDims(videoDims(e))}
          className="absolute inset-0 h-full w-full select-none object-contain"
        />
        <PlayerBadge
          data-testid="depth-video-badge"
          label={imported ? "imported depth" : "depth_vis"}
          dims={depthDims}
          title={
            imported
              ? `Local file ${imported.name} — shown for review only, nothing is uploaded`
              : "The run's 8-bit depth visualization — Export gives the raw full-precision file"
          }
        />
      </div>
    ) : lastSucceeded && downloads !== null ? (
      <div
        data-testid="depth-video-missing"
        className="flex w-full items-center justify-center rounded-md border border-edge bg-surface-1 p-4 text-center text-xs text-fg-muted"
        style={{ aspectRatio: `${probe.width} / ${probe.height}` }}
      >
        The last depth run has no browser-playable depth video (depth_vis) —
        export the raw depth file instead.
      </div>
    ) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex min-h-6 flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
          Depth map
        </h3>
        {imported ? (
          <span
            data-testid="imported-depth-note"
            className="flex items-center gap-1 text-[11px] text-fg-muted"
          >
            <span className="max-w-48 truncate font-mono">{imported.name}</span>
            (local review only)
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear imported depth map"
              className="text-fg-muted hover:text-fg"
              onClick={(e) => {
                blurAfterMouseClick(e);
                clearImported();
              }}
            >
              ×
            </Button>
          </span>
        ) : depthUrl === null && aside === null ? (
          <span className="text-[11px] text-fg-muted">
            Run a depth preview to see the depth map beside the source.
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            aria-label="Depth map file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = ""; // re-picking the same file must re-fire
              if (file) importDepthFile(file);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            title="Preview a local depth video beside the source (review aid — nothing is uploaded)"
            onClick={(e) => {
              blurAfterMouseClick(e);
              fileInputRef.current?.click();
            }}
          >
            Import depth map…
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={exportUrl === null}
            title={
              exportUrl === null
                ? "Run a depth preview first — export downloads its raw depth file"
                : "Download the raw full-precision depth file from the latest run"
            }
            onClick={(e) => {
              blurAfterMouseClick(e);
              setExportOpen(true);
            }}
          >
            Export depth map
          </Button>
        </div>
      </div>

      <PreviewViewer
        probe={probe}
        fps={sourceFps}
        playhead={playhead}
        previewUrl={project.preview_url}
        thumbs={project.strip_thumbs ?? []}
        player={player}
        videoRef={videoRef}
        onStep={step}
        aside={aside}
      />

      <FilmstripTimeline
        readOnly
        thumbs={project.strip_thumbs ?? []}
        numFrames={numFrames}
        fps={sourceFps}
        playhead={playhead}
        cuts={project.scenes?.cuts ?? []}
        previewUrl={project.preview_url}
        aspect={probe.width / probe.height}
        onScrub={scrub}
      />

      {project.scenes ? (
        <DepthSceneGrid
          cuts={project.scenes.cuts}
          numFrames={numFrames}
          fps={sourceFps}
          sceneThumbs={project.scene_thumbs ?? []}
          playhead={playhead}
          draft={draft}
          setDraft={setDraft}
          onSelectScene={scrub}
        />
      ) : null}

      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent data-testid="export-depth-dialog">
          <DialogHeader>
            <DialogTitle>Export depth map</DialogTitle>
            <DialogDescription>
              This downloads the raw <span className="font-mono">depth</span>{" "}
              file from the latest run — the full-precision 10-bit depth map
              the later steps consume, not the 8-bit{" "}
              <span className="font-mono">depth_vis</span> preview playing on
              this page. It may look flat or black in ordinary players; that is
              expected for high-bit-depth grayscale.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button asChild>
              <a
                href={exportUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
                download
                data-testid="export-depth-link"
                onClick={() => setExportOpen(false)}
              >
                Download 10-bit depth
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Scene grid — thumbnail cards tiling the cut list (cutsToRanges: half-open
 * ranges over [0, numFrames)), same visuals as the Cut tab's SceneList and
 * the same follow-the-playhead scrolling (the active scene scrolls to the
 * top while playing). Clicking a card seeks the preview to the scene's first
 * frame. Each card carries the per-scene "3D" toggle (shared stereo-draft
 * passthrough): unchecked scenes ship as 2D on Stereo/Deliver runs.
 */
function DepthSceneGrid({
  cuts,
  numFrames,
  fps,
  sceneThumbs,
  playhead,
  draft,
  setDraft,
  onSelectScene,
}: {
  cuts: number[];
  numFrames: number;
  fps: RationalFPS;
  sceneThumbs: Project["scene_thumbs"];
  playhead: number;
  draft: ReturnType<typeof useStereoDraft>[0];
  setDraft: ReturnType<typeof useStereoDraft>[1];
  onSelectScene: (startFrame: number) => void;
}): JSX.Element {
  const ranges = cutsToRanges(cuts, numFrames);
  const thumbs = sceneThumbs ?? [];

  const scrollRef = useRef<HTMLDivElement>(null);
  const activeStart = ranges.find(
    ([start, end]) => playhead >= start && playhead < end,
  )?.[0];
  useScrollActiveSceneToTop(scrollRef, activeStart);

  return (
    <section aria-label="Scenes" className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
        Scenes · convert to 3D
      </h3>
      <p className="text-xs text-fg-muted">
        Unchecked scenes ship as 2D on Stereo and Deliver runs (end credits,
        logos). Depth previews always render the full depth map regardless.
      </p>
      <div
        ref={scrollRef}
        data-testid="depth-scenes"
        className="grid max-h-[36rem] grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2 overflow-y-auto pr-1"
      >
        {ranges.map(([start, end], i) => {
          const active = playhead >= start && playhead < end;
          const passthrough = draft.overrides[start]?.passthrough === true;
          const thumb = thumbs.find((t) => t.frame >= start && t.frame < end);
          return (
            <div
              key={`${start}-${end}`}
              data-testid={`depth-scene-${start}`}
              className={`relative ${passthrough ? "opacity-60" : ""}`}
            >
              <button
                type="button"
                data-testid="scene-card"
                data-start={start}
                data-end={end}
                aria-current={active ? "true" : undefined}
                onClick={(e) => {
                  blurAfterMouseClick(e);
                  onSelectScene(start);
                }}
                className={`w-full rounded-md border p-1.5 text-left transition-colors ${
                  active
                    ? "border-primary bg-surface-2 ring-1 ring-primary"
                    : "border-edge bg-surface-1 hover:bg-surface-2"
                }`}
              >
                <div className="mb-1 aspect-video w-full overflow-hidden rounded bg-black">
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element -- signed GCS thumbnail URLs.
                    <img
                      src={thumb.url}
                      alt={`scene ${i + 1} keyframe`}
                      draggable={false}
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-fg">Scene {i + 1}</span>
                  <span className="font-mono text-[11px] text-fg-muted">
                    f{start}–f{end}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-fg-muted">
                  {frameToTimecode(start, fps)}
                </div>
              </button>
              {/* 3D toggle — SIBLING of the card button (nested buttons are
                  invalid HTML), overlaid top-right. */}
              <label className="absolute top-2.5 right-2.5 z-10 flex cursor-pointer items-center gap-1 rounded border border-edge bg-black/60 px-1.5 py-0.5 text-[10px] hover:bg-black/80">
                <input
                  type="checkbox"
                  aria-label={`Scene ${i + 1} convert to 3D`}
                  checked={!passthrough}
                  onChange={(e) =>
                    setDraft((d) =>
                      setRowPassthrough(d, start, !e.target.checked),
                    )
                  }
                  className="accent-primary"
                />
                <span>3D</span>
              </label>
            </div>
          );
        })}
      </div>
    </section>
  );
}
