"use client";

/**
 * Stereo page (step stereo_preview) — per-scene 3D, preview what you deliver.
 *
 * Layout mirrors the Cut/Depth pages (the shared StepReview): ONE
 * frame-exact source preview up top with the latest stereo output BESIDE it
 * as a follower of the SAME transport (fraction-of-duration sync — outputs
 * run at their own fps, wall-clock-identical), a FilmstripTimeline for
 * scrubbing, and the per-scene override rows underneath, driven by the
 * playhead: the active scene is highlighted and auto-scrolls to the top
 * while playing (like Cut), and clicking a scene's header seeks the preview
 * there — profile each scene against the REAL video, not just a thumbnail.
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
 * Output params match the Deliver page (shared outputOptions): the SAME
 * resolution presets and the SAME format set (MV-HEVC included), and
 * inpainted (ProPainter) is the DEFAULT mode — the preview should look like
 * the deliverable; splatted is the cheap opt-OUT for judging depth only.
 *
 * Draft edits (row overrides + master depth_scale) persist in localStorage
 * (stereoStore) keyed by project + scenes_version; the Deliver page reads
 * the same store so production runs THE SAME parameters, and the Depth page
 * mounts the same draft for its per-scene Convert-to-3D toggles.
 *
 * Per-scene 2D passthrough: unchecking a row's "Convert to 3D" ships that
 * scene as-is (both eyes the untouched source) — the request builder emits
 * exactly {first, passthrough: true} for it while the row's stashed depth
 * tweaks stay in the draft (restored on re-check) and render disabled.
 *
 * Free shot profiling: when no scene_profile aligned with the current cuts
 * exists, a "Profile shots (free)" action starts the standalone profiler
 * (POST .../profile); while project.profile runs the panel re-polls the
 * workspace refetch and, on success, the rows re-seed from the new
 * scene_profile automatically.
 *
 * Scene-profile export/import (the Cut tab's cuts-CSV pattern, applied to
 * the per-scene 3D parameters — see stereoProfile.ts): Export downloads the
 * scene table (Auto values + the draft's overrides + depth_scale) as JSON;
 * Import parses such a file, validates it against the CURRENT cuts, and —
 * after an explicit confirm — REPLACES the draft, which Deliver inherits.
 */

/* eslint-disable @next/next/no-img-element -- signed GCS thumbnail URLs. */

