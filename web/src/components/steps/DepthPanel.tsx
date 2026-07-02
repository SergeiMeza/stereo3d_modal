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
 * After a run succeeds, the browser-playable depth_vis output plays NEXT TO
 * the source proxy with a shared transport, theater-wide ABOVE the params
 * card. The follower is synced by FRACTION of duration on timeupdate — the
 * depth video may run at a different fps, and the frame doctrine (integer
 * source-frame indices) applies only to the source player, never to derived
 * outputs. A ScenePicker scopes review to one scene at a time: it drives
 * the MASTER player (loop in source-time bounds); the follower just tracks.
 */

import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { usePlayerShortcuts } from "@/components/workspace/usePlayerShortcuts";
import type { Conversion, Project, StepConversionRequest } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import {
  defaultPreviewFPS,
  fpsOptions,
  parseRational,
  type RationalFPS,
} from "@/lib/frames";
import { blurAfterMouseClick } from "@/lib/interactions";

import { Field, selectClass } from "./controls";
import { PlayerBadge, videoDims, type VideoDims } from "./PlayerBadge";
import { PriorRuns } from "./PriorRuns";
import { ScenePicker, SpeedSelect } from "./ScenePicker";
import {
  sceneRangesForPlayback,
  useScenePlayback,
  type SceneRange,
} from "./useScenePlayback";
import { StepCheckoutSection, useStepCheckout } from "./useStepCheckout";

/** Sold depth resolutions — all multiples of 14 (the depth model's patch
 * size); the gateway rejects anything else. */
const DEPTH_RES_CHOICES: readonly { value: number; name?: string }[] = [
  { value: 518, name: "Draft" },
  { value: 700 },
  { value: 980, name: "Standard" },
  { value: 1148, name: "High" },
  { value: 1442, name: "Very high" },
  { value: 2100 },
  { value: 2520, name: "Maximum" },
];

export const DEFAULT_DEPTH_RES = 980;

/** GPU tier the depth stage routes to at a 16:9 working resolution
 * (app/pipelines/video.py _route_depth_gpu thresholds: L40S_MAX_MP 2.5 ≈
 * depth_res 1184 @ 16:9, H200_MAX_MP 6.5 ≈ 1912). */
export function gpuTierForDepthRes(depthRes: number): "L40S" | "H200" | "B200" {
  if (depthRes <= 1184) return "L40S";
  if (depthRes <= 1912) return "H200";
  return "B200";
}

export function depthResLabel(choice: { value: number; name?: string }): string {
  const name = choice.name ? ` — ${choice.name}` : "";
  return `${choice.value}${name} · ${gpuTierForDepthRes(choice.value)}`;
}

export interface DepthPanelProps {
  project: Project;
  onProjectChanged: () => void;
}

export function DepthPanel({
  project,
  onProjectChanged,
}: DepthPanelProps): JSX.Element {
  const ck = useStepCheckout(project, onProjectChanged);
  const [depthRes, setDepthRes] = useState(DEFAULT_DEPTH_RES);
  const [targetFps, setTargetFps] = useState<number | undefined>(undefined);

  const sourceFps =
    project.analyze.state === "succeeded" && project.probe
      ? parseRational(project.probe.fps_rational)
      : null;

  const depthRuns = (project.conversions ?? []).filter(
    (c) => c.step === "depth_preview",
  );
  const lastSucceeded = depthRuns
    .filter((c) => c.state === "succeeded")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] as
    | Conversion
    | undefined;

  if (sourceFps === null) {
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
    <PanelShell
      theater={
        lastSucceeded ? (
          <DepthResult project={project} conversion={lastSucceeded} />
        ) : null
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="depth-res"
          label="Depth-map resolution"
          hint={
            <>
              The cost/quality knob, and what production inherits: run depth
              once at your final resolution and the production quote discounts
              the whole depth stage when fps and resolution match. GPU tier
              shown at a 16:9 working resolution.
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
            {DEPTH_RES_CHOICES.map((c) => (
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
              Half the source rate is plenty to judge depth. Honest caveat:
              depth reuse keys on fps — a production run at a different rate
              re-runs the depth stage at full price.
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

/** Theater layout: the compare view (when present) spans the FULL page
 * width above the card that keeps the params + checkout machinery. The
 * page title/description live in the shared PageHeader (StepTab). */
function PanelShell({
  theater,
  children,
}: {
  theater?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div data-testid="depth-panel" className="flex flex-col gap-6">
      {theater}
      <Card>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
    </div>
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
}: {
  sourceUrl?: string;
  depthUrl: string;
  scenes: SceneRange[];
  fps: RationalFPS;
}): JSX.Element {
  const srcRef = useRef<HTMLVideoElement | null>(null);
  const depRef = useRef<HTMLVideoElement | null>(null);
  const masterRef = sourceUrl ? srcRef : depRef; // stable: the url never toggles while mounted
  const playback = useScenePlayback(masterRef, scenes, fps);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
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
  // the frame-exact proxy pages only).
  usePlayerShortcuts({ toggle });

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
        <span className="ml-auto text-xs text-fg-muted">Space play/pause</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {sourceUrl ? (
          <div className="relative">
            <video
              ref={srcRef}
              src={sourceUrl}
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
