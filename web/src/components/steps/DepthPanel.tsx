"use client";

/**
 * Depth page (step depth_preview) — "define the depth map".
 *
 * The only knob that matters here is the depth-map RESOLUTION (the
 * cost/quality axis — production inherits it via artifact reuse). No
 * displacement, no preset, no formats — those belong to the Stereo and
 * Deliver pages. There is NO frame-rate control in this version: previews
 * run at the FULL source rate, sent explicitly as target_fps because the
 * gateway would otherwise default previews to half rate — and depth reuse
 * keys on fps, so full rate keeps the artifact aligned with production.
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
 * Depth-map export/upload (the Cut tab's cuts-CSV pattern, applied to the
 * depth artifact): Export downloads the run's RAW full-precision depth file
 * (the `depth` output the later steps consume — an explanatory dialog makes
 * clear it is NOT the 8-bit depth_vis preview); Upload loads a local depth
 * video into the compare slot AND registers it on the project (signed-PUT
 * upload + POST .../depth-map, gateway-validated frame-exact against the
 * source) so Stereo/Deliver runs can use it in place of the depth stage
 * (use_uploaded_depth).
 */

import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useScrollActiveSceneToTop } from "@/components/workspace/SceneList";
import type { Conversion, Project, StepConversionRequest } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import {
  clampDepthRes,
  DEFAULT_DEPTH_RES,
  depthContentDims,
  depthResChoices,
  depthResLabel,
} from "@/lib/depthRes";
import {
  clipRange,
  cutsToRanges,
  defaultPreviewFPS,
  frameToTimecode,
  parseRational,
  type RationalFPS,
} from "@/lib/frames";
import { useT } from "@/lib/i18n/I18nProvider";
import { rich } from "@/lib/i18n/rich";
import { blurAfterMouseClick } from "@/lib/interactions";

import { Field, selectClass } from "./controls";
import {
  draftToSceneOverrides,
  setRowPassthrough,
  useStereoDraft,
} from "./stereoStore";
import { StepReview, useRunDownloads } from "./StepReview";
import { GatewayError } from "@/lib/api/client";

import { FPS_PLAN_REQUIRED } from "./frameRate";
import { CLASSIC_PREVIEW_SECONDS } from "./methods";
import { StepCheckoutSection, useStepCheckout } from "./useStepCheckout";
import { DownloadGate } from "@/components/billing/PayToDownload";

export { DEFAULT_DEPTH_RES };

export interface DepthPanelProps {
  project: Project;
  onProjectChanged: () => void;
}

