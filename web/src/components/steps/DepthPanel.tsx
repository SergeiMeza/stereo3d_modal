"use client";

/**
 * Depth page (step depth_preview) — "define the depth map".
 *
 * The only knobs that matter here are the depth-map RESOLUTION (the
 * cost/quality axis — production inherits it via artifact reuse, so running
 * depth once at the final resolution makes the production quote discount
 * the whole depth stage) and the PREVIEW frame rate (reuse keys on fps: a
 * production run at a different fps re-runs depth). No displacement, no
 * preset, no formats — those belong to the Stereo and Deliver pages.
 *
 * Layout mirrors the Cut tab: a frame-exact source PREVIEW (usePreviewPlayer
 * over the project proxy) sits up top with Space/←/→ transport; below it a
 * SCENE GRID (thumbnail cards, one per cut range) navigates the preview and
 * carries the per-scene "Convert to 3D" toggle from the SHARED stereo draft
 * store (2D passthrough — affects stereo_preview/production only; depth
 * previews always render the full depth map). When a depth run has succeeded,
 * the source-vs-depth compare (DepthCompare) renders INLINE directly under the
 * preview, synced by fraction of duration (the depth video runs at its own
 * fps — frame doctrine applies only to the source proxy, never derived
 * outputs).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PreviewViewer } from "@/components/workspace/PreviewViewer";
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
import { PriorRuns } from "./PriorRuns";
import { MuteToggle, ScenePicker, SpeedSelect } from "./ScenePicker";
import {
  sceneRangesForPlayback,
  useScenePlayback,
  type SceneRange,
} from "./useScenePlayback";
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

  const depthRuns = (project.conversions ?? []).filter(
    (c) => c.step === "depth_preview",
  );
  const lastSucceeded = depthRuns
    .filter((c) => c.state === "succeeded")
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
      <DepthPreview
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
                  The cost/quality knob, and what production inherits: run depth
                  once at your final resolution and the production quote
                  discounts the whole depth stage when fps and resolution match.
                  Capped at the source resolution — you can&apos;t add detail
                  the source doesn&apos;t have.
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
                  Defaults to the source rate. Honest caveat: depth reuse keys
                  on fps — a production run at a different rate re-runs the depth
                  stage at full price.
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
          <StepCheckoutSection checkout={ck} request={request} />
        </CardContent>
      </Card>

      <PriorRuns
        title="Prior depth runs"
        conversions={depthRuns}
        meta={(c) =>
          [
            c.params.depth_res !== undefined ? `depth ${c.params.depth_res}` : null,
            c.params.target_fps !== undefined ? `${c.params.target_fps} fps` : null,
          ]
            .filter(Boolean)
            .join(" · ") || c.params.preset
        }
      />
    </PanelShell>
  );
}

/** Page frame: the preview/grid + params + prior runs stack, full width. The
 * page title/description live in the shared PageHeader (StepTab). */
function PanelShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div data-testid="depth-panel" className="flex flex-col gap-6">
      {children}
    </div>
  );
}

/**
 * Cut-style review area: the frame-exact source PREVIEW, the source-vs-depth
 * compare (inline, when a run succeeded), and the SCENE GRID with per-scene 3D
 * toggles. The preview playhead drives the grid highlight; clicking a scene
 * card seeks the preview to that scene's first frame.
 */
