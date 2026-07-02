"use client";

/**
 * Stereo page (step stereo_preview) — per-scene 3D, splat vs inpaint.
 *
 * The pipeline is per-scene ADAPTIVE by default: the first pro run computes
 * a scene profile (shot_type / displacement / placement per shot), so every
 * row here defaults to "auto" and only rows the user actually changes are
 * sent as scene_overrides (auto rows send NOTHING). Rows are seeded from
 * project.scene_profile when present; a scenes_version mismatch shows a
 * stale-profile warning instead of silently misaligned defaults.
 *
 * Frame doctrine: rows are half-open [first, last) ranges in SOURCE-frame
 * space derived from scenes.cuts via cutsToRanges; every override `first`
 * is 0 or an exact cuts value — never a timestamp.
 *
 * Draft edits (row overrides + master depth_scale) persist in localStorage
 * (stereoStore) keyed by project + scenes_version; the Deliver page reads
 * the same store so production runs THE SAME parameters.
 *
 * After a run succeeds its best browser-playable output (sbs → half_sbs →
 * anaglyph) plays theater-wide ABOVE the params card, with a ScenePicker
 * that loops playback inside one scene at a time. The output is decimated
 * (different fps) but wall-clock-identical to the source, so the loop
 * bounds are frameToSeconds(first/last, SOURCE fps) — no frame math against
 * the output file (frame doctrine).
 */

/* eslint-disable @next/next/no-img-element -- signed GCS thumbnail URLs. */