import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { AnalyzeProgress } from "@/components/projects/AnalyzeBadge";
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
import { Slider } from "@/components/ui/slider";
import { useScrollActiveSceneToTop } from "@/components/workspace/SceneList";
import type {
  Conversion,
  Format,
  Inpaint,
  Preset,
  ProfileShot,
  Project,
  ShotType,
  StepConversionRequest,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import {
  cutsToRanges,
  defaultPreviewFPS,
  frameToTimecode,
  parseRational,
  type RationalFPS,
} from "@/lib/frames";
import { blurAfterMouseClick } from "@/lib/interactions";

import { CheckboxChip, Field, selectClass } from "./controls";
import { FORMAT_LABELS, OUTPUT_FORMATS, RESOLUTION_PRESETS } from "./outputOptions";
import { PROFILE_POLL_MS } from "./polling";
import { PriorRuns } from "./PriorRuns";
import {
  exportStereoProfile,
  parseStereoProfile,
  SHOT_TYPES,
} from "./stereoProfile";
import {
  draftToSceneOverrides,
  useStereoDraft,
  type RowOverride,
  type StereoDraft,
} from "./stereoStore";
import { bestPlayable, StepReview, useRunDownloads } from "./StepReview";
import { StepCheckoutSection, useStepCheckout } from "./useStepCheckout";

export interface StereoPanelProps {
  project: Project;
  onProjectChanged: () => void;
}

export function StereoPanel({
  project,
  onProjectChanged,
}: StereoPanelProps): JSX.Element {
  const ck = useStepCheckout(project, onProjectChanged);
  const client = useGateway();

  const scenesVersion = project.scenes?.version ?? 0;
  // Shared with the Depth page (same localStorage key) — its per-scene
  // Convert-to-3D toggle flips the same draft rows.
  const [draft, setDraft] = useStereoDraft(project.project_id, scenesVersion);

  // Inpainted is the DEFAULT: the preview should look like the deliverable
  // (Deliver also defaults to ProPainter); splatted is the cheap opt-out.
  const [inpaint, setInpaint] = useState<Inpaint>("propainter");
  const [preset, setPreset] = useState<Preset>("1080p");
  const [formats, setFormats] = useState<Format[]>(["sbs"]);

  // Scene-profile import/export (the Cut tab's cuts-CSV pattern): the file
  // input feeds the parser; a parsed-but-unconfirmed draft holds the confirm
  // dialog open (importing REPLACES every tweak on this page).
  const profileFileRef = useRef<HTMLInputElement | null>(null);
  const [importPending, setImportPending] = useState<StereoDraft | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Free shot profiling: while the standalone job runs, drive the
  // workspace's project refetch so project.profile/scene_profile stay live.
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileStarting, setProfileStarting] = useState(false);
  const profileRunning = project.profile?.state === "running";
  useEffect(() => {
    if (!profileRunning) return;
    const timer = setInterval(() => onProjectChanged(), PROFILE_POLL_MS);
    return () => clearInterval(timer);
  }, [profileRunning, onProjectChanged]);

  async function startProfile(): Promise<void> {
    setProfileStarting(true);
    setProfileError(null);
    try {
      await client.profileProject(project.project_id);
      onProjectChanged(); // pick up profile.state=running (and start polling)
    } catch (e) {
      setProfileError(e instanceof Error ? e.message : "request failed");
    } finally {
      setProfileStarting(false);
    }
  }

  const stereoRuns = (project.conversions ?? []).filter(
    (c) => c.step === "stereo_preview",
  );
  const lastSucceeded = stereoRuns
    .filter((c) => c.state === "succeeded")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] as
    | Conversion
    | undefined;
  const output = bestPlayable(useRunDownloads(lastSucceeded));

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
  const ranges = cutsToRanges(scenes.cuts, probe.num_frames);

  const profile = project.scene_profile;
  const profileStale =
    profile !== undefined && profile.scenes_version !== scenes.version;
  /** Offer the free profiler whenever there is no profile aligned with the
   * CURRENT cuts (none yet, or computed against an older version). */
  const needsProfile = profile === undefined || profileStale;
  const profileFailed = project.profile?.state === "failed";
  /** POST failure (local) or the job's own failure (from the gateway). */
  const profileErrorText =
    profileError ?? (profileFailed ? (project.profile?.error ?? "job failed") : null);
  /** The profiled shot covering a row's start frame (also used when the
   * profile is stale — the warning banner flags the possible misalignment). */
  function shotFor(start: number): ProfileShot | undefined {
    return profile?.shots.find((s) => s.first_src <= start && start < s.last_src);
  }

  /** Download the CURRENT page state (auto profile + draft tweaks) as the
   * scene-profile JSON via a Blob URL — same flow as the Cut tab's CSV. */
  function exportProfile(): void {
    const json = exportStereoProfile({
      draft,
      ranges,
      fps: sourceFps,
      scenesVersion: scenes.version,
      shotFor,
    });
    const name = `${(project.name ?? "").trim().replace(/[/\\]/g, "-") || "project"}-stereo-profile.json`;
    const url = URL.createObjectURL(
      new Blob([json], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Parse the picked file; errors surface inline. The draft replacement
   * itself waits for the confirm dialog. */
  async function importProfileFile(file: File): Promise<void> {
    try {
      const parsed = parseStereoProfile(
        await file.text(),
        [0, ...scenes.cuts],
        scenes.version,
      );
      setImportPending(parsed);
      setImportError(null);
    } catch (e) {
      setImportError(
        e instanceof Error ? e.message : "Could not read the scene profile.",
      );
    }
  }

  /** Confirmed import: replace the WHOLE draft (rows + depth_scale) — the
   * same store Deliver inherits, so production sees the imported values. */
  function applyImport(): void {
    if (importPending === null) return;
    setDraft(importPending);
    setImportPending(null);
    ck.invalidate();
  }

  function patchRow(start: number, patch: RowOverride | null): void {
    setDraft((d) => {
      const overrides = { ...d.overrides };
      const next = patch === null ? {} : { ...overrides[start], ...patch };
      // undefined-valued keys mean "back to auto" — strip them
      if (next.shot_type === undefined) delete next.shot_type;
      if (next.displacement === undefined) delete next.displacement;
      // passthrough is stored only when ON (checked "Convert to 3D" = absent)
      if (next.passthrough !== true) delete next.passthrough;
      if (Object.keys(next).length === 0) delete overrides[start];
      else overrides[start] = next;
      return { ...d, overrides };
    });
    ck.invalidate();
  }

  const sceneOverrides = draftToSceneOverrides(draft, [0, ...scenes.cuts]);
  const request: StepConversionRequest = {
    step: "stereo_preview",
    preset,
    formats,
    inpaint,
    ...(draft.depth_scale !== 1 ? { depth_scale: draft.depth_scale } : {}),
    ...(sceneOverrides.length > 0 ? { scene_overrides: sceneOverrides } : {}),
    // Full source rate, sent EXPLICITLY: an absent target_fps makes the
    // gateway decimate previews to half rate.
    target_fps: defaultPreviewFPS(sourceFps).value,
    platform: "web",
  };

  const profileSection = needsProfile ? (
    profileRunning ? (
      <div
        data-testid="profile-running"
        className="flex items-center gap-3 rounded-md border border-edge bg-surface-1 p-3 text-xs text-fg-muted"
      >
        <span
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent"
        />
        <AnalyzeProgress analyze={project.profile!} />
      </div>
    ) : (
      <div
        data-testid="profile-action"
        className="flex flex-wrap items-center gap-x-2 gap-y-1"
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => void startProfile()}
          disabled={profileStarting}
        >
          {profileFailed ? "Retry profiling (free)" : "Profile shots (free)"}
        </Button>
        <span className="text-xs text-fg-muted">
          Measures each scene&apos;s depth and seeds these controls — free,
          ~1&nbsp;min.
        </span>
        {profileErrorText !== null ? (
          <span data-testid="profile-error" className="text-xs text-red-400">
            Profiling failed — {profileErrorText}
          </span>
        ) : null}
      </div>
    )
  ) : null;

  return (
    <PanelShell>
      <StepReview
        project={project}
        sourceFps={sourceFps}
        heading="Stereo preview"
        headingExtras={
          output === null ? (
            <span className="text-[11px] text-fg-muted">
              Run a stereo preview to see the 3D output beside the source.
            </span>
          ) : null
        }
        toolbar={
          <>
            <input
              ref={profileFileRef}
              type="file"
              accept=".json,application/json"
              aria-label="Scene profile file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = ""; // re-picking the same file must re-fire
                if (file) void importProfileFile(file);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              title="Load a scene profile exported from this page — replaces the per-scene tweaks and depth scale"
              onClick={(e) => {
                blurAfterMouseClick(e);
                profileFileRef.current?.click();
              }}
            >
              Import profile…
            </Button>
            <Button
              variant="outline"
              size="sm"
              title="Download the scene profile — each scene's Auto values plus your overrides and depth scale — as JSON"
              onClick={(e) => {
                blurAfterMouseClick(e);
                exportProfile();
              }}
            >
              Export profile
            </Button>
          </>
        }
        follower={
          output !== null
            ? {
                url: output.url,
                label: output.name,
                title:
                  "The latest run's stereo output, synced to the source transport",
                testId: "stereo-output-video",
              }
            : null
        }
      >
        {({ playhead, scrub }) => (
          <>
            {importError !== null ? (
              <p
                data-testid="profile-import-error"
                className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-400"
              >
                Import failed — {importError}
              </p>
            ) : null}
            {profileStale ? (
              <p
                data-testid="stale-profile-warning"
                className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300"
              >
                Scene cuts changed since this profile was computed — defaults
                may be misaligned. The next run re-profiles against the current
                cuts.
              </p>
            ) : null}
            {profile === undefined ? (
              <p data-testid="adaptive-note" className="text-xs text-fg-muted">
                No scene profile yet — the first run computes per-scene depth
                parameters automatically (adaptive), so overrides are optional.
                After it succeeds, the computed values appear here as each
                scene&apos;s Auto defaults.
              </p>
            ) : null}
            {profileSection}
            <SceneOverrideRows
              ranges={ranges}
              sourceFps={sourceFps}
              sceneThumbs={project.scene_thumbs ?? []}
              playhead={playhead}
              onSelectScene={scrub}
              draft={draft}
              shotFor={shotFor}
              onPatch={patchRow}
            />
          </>
        )}
      </StepReview>

      <Card>
        <CardContent className="flex flex-col gap-4">
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
                    checked={inpaint === "propainter"}
                    onChange={() => {
                      setInpaint("propainter");
                      ck.invalidate();
                    }}
                    className="accent-primary"
                  />
                  <span className="text-xs">Inpainted (ProPainter)</span>
                </label>
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
              </div>
              <p className="text-xs text-fg-muted">
                Inpainted (the default, ×1.6) previews the deliverable edge
                quality. Splatted skips inpainting — judge depth separation
                cheaply.
              </p>
            </fieldset>
            <Field
              id="stereo-preset"
              label="Resolution preset"
              hint="The resulting output resolution — same presets as Deliver."
            >
              <select
                id="stereo-preset"
                value={preset}
                onChange={(e) => {
                  setPreset(e.target.value as Preset);
                  ck.invalidate();
                }}
                className={selectClass}
              >
                {RESOLUTION_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs font-medium text-fg-muted">Formats</legend>
            <div className="flex flex-wrap gap-2">
              {OUTPUT_FORMATS.map((f) => (
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

          <StepCheckoutSection
            checkout={ck}
            request={request}
            trackerDownloads={false}
          />
        </CardContent>
      </Card>

      <Dialog
        open={importPending !== null}
        onOpenChange={(open) => {
          if (!open) setImportPending(null);
        }}
      >
        <DialogContent data-testid="import-profile-dialog">
          <DialogHeader>
            <DialogTitle>Import scene profile</DialogTitle>
            <DialogDescription>
              Replace your per-scene tweaks with{" "}
              {Object.keys(importPending?.overrides ?? {}).length} imported
              overrides and depth scale ×
              {(importPending?.depth_scale ?? 1).toFixed(2)}? Scenes without an
              override go back to Auto. The Deliver page inherits the same
              values.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button type="button" onClick={applyImport}>
              Replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PriorRuns
        title="Prior stereo runs"
        conversions={stereoRuns}
        meta={(c) =>
          [
            c.params.preset,
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

/** Page frame: review area, params card, prior runs — full width. The page
 * title/description live in the shared PageHeader (StepTab). */
function PanelShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div data-testid="stereo-panel" className="flex flex-col gap-6">
      {children}
    </div>
  );
}

/**
 * Per-scene override rows, driven by the review playhead: the row whose
 * range contains the playhead is highlighted and auto-scrolls to the top
 * while playing (the Cut tab's behavior); clicking a row's scene header
 * seeks the preview there, so each scene is profiled against the REAL
 * video. The row controls edit the shared stereo draft (only changed rows
 * go on the wire — see draftToSceneOverrides).
 */
function SceneOverrideRows({
  ranges,
  sourceFps,
  sceneThumbs,
  playhead,
  onSelectScene,
  draft,
  shotFor,
  onPatch,
}: {
  ranges: Array<[number, number]>;
  sourceFps: RationalFPS;
  sceneThumbs: Project["scene_thumbs"];
  playhead: number;
  onSelectScene: (startFrame: number) => void;
  draft: ReturnType<typeof useStereoDraft>[0];
  shotFor: (start: number) => ProfileShot | undefined;
  onPatch: (start: number, patch: RowOverride | null) => void;
}): JSX.Element {
  const thumbs = sceneThumbs ?? [];
  const scrollRef = useRef<HTMLUListElement>(null);
  const activeStart = ranges.find(
    ([start, end]) => playhead >= start && playhead < end,
  )?.[0];
  useScrollActiveSceneToTop(scrollRef, activeStart);

  return (
    <section aria-label="Scenes" className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
        Per-scene 3D · {ranges.length} scenes
      </h3>
      <p className="text-xs text-fg-muted">
        Click a scene to jump the preview there — the playing scene leads the
        list. Only rows you change are sent as overrides.
      </p>
      <ul ref={scrollRef} className="flex max-h-96 flex-col gap-1.5 overflow-y-auto pr-1">
        {ranges.map(([start, end], i) => (
          <SceneRow
            key={`${start}-${end}`}
            index={i}
            start={start}
            end={end}
            active={playhead >= start && playhead < end}
            timecode={frameToTimecode(start, sourceFps)}
            thumbUrl={thumbs.find((t) => t.frame >= start && t.frame < end)?.url}
            shot={shotFor(start)}
            override={draft.overrides[start]}
            onSelect={() => onSelectScene(start)}
            onPatch={(patch) => onPatch(start, patch)}
          />
        ))}
      </ul>
    </section>
  );
}

function SceneRow({
  index,
  start,
  end,
  active,
  timecode,
  thumbUrl,
  shot,
  override,
  onSelect,
  onPatch,
}: {
  index: number;
  start: number;
  end: number;
  active: boolean;
  timecode: string;
  thumbUrl?: string;
  shot?: ProfileShot;
  override?: RowOverride;
  onSelect: () => void;
  onPatch: (patch: RowOverride | null) => void;
}): JSX.Element {
  const passthrough = override?.passthrough === true;
  const overridden =
    override !== undefined &&
    (override.shot_type !== undefined || override.displacement !== undefined);
  const n = index + 1;
  return (
    <li
      data-testid={`stereo-scene-${start}`}
      className={`flex flex-wrap items-center gap-2 rounded-md border p-1.5 ${
        active
          ? "border-primary bg-surface-2 ring-1 ring-primary"
          : "border-edge bg-surface-1"
      } ${passthrough ? "opacity-60" : ""}`}
    >
      {/* Scene header IS the seek control (data-start feeds the shared
          auto-scroll hook) — click to review this scene in the preview. */}
      <button
        type="button"
        data-testid="scene-card"
        data-start={start}
        data-end={end}
        aria-current={active ? "true" : undefined}
        title={`Jump the preview to scene ${n} (frame ${start})`}
        onClick={(e) => {
          blurAfterMouseClick(e);
          onSelect();
        }}
        className="flex items-center gap-2 rounded text-left hover:bg-surface-2"
      >
        <span className="h-9 w-16 shrink-0 overflow-hidden rounded bg-black">
          {thumbUrl ? (
            <img
              src={thumbUrl}
              alt={`scene ${n} keyframe`}
              draggable={false}
              className="h-full w-full object-cover"
            />
          ) : null}
        </span>
        <span className="flex min-w-28 flex-col">
          <span className="text-xs font-medium">Scene {n}</span>
          <span className="font-mono text-[11px] text-fg-muted">
            f{start}–f{end} · {timecode}
          </span>
        </span>
      </button>
      <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-edge bg-surface-2 px-2 py-1">
        <input
          type="checkbox"
          aria-label={`Scene ${n} convert to 3D`}
          checked={!passthrough}
          onChange={(e) =>
            onPatch({ passthrough: e.target.checked ? undefined : true })
          }
          className="accent-primary"
        />
        <span className="text-xs">3D</span>
      </label>
      <select
        aria-label={`Scene ${n} shot type`}
        value={override?.shot_type ?? "auto"}
        disabled={passthrough}
        onChange={(e) =>
          onPatch({
            shot_type:
              e.target.value === "auto" ? undefined : (e.target.value as ShotType),
          })
        }
        className={`${selectClass} py-1 text-xs disabled:opacity-50`}
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
        disabled={passthrough}
        onChange={(e) =>
          onPatch({
            displacement:
              e.target.value === "" ? undefined : Number(e.target.value),
          })
        }
        className="w-24 rounded-md border border-edge bg-surface-2 px-2 py-1 font-mono text-xs disabled:opacity-50"
      />
      {passthrough ? (
        <span
          data-testid={`passthrough-note-${start}`}
          className="text-[11px] text-fg-muted"
        >
          2D passthrough — shipped as-is (both eyes identical)
        </span>
      ) : null}
      {!passthrough && overridden ? (
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