function DepthPreview({
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

  // Frame-exact preview player over the project proxy — same hook the Cut tab
  // uses. The playhead follows the video while playing; scene-card clicks seek.
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

  return (
    <div className="flex flex-col gap-4">
      <PreviewViewer
        probe={probe}
        fps={sourceFps}
        playhead={playhead}
        previewUrl={project.preview_url}
        thumbs={project.strip_thumbs ?? []}
        player={player}
        videoRef={videoRef}
        onStep={step}
      />

      {lastSucceeded ? (
        <DepthResult project={project} conversion={lastSucceeded} />
      ) : null}

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
    </div>
  );
}

/**
 * Scene grid — thumbnail cards tiling the cut list (cutsToRanges: half-open
 * ranges over [0, numFrames)). Clicking a card seeks the preview to the
 * scene's first frame; the scene containing the playhead is highlighted. Each
 * card carries the per-scene "3D" toggle (shared stereo-draft passthrough):
 * unchecked scenes ship as 2D on Stereo/Deliver runs. Same card visuals as the
 * Cut tab's SceneList, plus the toggle overlay.
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

  return (
    <section aria-label="Scenes" className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
        Scenes · convert to 3D
      </h3>
      <p className="text-xs text-fg-muted">
        Click a scene to jump the preview there. Unchecked scenes ship as 2D
        passthrough on Stereo and Deliver runs (both eyes identical) — for end
        credits, logos, title cards. Depth previews always render the full depth
        map regardless.
      </p>
      <div
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

/** The newest succeeded run's depth map compared against the source proxy.
 * Fetches the run's signed download links to find depth_vis; falls back
 * gracefully (message, no players) when the run didn't produce one. */
function DepthResult({
  project,
  conversion,
}: {
  project: Project;
  conversion: Conversion;
}): JSX.Element | null {
  const client = useGateway();
  const id = conversion.conversion_id;
  const [fetched, setFetched] = useState<{
    id: string;
    depthVis: string | null;
  } | null>(null);

  useEffect(() => {
    if (fetched?.id === id) return;
    let cancelled = false;
    client
      .getDownloads(id)
      .then((d) => {
        if (!cancelled) setFetched({ id, depthVis: d.downloads.depth_vis ?? null });
      })
      .catch(() => {
        if (!cancelled) setFetched({ id, depthVis: null });
      });
    return () => {
      cancelled = true;
    };
  }, [client, id, fetched]);

  if (fetched?.id !== id) return null;
  if (fetched.depthVis === null) {
    return (
      <p data-testid="depth-compare-missing" className="text-xs text-fg-muted">
        The last depth run has no browser-playable depth video (depth_vis) —
        the raw depth output is under its downloads.
      </p>
    );
  }
  return (
    <DepthCompare
      sourceUrl={project.preview_url}
      depthUrl={fetched.depthVis}
      scenes={sceneRangesForPlayback(project)}
      fps={parseRational(project.probe!.fps_rational)}
      // The Depth tab's main PreviewViewer owns the Space transport; a second
      // window-level Space handler here would toggle both players at once.
      keyboardShortcuts={false}
    />
  );
}

/** Side-by-side source/depth players with one transport. The depth video is
 * a DERIVED artifact at its own fps — never frame-math it; the follower
 * tracks the source by fraction of duration on timeupdate. Scene playback
 * binds to the MASTER (the source proxy; the depth video when there is no
 * proxy — decimated but wall-clock-identical, so source-time bounds hold). */
export function DepthCompare({
  sourceUrl,
  depthUrl,
  scenes,
  fps,
  keyboardShortcuts = true,
}: {
  sourceUrl?: string;
  depthUrl: string;
  scenes: SceneRange[];
  fps: RationalFPS;
  /** Bind Space → play/pause on this transport. Set false when a sibling
   * player (the Depth tab's main preview) already owns the window-level key. */
  keyboardShortcuts?: boolean;
}): JSX.Element {
  const srcRef = useRef<HTMLVideoElement | null>(null);
  const depRef = useRef<HTMLVideoElement | null>(null);
  const masterRef = sourceUrl ? srcRef : depRef; // stable: the url never toggles while mounted
  const playback = useScenePlayback(masterRef, scenes, fps);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(true);
  // Decoded sizes for the corner badges (read at loadedmetadata).
  const [srcDims, setSrcDims] = useState<VideoDims | null>(null);
  const [depDims, setDepDims] = useState<VideoDims | null>(null);

  /** BOTH players share the rate — the fraction-sync would fight a follower
   * running at a different speed. */
  function changeRate(r: number): void {
    setRate(r);
    if (srcRef.current) srcRef.current.playbackRate = r;
    if (depRef.current) depRef.current.playbackRate = r;
  }

  /** Only the MASTER gets sound (the source proxy carries the audio track);
   * the depth_vis follower must STAY muted or the pair would double-play. */
  function changeMuted(m: boolean): void {
    setMuted(m);
    if (masterRef.current) masterRef.current.muted = m;
  }

  function toggle(): void {
    const s = srcRef.current;
    const d = depRef.current;
    if (playing) {
      s?.pause();
      d?.pause();
      setPlaying(false);
    } else {
      void s?.play();
      void d?.play();
      setPlaying(true);
    }
  }

  /** Sync the depth follower to the source's fraction of duration. */
  function syncFollower(): void {
    const s = srcRef.current;
    const d = depRef.current;
    if (!s || !d || !s.duration || !d.duration) return;
    const target = (s.currentTime / s.duration) * d.duration;
    // small tolerance so playback isn't stuttered by constant micro-seeks
    if (Math.abs(d.currentTime - target) > 0.15) d.currentTime = target;
  }

  /** Master timeupdate: loop inside the selected scene FIRST, then the
   * follower tracks the (possibly looped-back) master time. */
  function onSourceTimeUpdate(): void {
    playback.onTimeUpdate();
    syncFollower();
  }

  // Space = play/pause, same shared hook as the Media/Cut transports (no
  // frame stepping here — the outputs are decimated; frame keys are for
  // the frame-exact proxy pages only). Suppressed when a sibling preview
  // already owns the window-level Space handler (see keyboardShortcuts).
  usePlayerShortcuts({ toggle: keyboardShortcuts ? toggle : () => {} });

  return (
    <div data-testid="depth-compare" className="flex flex-col gap-2">
      {/* Transport row — same visual system as the workspace PreviewViewer:
          outline xs ui/button shapes + the shared SpeedSelect. */}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
          Depth vs source
        </h3>
        <Button
          variant="outline"
          size="xs"
          className="w-20"
          aria-label={playing ? "Pause comparison" : "Play comparison"}
          onClick={(e) => {
            blurAfterMouseClick(e);
            toggle();
          }}
        >
          {playing ? "❚❚ Pause" : "▶ Play"}
        </Button>
        <ScenePicker id="depth-scene" playback={playback} />
        <SpeedSelect id="depth-speed" value={rate} onChange={changeRate} />
        <MuteToggle muted={muted} onChange={changeMuted} />
        <span className="ml-auto text-xs text-fg-muted">Space play/pause</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {sourceUrl ? (
          <div className="relative">
            <video
              ref={srcRef}
              src={sourceUrl}
              muted
              onTimeUpdate={onSourceTimeUpdate}
              // paused scene picks fire seeked (not timeupdate) — the
              // follower must track those too, or it shows the OLD frame
              // until playback starts
              onSeeked={syncFollower}
              onLoadedMetadata={(e) => {
                playback.onLoadedMetadata();
                setSrcDims(videoDims(e));
              }}
              preload="metadata"
              data-testid="depth-compare-source"
              className="w-full rounded-md border border-edge bg-black"
            />
            <PlayerBadge
              data-testid="depth-compare-source-badge"
              label="source proxy"
              dims={srcDims}
            />
          </div>
        ) : (
          <p className="self-center text-xs text-fg-muted">
            No source proxy available for comparison.
          </p>
        )}
        <div className="relative">
          <video
            ref={depRef}
            src={depthUrl}
            muted
            onTimeUpdate={sourceUrl ? undefined : playback.onTimeUpdate}
            onLoadedMetadata={(e) => {
              if (!sourceUrl) playback.onLoadedMetadata();
              setDepDims(videoDims(e));
            }}
            preload="metadata"
            data-testid="depth-compare-depth"
            className="w-full rounded-md border border-edge bg-black"
          />
          <PlayerBadge
            data-testid="depth-compare-depth-badge"
            label="depth_vis"
            dims={depDims}
          />
        </div>
      </div>
    </div>
  );
}