import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { usePlayerShortcuts } from "@/components/workspace/usePlayerShortcuts";
import type {
  Conversion,
  Format,
  Inpaint,
  ProfileShot,
  Project,
  ShotType,
  StepConversionRequest,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import {
  cutsToRanges,
  defaultPreviewFPS,
  fpsOptions,
  frameToTimecode,
  parseRational,
  type RationalFPS,
} from "@/lib/frames";

import { CheckboxChip, Field, selectClass } from "./controls";
import { PlayerBadge, videoDims, type VideoDims } from "./PlayerBadge";
import { PriorRuns } from "./PriorRuns";
import { ScenePicker, SpeedSelect } from "./ScenePicker";
import {
  sceneRangesForPlayback,
  useScenePlayback,
  type SceneRange,
} from "./useScenePlayback";
import {
  draftToSceneOverrides,
  loadStereoDraft,
  saveStereoDraft,
  stereoDraftKey,
  type RowOverride,
  type StereoDraft,
} from "./stereoStore";
import { StepCheckoutSection, useStepCheckout } from "./useStepCheckout";

const SHOT_TYPES: readonly ShotType[] = [
  "close_up",
  "standard",
  "dynamic",
  "wide",
];

/** Preview formats sold on this page — SBS is the industry-standard preview.
 * No tb/half_tb (dropped from the product), no mvhevc (production only). */
const STEREO_FORMATS = ["sbs", "half_sbs", "anaglyph"] as const satisfies readonly Format[];

const FORMAT_LABELS: Record<(typeof STEREO_FORMATS)[number], string> = {
  sbs: "SBS",
  half_sbs: "Half-SBS",
  anaglyph: "Anaglyph",
};

export interface StereoPanelProps {
  project: Project;
  onProjectChanged: () => void;
}

export function StereoPanel({
  project,
  onProjectChanged,
}: StereoPanelProps): JSX.Element {
  const ck = useStepCheckout(project, onProjectChanged);

  const scenesVersion = project.scenes?.version ?? 0;
  const draftKey = stereoDraftKey(project.project_id, scenesVersion);
  const [draft, setDraft] = useState<StereoDraft>(() =>
    loadStereoDraft(project.project_id, scenesVersion),
  );
  // Re-key the draft if the scene version moves while mounted (a concurrent
  // cut edit) — adjust-during-render, per the React docs pattern.
  const [loadedKey, setLoadedKey] = useState(draftKey);
  if (loadedKey !== draftKey) {
    setLoadedKey(draftKey);
    setDraft(loadStereoDraft(project.project_id, scenesVersion));
  }
  useEffect(() => {
    saveStereoDraft(project.project_id, scenesVersion, draft);
  }, [project.project_id, scenesVersion, draft]);

  const [inpaint, setInpaint] = useState<Inpaint>("none");
  const [formats, setFormats] = useState<Format[]>(["sbs"]);
  const [targetFps, setTargetFps] = useState<number | undefined>(undefined);

  const ready =
    project.analyze.state === "succeeded" && project.probe && project.scenes;
  if (!ready) {
    return (
      <PanelShell>
        <p className="text-sm text-fg-muted">
          Analysis is still running — quotes unlock when it finishes.
        </p>
      </PanelShell>
    );
  }
  const probe = project.probe!;
  const scenes = project.scenes!;
  const sourceFps = parseRational(probe.fps_rational);
  const fps = targetFps ?? defaultPreviewFPS(sourceFps).value;
  const ranges = cutsToRanges(scenes.cuts, probe.num_frames);

  const profile = project.scene_profile;
  const profileStale =
    profile !== undefined && profile.scenes_version !== scenes.version;
  /** The profiled shot covering a row's start frame (also used when the
   * profile is stale — the warning banner flags the possible misalignment). */
  function shotFor(start: number): ProfileShot | undefined {
    return profile?.shots.find((s) => s.first_src <= start && start < s.last_src);
  }

  function patchRow(start: number, patch: RowOverride | null): void {
    setDraft((d) => {
      const overrides = { ...d.overrides };
      const next = patch === null ? {} : { ...overrides[start], ...patch };
      // undefined-valued keys mean "back to auto" — strip them
      if (next.shot_type === undefined) delete next.shot_type;
      if (next.displacement === undefined) delete next.displacement;
      if (Object.keys(next).length === 0) delete overrides[start];
      else overrides[start] = next;
      return { ...d, overrides };
    });
    ck.invalidate();
  }

  const stereoRuns = (project.conversions ?? []).filter(
    (c) => c.step === "stereo_preview",
  );
  const lastSucceeded = stereoRuns
    .filter((c) => c.state === "succeeded")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] as
    | Conversion
    | undefined;

  const sceneOverrides = draftToSceneOverrides(draft, [0, ...scenes.cuts]);
  const request: StepConversionRequest = {
    step: "stereo_preview",
    formats,
    inpaint,
    ...(draft.depth_scale !== 1 ? { depth_scale: draft.depth_scale } : {}),
    ...(sceneOverrides.length > 0 ? { scene_overrides: sceneOverrides } : {}),
    target_fps: fps,
    platform: "web",
  };

  return (
    <PanelShell
      theater={
        lastSucceeded ? (
          <StereoResult project={project} conversion={lastSucceeded} />
        ) : null
      }
    >
      {profileStale ? (
        <p
          data-testid="stale-profile-warning"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300"
        >
          Scene cuts changed since this profile was computed — defaults may be
          misaligned. The next run re-profiles against the current cuts.
        </p>
      ) : null}
      {profile === undefined ? (
        <p data-testid="adaptive-note" className="text-xs text-fg-muted">
          No scene profile yet — the first run computes per-scene depth
          parameters automatically (adaptive), so overrides are optional.
          After it succeeds, the computed values appear here as each scene&apos;s
          Auto defaults.
        </p>
      ) : null}

      <section aria-label="Scenes" className="flex flex-col gap-1.5">
        <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
          Per-scene 3D · {ranges.length} scenes
        </h3>
        <ul className="flex max-h-96 flex-col gap-1.5 overflow-y-auto pr-1">
          {ranges.map(([start, end], i) => (
            <SceneRow
              key={`${start}-${end}`}
              index={i}
              start={start}
              end={end}
              timecode={frameToTimecode(start, sourceFps)}
              thumbUrl={
                project.scene_thumbs?.find(
                  (t) => t.frame >= start && t.frame < end,
                )?.url
              }
              shot={shotFor(start)}
              override={draft.overrides[start]}
              onPatch={(patch) => patchRow(start, patch)}
            />
          ))}
        </ul>
      </section>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-fg-muted">
          Overall 3D strength (depth scale):{" "}
          <span className="font-mono text-fg" data-testid="depth-scale-value">
            ×{draft.depth_scale.toFixed(2)}
          </span>{" "}
          <span className="text-fg-muted">— scales every scene</span>
        </span>
        <Slider
          aria-label="Overall 3D strength (depth scale)"
          min={0.3}
          max={1.5}
          step={0.05}
          value={[draft.depth_scale]}
          onValueChange={([v]) => {
            setDraft((d) => ({ ...d, depth_scale: v }));
            ck.invalidate();
          }}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset className="flex flex-col gap-1">
          <legend className="text-xs font-medium text-fg-muted">Mode</legend>
          <div className="flex gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-edge bg-surface-2 px-2 py-1">
              <input
                type="radio"
                name="stereo-mode"
                checked={inpaint === "none"}
                onChange={() => {
                  setInpaint("none");
                  ck.invalidate();
                }}
                className="accent-primary"
              />
              <span className="text-xs">Splatted (fast)</span>
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-edge bg-surface-2 px-2 py-1">
              <input
                type="radio"
                name="stereo-mode"
                checked={inpaint === "propainter"}
                onChange={() => {
                  setInpaint("propainter");
                  ck.invalidate();
                }}
                className="accent-primary"
              />
              <span className="text-xs">Inpainted (ProPainter)</span>
            </label>
          </div>
          <p className="text-xs text-fg-muted">
            Splatted skips edge inpainting — judge depth separation, not edge
            quality. Inpainted previews price at ×1.6.
          </p>
        </fieldset>
        <Field id="stereo-fps" label="Preview frame rate">
          <select
            id="stereo-fps"
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

      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-medium text-fg-muted">Formats</legend>
        <div className="flex flex-wrap gap-2">
          {STEREO_FORMATS.map((f) => (
            <CheckboxChip
              key={f}
              label={FORMAT_LABELS[f]}
              checked={formats.includes(f)}
              onChange={() => {
                setFormats((prev) =>
                  prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f],
                );
                ck.invalidate();
              }}
            />
          ))}
        </div>
      </fieldset>

      <StepCheckoutSection checkout={ck} request={request} />

      <PriorRuns
        title="Prior stereo runs"
        conversions={stereoRuns}
        meta={(c) =>
          [
            c.params.formats.join("+"),
            c.params.inpaint,
            c.params.depth_scale !== undefined
              ? `depth_scale ${c.params.depth_scale}`
              : null,
            c.params.scene_overrides?.length
              ? `${c.params.scene_overrides.length} scene overrides`
              : null,
            c.params.target_fps !== undefined ? `${c.params.target_fps} fps` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        }
      />
    </PanelShell>
  );
}