export function DepthPanel({
  project,
  onProjectChanged,
}: DepthPanelProps): JSX.Element {
  const ck = useStepCheckout(project, "depth_preview", onProjectChanged);
  const t = useT();
  // the playhead: where the 10-second clip starts (S3D-27)
  const [moment, setMoment] = useState(0);
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

  // depth_res is capped by the content short side AND the aspect-aware VRAM
  // ceiling — both computed on the POST-CROP dims (black bars are removed
  // before depth runs, so a letterboxed wide film binds at its content
  // aspect, not the container's) — see lib/depthRes.
  const contentDims = depthContentDims(project.probe, project.crop);
  const resChoices = contentDims
    ? depthResChoices(contentDims.width, contentDims.height)
    : depthResChoices(DEFAULT_DEPTH_RES, DEFAULT_DEPTH_RES);
  const [depthRes, setDepthRes] = useState(() =>
    clampDepthRes(DEFAULT_DEPTH_RES, resChoices),
  );

  const lastSucceeded = (project.conversions ?? [])
    .filter((c) => c.step === "depth_preview" && c.state === "succeeded")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] as
    | Conversion
    | undefined;

  // The scene grid's 3D toggles (shared draft) are a DEPTH input too: a
  // passthrough scene skips the AI depth pass entirely (black depth), so
  // the passthrough set rides the request — and flipping a toggle stales
  // any fetched quote exactly like changing depth_res does.
  const validStarts = [0, ...(project.scenes?.cuts ?? [])];
  const passthroughOverrides = draftToSceneOverrides(draft, validStarts).filter(
    (o) => o.passthrough === true,
  );
  const ptSignature = passthroughOverrides.map((o) => o.first).join(",");
  const prevPtRef = useRef(ptSignature);
  const invalidate = ck.invalidate;
  useEffect(() => {
    if (prevPtRef.current === ptSignature) return;
    prevPtRef.current = ptSignature;
    invalidate();
  }, [ptSignature, invalidate]);

  if (sourceFps === null || !project.probe) {
    return (
      <PanelShell>
        <p className="text-sm text-fg-muted">{t("depth.analysisRunning")}</p>
      </PanelShell>
    );
  }

  // Full source rate, sent EXPLICITLY: an absent target_fps makes the
  // gateway decimate previews to half rate, and depth reuse keys on fps.
  // S3D-27: a 10-second clip from the playhead, not the whole video
  const [clipFrom, clipTo] = clipRange(
    moment,
    project.probe.num_frames,
    sourceFps,
    CLASSIC_PREVIEW_SECONDS,
  );
  const request: StepConversionRequest = {
    step: "depth_preview",
    depth_res: depthRes,
    from_frame: clipFrom,
    to_frame: clipTo,
    target_fps: defaultPreviewFPS(sourceFps).value,
    platform: "web",
    // passthrough-only (the gateway rejects depth knobs on this step):
    // these scenes ship as 2D, so their depth is never computed
    ...(passthroughOverrides.length > 0
      ? { scene_overrides: passthroughOverrides }
      : {}),
  };

  return (
    <PanelShell>
      <DepthReview
        project={project}
        sourceFps={sourceFps}
        onPlayhead={setMoment}
        range={(f) =>
          clipRange(f, project.probe!.num_frames, sourceFps, CLASSIC_PREVIEW_SECONDS)
        }
        lastSucceeded={lastSucceeded}
        draft={draft}
        setDraft={setDraft}
        onProjectChanged={onProjectChanged}
      />

      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="depth-res"
              label={t("depth.res.label")}
              hint={t("depth.res.hint")}
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

/**
 * Cut-style review area with ONE transport (the shared StepReview): the
 * frame-exact source preview (master), the depth map beside it (follower,
 * when available), the timeline, and the scene grid with per-scene 3D
 * toggles. Owns the depth-map Export (raw 10-bit file, behind an
 * explanatory dialog) and Import (local review file) actions.
 */
function DepthReview({
  project,
  sourceFps,
  lastSucceeded,
  draft,
  setDraft,
  onProjectChanged,
  onPlayhead,
  range,
}: {
  project: Project;
  sourceFps: RationalFPS;
  onPlayhead: (f: number) => void;
  range: (f: number) => [number, number];
  lastSucceeded: Conversion | undefined;
  draft: ReturnType<typeof useStereoDraft>[0];
  setDraft: ReturnType<typeof useStereoDraft>[1];
  onProjectChanged: () => void;
}): JSX.Element {
  const client = useGateway();
  const t = useT();
  const downloads = useRunDownloads(lastSucceeded);
  const depthVis = downloads?.depth_vis ?? null;
  const exportUrl = downloads?.depth ?? null;

  // Locally picked depth video (object URL) — overrides the run's
  // depth_vis in the compare slot for review while the SAME file uploads
  // to the project in the background (uploadDepthFile).
  const [imported, setImported] = useState<{ name: string; url: string } | null>(
    null,
  );
  // Upload lifecycle: progress fraction while PUTting, error inline, and
  // project.depth_upload as the durable "on file" truth after refetch.
  const [uploading, setUploading] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
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
    void uploadDepthFile(file);
  }
  function clearImported(): void {
    setImported((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  }

  /** Upload the picked depth video and register it on the project (signed
   * PUT + POST .../depth-map). On success project.depth_upload appears via
   * the refetch; a frame-count mismatch surfaces the gateway's 400 inline. */
  async function uploadDepthFile(file: File): Promise<void> {
    setUploading(0);
    setUploadError(null);
    try {
      const ticket = await client.createUpload(file.name, file.type || "video/mp4");
      await client.uploadFile(ticket, file, setUploading);
      await client.setProjectDepthMap(project.project_id, {
        gcs_key: ticket.gcs_key,
        name: file.name,
      });
      onProjectChanged(); // pick up project.depth_upload
    } catch (e) {
      // above 30 fps without a plan (gateway 422 plan_required_fps)
      setUploadError(
        e instanceof GatewayError && e.code === "plan_required_fps"
          ? FPS_PLAN_REQUIRED
          : e instanceof Error
            ? e.message
            : t("depth.uploadFailedFallback"),
      );
    } finally {
      setUploading(null);
    }
  }

  async function removeUploadedDepth(): Promise<void> {
    setUploadError(null);
    try {
      await client.deleteProjectDepthMap(project.project_id);
      onProjectChanged();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : t("depth.requestFailed"));
    }
  }

  const depthUrl = imported?.url ?? depthVis;
  const [exportOpen, setExportOpen] = useState(false);
  /** A run finished but produced nothing playable — show the aside note. */
  const runWithoutVis =
    depthUrl === null && lastSucceeded !== undefined && downloads !== null;

  return (
    <>
      <StepReview
        project={project}
        sourceFps={sourceFps}
        onPlayhead={onPlayhead}
        range={range}
        heading={t("depth.heading")}
        headingExtras={
          <>
            {imported ? (
              <span
                data-testid="imported-depth-note"
                className="flex items-center gap-1 text-[11px] text-fg-muted"
              >
                <span className="max-w-48 truncate font-mono">{imported.name}</span>
                {t("depth.imported.preview")}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("depth.imported.clearAria")}
                  className="text-fg-muted hover:text-fg"
                  onClick={(e) => {
                    blurAfterMouseClick(e);
                    clearImported();
                  }}
                >
                  ×
                </Button>
              </span>
            ) : depthUrl === null && !runWithoutVis ? (
              <span className="text-[11px] text-fg-muted">
                {t("depth.noRunYet")}
              </span>
            ) : null}
            {uploading !== null ? (
              <span
                data-testid="depth-upload-progress"
                className="text-[11px] text-fg-muted"
              >
                {t("depth.uploading", { percent: Math.round(uploading * 100) })}
              </span>
            ) : uploadError !== null ? (
              <span data-testid="depth-upload-error" className="text-[11px] text-red-400">
                {t("depth.uploadFailed", { error: uploadError })}
              </span>
            ) : project.depth_upload ? (
              <span
                data-testid="depth-upload-chip"
                className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] text-primary"
              >
                <span className="max-w-48 truncate">
                  {t("depth.onFile", {
                    name: project.depth_upload.name || t("depth.onFileFallback"),
                  })}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("depth.removeAria")}
                  className="text-primary hover:text-fg"
                  onClick={(e) => {
                    blurAfterMouseClick(e);
                    void removeUploadedDepth();
                  }}
                >
                  ×
                </Button>
              </span>
            ) : null}
          </>
        }
        toolbar={
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              aria-label={t("depth.fileAria")}
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
              title={t("depth.upload.title")}
              onClick={(e) => {
                blurAfterMouseClick(e);
                fileInputRef.current?.click();
              }}
            >
              {t("depth.upload.button")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={exportUrl === null}
              title={
                exportUrl === null
                  ? t("depth.export.titleDisabled")
                  : t("depth.export.titleEnabled")
              }
              onClick={(e) => {
                blurAfterMouseClick(e);
                setExportOpen(true);
              }}
            >
              {t("depth.export.button")}
            </Button>
          </>
        }
        follower={
          depthUrl !== null
            ? {
                url: depthUrl,
                label: imported ? t("depth.follower.importedLabel") : "depth_vis",
                title: imported
                  ? t("depth.follower.importedTitle", { name: imported.name })
                  : t("depth.follower.visTitle"),
                testId: "depth-video",
              }
            : null
        }
        asideFallback={
          runWithoutVis
            ? {
                testId: "depth-video-missing",
                content: <>{t("depth.missingVis")}</>,
              }
            : null
        }
      >
        {({ playhead, scrub }) =>
          project.scenes ? (
            <DepthSceneGrid
              cuts={project.scenes.cuts ?? []}
              numFrames={project.probe!.num_frames}
              fps={sourceFps}
              sceneThumbs={project.scene_thumbs ?? []}
              playhead={playhead}
              draft={draft}
              setDraft={setDraft}
              onSelectScene={scrub}
            />
          ) : null
        }
      </StepReview>

      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent data-testid="export-depth-dialog">
          <DialogHeader>
            <DialogTitle>{t("depth.export.dialogTitle")}</DialogTitle>
            <DialogDescription>
              {rich(t, "depth.export.dialogBody", {
                mono: (c) => <span className="font-mono">{c}</span>,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <DownloadGate className={buttonVariants()}>
              <Button asChild>
                <a
                  href={exportUrl ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  download
                  data-testid="export-depth-link"
                  onClick={() => setExportOpen(false)}
                >
                  {t("depth.export.download")}
                </a>
              </Button>
            </DownloadGate>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
  const t = useT();
  const ranges = cutsToRanges(cuts, numFrames);
  const thumbs = sceneThumbs ?? [];

  const scrollRef = useRef<HTMLDivElement>(null);
  const activeStart = ranges.find(
    ([start, end]) => playhead >= start && playhead < end,
  )?.[0];
  useScrollActiveSceneToTop(scrollRef, activeStart);

  return (
    <section aria-label={t("depth.scenes.aria")} className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
        {t("depth.scenes.heading")}
      </h3>
      <p className="text-xs text-fg-muted">{t("depth.scenes.hint")}</p>
      <div
        ref={scrollRef}
        data-testid="depth-scenes"
        className="grid max-h-[18rem] grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2 overflow-y-auto pr-1"
      >
        {ranges.map(([start, end], i) => {
          const active = playhead >= start && playhead < end;
          const passthrough = draft.overrides[start]?.passthrough === true;
          const thumb = thumbs.find((th) => th.frame >= start && th.frame < end);
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
                      alt={t("depth.scene.thumbAlt", { n: i + 1 })}
                      draggable={false}
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-fg">{t("depth.scene.name", { n: i + 1 })}</span>
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
                  aria-label={t("depth.scene.convertAria", { n: i + 1 })}
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