/** Theater layout: the output player (when present) spans the FULL page
 * width above the card that keeps the per-scene params + checkout. The
 * page title/description live in the shared PageHeader (StepTab). */
function PanelShell({
  theater,
  children,
}: {
  theater?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div data-testid="stereo-panel" className="flex flex-col gap-6">
      {theater}
      <Card>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
    </div>
  );
}

/** Preference order for the theater player — SBS is the primary review
 * format; the raw list also carries non-playable outputs (ignored here;
 * PriorRuns still links everything). */
const PLAYABLE_PREFERENCE = ["sbs", "half_sbs", "anaglyph"] as const;

/** The newest succeeded run's best browser-playable output. Fetches the
 * run's signed download links; renders nothing when no stereo preview
 * format is present (the downloads expander still has the links). */
function StereoResult({
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
    name: string | null;
    url: string | null;
  } | null>(null);

  useEffect(() => {
    if (fetched?.id === id) return;
    let cancelled = false;
    client
      .getDownloads(id)
      .then((d) => {
        if (cancelled) return;
        const name =
          PLAYABLE_PREFERENCE.find((n) => d.downloads[n] !== undefined) ?? null;
        setFetched({ id, name, url: name ? d.downloads[name] : null });
      })
      .catch(() => {
        if (!cancelled) setFetched({ id, name: null, url: null });
      });
    return () => {
      cancelled = true;
    };
  }, [client, id, fetched]);

  if (fetched?.id !== id || fetched.name === null || fetched.url === null) {
    return null;
  }
  return (
    <StereoOutputPlayer
      name={fetched.name}
      url={fetched.url}
      scenes={sceneRangesForPlayback(project)}
      fps={parseRational(project.probe!.fps_rational)}
    />
  );
}

/** Theater-wide output player with scene-scoped playback. The loop bounds
 * come from SOURCE frames via frameToSeconds — valid for the decimated
 * output because it preserves wall-clock duration. */
function StereoOutputPlayer({
  name,
  url,
  scenes,
  fps,
}: {
  name: string;
  url: string;
  scenes: SceneRange[];
  fps: RationalFPS;
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playback = useScenePlayback(videoRef, scenes, fps);
  const [rate, setRate] = useState(1);
  const [dims, setDims] = useState<VideoDims | null>(null);

  function changeRate(r: number): void {
    setRate(r);
    if (videoRef.current) videoRef.current.playbackRate = r;
  }

  // Space = play/pause via the shared transport hook (no frame stepping —
  // the output is decimated; frame keys belong to the frame-exact proxy).
  function toggle(): void {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }
  usePlayerShortcuts({ toggle });

  return (
    <section
      data-testid="stereo-output"
      aria-label="Latest stereo preview"
      className="flex flex-col gap-2"
    >
      {/* Transport row — same visual system as the other players (shared
          ScenePicker/SpeedSelect; the <video> keeps its native controls). */}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
          Latest stereo preview · {name}
        </h3>
        <ScenePicker id="stereo-scene" playback={playback} />
        <SpeedSelect id="stereo-speed" value={rate} onChange={changeRate} />
        <span className="ml-auto text-xs text-fg-muted">Space play/pause</span>
      </div>
      <div className="relative">
        <video
          ref={videoRef}
          src={url}
          controls
          preload="metadata"
          onTimeUpdate={playback.onTimeUpdate}
          onLoadedMetadata={(e) => {
            playback.onLoadedMetadata();
            setDims(videoDims(e));
          }}
          data-testid="stereo-output-video"
          className="w-full rounded-md border border-edge bg-black"
        />
        <PlayerBadge data-testid="stereo-output-badge" label={name} dims={dims} />
      </div>
    </section>
  );
}

function SceneRow({
  index,
  start,
  end,
  timecode,
  thumbUrl,
  shot,
  override,
  onPatch,
}: {
  index: number;
  start: number;
  end: number;
  timecode: string;
  thumbUrl?: string;
  shot?: ProfileShot;
  override?: RowOverride;
  onPatch: (patch: RowOverride | null) => void;
}): JSX.Element {
  const overridden =
    override !== undefined &&
    (override.shot_type !== undefined || override.displacement !== undefined);
  const n = index + 1;
  return (
    <li
      data-testid={`stereo-scene-${start}`}
      className="flex flex-wrap items-center gap-2 rounded-md border border-edge bg-surface-1 p-1.5"
    >
      <div className="h-9 w-16 shrink-0 overflow-hidden rounded bg-black">
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt={`scene ${n} keyframe`}
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : null}
      </div>
      <div className="flex min-w-28 flex-col">
        <span className="text-xs font-medium">Scene {n}</span>
        <span className="font-mono text-[11px] text-fg-muted">
          f{start}–f{end} · {timecode}
        </span>
      </div>
      <select
        aria-label={`Scene ${n} shot type`}
        value={override?.shot_type ?? "auto"}
        onChange={(e) =>
          onPatch({
            shot_type:
              e.target.value === "auto" ? undefined : (e.target.value as ShotType),
          })
        }
        className={`${selectClass} py-1 text-xs`}
      >
        <option value="auto">Auto{shot ? ` (${shot.shot_type})` : ""}</option>
        {SHOT_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <input
        aria-label={`Scene ${n} displacement`}
        type="number"
        step={0.001}
        min={0.001}
        max={0.03}
        value={override?.displacement ?? ""}
        placeholder={shot ? shot.displacement.toFixed(4) : "auto"}
        onChange={(e) =>
          onPatch({
            displacement:
              e.target.value === "" ? undefined : Number(e.target.value),
          })
        }
        className="w-24 rounded-md border border-edge bg-surface-2 px-2 py-1 font-mono text-xs"
      />
      {overridden ? (
        <>
          <span
            data-testid={`override-chip-${start}`}
            className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
          >
            overridden
          </span>
          <Button
            variant="link"
            size="xs"
            aria-label={`Reset scene ${n} to auto`}
            onClick={() => onPatch(null)}
            className="h-auto p-0 text-[11px] font-normal text-fg-muted hover:text-fg"
          >
            Reset
          </Button>
        </>
      ) : null}
    </li>
  );
}
