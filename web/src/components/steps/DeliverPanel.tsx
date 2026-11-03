"use client";

/**
 * Make 3D for Classic projects (screen 10, step production). Numbered
 * sections like Lifelike's page (S3D-07/04/10): where you'll watch it,
 * the files (Red-cyan included), quality tiles priced for this video
 * (Classic stops at 3K, S3D-12), which part. Advanced, collapsed (S3D-29):
 * the depth detail and 3D look settings carried over from the earlier
 * pages (each with an "automatic" escape), your own depth map, the edge
 * style — Stretched or Filled, each with its price — and Start from
 * scratch. Right, the price card with ONE button (S3D-45). The one-way
 * offer to move to Lifelike sits on top (S3D-44).
 *
 * Production sends THE SAME depth_res / scene_overrides / depth_scale the
 * Depth and 3D look pages set (shared stereo draft store). Compatible
 * earlier work is reused automatically; the quote shows the discount.
 */

import { useState } from "react";
import type { JSX } from "react";

import { MoveToLifelikeOffer } from "@/components/workspace/MethodChooser";
import {
  type Format,
  type Preset,
  type Project,
  type StepConversionRequest,
} from "@/lib/api/types";
import { useLimits } from "@/lib/api/useLimits";
import { cancelRule, prechargeThreshold } from "@/lib/billingCopy";
import { parseRational } from "@/lib/frames";
import { EDGE_NAMES, qualitiesFor, qualityChoices, type QualityChoice } from "@/lib/glossary";

import { CheckboxChip } from "./controls";
import {
  DEFAULT_MAKE_FORMATS,
  deviceForClient,
  FileTiles,
  formatsForDevices,
  MakeSection,
  QualityTiles,
  TrimControl,
  trimChip,
  trimFields,
  usePresetPrices,
  useVariantPrices,
  WatchPicker,
  type Device,
} from "./makeControls";
import { formatCents } from "./money";
import { EDGE_LABELS, EDGE_OPTIONS, edgeModeRequest, type EdgeMode } from "./outputOptions";
import { draftToSceneOverrides, loadStereoDraft } from "./stereoStore";
import { InstantCheckout, useStepCheckout } from "./useStepCheckout";
import { useClient } from "./ViewIn3D";

/** Classic's files, in the order the page offers them. */
const CLASSIC_FORMATS: readonly Format[] = ["mvhevc", "sbs", "half_sbs", "anaglyph"];

export interface DeliverPanelProps {
  project: Project;
  onProjectChanged: () => void;
}

export function DeliverPanel({
  project,
  onProjectChanged,
}: DeliverPanelProps): JSX.Element {
  const ck = useStepCheckout(project, "production", onProjectChanged);
  const limits = useLimits();
  const client = useClient();

  const choices: QualityChoice[] = (() => {
    const allowed = new Set(qualitiesFor(project.probe, "classic"));
    return qualityChoices({ probe: project.probe }).filter((q) => allowed.has(q.preset));
  })();
  const [chosenPreset, setPreset] = useState<Preset | null>(null);
  const preset = chosenPreset ?? choices.at(-1)?.preset ?? "1080p";
  const [devices, setDevices] = useState<Device[]>(() => {
    const d = deviceForClient(client);
    return d ? [d] : [];
  });
  const [formats, setFormats] = useState<Format[]>(() =>
    devices.length > 0 ? formatsForDevices(devices, CLASSIC_FORMATS) : DEFAULT_MAKE_FORMATS,
  );
  // S3D-29: two equal edge styles, Filled preselected
  const [edge, setEdge] = useState<EdgeMode>("filled");
  const [fromScratch, setFromScratch] = useState(false);
  // "automatic" escapes for the inherited settings
  const [depthDefault, setDepthDefault] = useState(false);
  const [stereoDefault, setStereoDefault] = useState(false);
  // explicit opt-in: run against the project's uploaded depth map
  const [useUploadedDepth, setUseUploadedDepth] = useState(false);
  const numFrames = project.probe?.num_frames ?? 0;
  const [trim, setTrim] = useState<[number, number] | null>(null);
  const range: [number, number] = trim ?? [0, numFrames];

  const scenes = project.scenes;
  const lastDepthRun = (project.conversions ?? [])
    .filter((c) => c.step === "depth_preview" && c.state === "succeeded")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  const inheritedDepthRes = lastDepthRun?.params.depth_res;
  const depthUpload = project.depth_upload;
  const stereoDraft = loadStereoDraft(project.project_id, scenes?.version ?? 0);
  const sceneOverrides = draftToSceneOverrides(stereoDraft, [0, ...(scenes?.cuts ?? [])]);
  const hasStereoTweaks = sceneOverrides.length > 0 || stereoDraft.depth_scale !== 1;
  const sendUpload = useUploadedDepth && depthUpload !== undefined;
  const sendDepthRes = !sendUpload && !depthDefault && inheritedDepthRes !== undefined;
  const sendStereo = !stereoDefault && hasStereoTweaks;

  // everything but the edge style: the edge tiles price both styles
  const common: StepConversionRequest = {
    step: "production",
    preset,
    // always explicit — an empty list is rejected by the gateway
    formats: formats.length > 0 ? formats : DEFAULT_MAKE_FORMATS,
    ...trimFields(range, numFrames),
    ...(sendUpload ? { use_uploaded_depth: true } : {}),
    ...(sendDepthRes ? { depth_res: inheritedDepthRes } : {}),
    ...(sendStereo && stereoDraft.depth_scale !== 1
      ? { depth_scale: stereoDraft.depth_scale }
      : {}),
    ...(sendStereo && sceneOverrides.length > 0 ? { scene_overrides: sceneOverrides } : {}),
    // no target_fps: production's default IS the full source rate
    ...(fromScratch ? { from_scratch: true } : {}),
    platform: "web",
  };
  const request: StepConversionRequest = {
    ...common,
    formats,
    // Edge style drives BOTH wire fields (filled = propainter, sent
    // explicitly; stretched = backward warp + inpaint none)
    ...edgeModeRequest(edge),
  };
  const prices = usePresetPrices(
    project,
    { ...common, ...edgeModeRequest(edge) },
    choices.map((q) => q.preset),
    "classic",
  );
  const edgePrices = useVariantPrices(project, common, {
    stretched: edgeModeRequest("stretched"),
    filled: { ...edgeModeRequest("filled"), warp: undefined },
  });

  const ready = project.analyze.state === "succeeded" && project.probe && project.scenes;
  if (!ready) {
    return (
      <div data-testid="deliver-panel">
        <p className="rounded-xl border border-edge bg-surface-1 p-4 text-sm text-fg-muted">
          We&apos;re still looking through your video. Prices appear when
          it&apos;s done.
        </p>
      </div>
    );
  }
  const fps = parseRational(project.probe!.fps_rational);

  function change(apply: () => void): void {
    apply();
    ck.invalidate();
  }

  let n = 0;
  return (
    <div data-testid="deliver-panel" className="flex flex-col gap-4">
      <MoveToLifelikeOffer project={project} onChanged={() => onProjectChanged()} />
      <p className="-mt-1 text-xs text-fg-muted">
        Optional: check any 10 seconds on{" "}
        <a href="#tab=look" className="text-primary hover:underline">
          3D look
        </a>{" "}
        first.
      </p>
      <div className="grid items-start gap-4 lg:grid-cols-[1fr_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <MakeSection n={++n} title="Where will you watch it?" hint="Pick all that apply.">
            <WatchPicker
              devices={devices}
              onChange={(next) =>
                change(() => {
                  setDevices(next);
                  if (next.length > 0) setFormats(formatsForDevices(next, CLASSIC_FORMATS));
                })
              }
            />
          </MakeSection>

          <MakeSection n={++n} title="Files you'll get" hint="All included in the price.">
            <FileTiles
              offered={CLASSIC_FORMATS}
              formats={formats}
              onToggle={(f) =>
                change(() =>
                  setFormats((prev) =>
                    prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f],
                  ),
                )
              }
            />
          </MakeSection>

          <MakeSection n={++n} title="Quality">
            <QualityTiles
              choices={choices}
              value={preset}
              onChange={(p) => change(() => setPreset(p))}
              prices={prices}
              note={`With ${EDGE_NAMES[edge].toLowerCase()}. You can change this under Advanced.`}
            />
          </MakeSection>

          <MakeSection
            n={++n}
            title="Which part?"
            hint="Drag the handles to pay for just a part."
            aside={
              <span
                data-testid="trim-chip"
                className="rounded-full border border-edge bg-surface-2 px-2 py-0.5 text-[11px] text-fg-muted"
              >
                {trimChip(range, numFrames, fps)}
              </span>
            }
          >
            <TrimControl
              numFrames={numFrames}
              fps={fps}
              thumbs={project.strip_thumbs ?? []}
              value={range}
              onChange={(next) => change(() => setTrim(next))}
            />
          </MakeSection>

          <details
            data-testid="classic-advanced"
            className="rounded-xl border border-edge bg-surface-1 px-4 py-3"
          >
            <summary className="cursor-pointer text-sm font-medium text-fg-muted">
              Advanced
            </summary>
            <div className="mt-3 flex flex-col gap-5 text-sm">
              <div className="flex flex-col gap-2">
                <h4 className="text-xs font-medium text-fg-muted">Depth detail</h4>
                {inheritedDepthRes !== undefined ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      data-testid="deliver-chip-depth"
                      className={`rounded-full border px-2 py-0.5 text-xs ${
                        depthDefault
                          ? "border-edge bg-surface-2 text-fg-muted line-through"
                          : "border-primary/30 bg-primary/10 text-primary"
                      }`}
                    >
                      {inheritedDepthRes} px (from the Depth page)
                    </span>
                    <CheckboxChip
                      label="Use automatic depth detail"
                      checked={depthDefault}
                      onChange={() => change(() => setDepthDefault((v) => !v))}
                    />
                  </div>
                ) : (
                  <span data-testid="deliver-chip-depth-none" className="text-xs text-fg-muted">
                    Standard for this quality. Higher detail is set on the Depth page.
                  </span>
                )}
              </div>

              {depthUpload !== undefined ? (
                <div className="flex flex-col gap-2">
                  <h4 className="text-xs font-medium text-fg-muted">Your own depth map</h4>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      data-testid="deliver-chip-depth-upload"
                      className={`rounded-full border px-2 py-0.5 text-xs ${
                        sendUpload
                          ? "border-primary/30 bg-primary/10 text-primary"
                          : "border-edge bg-surface-2 text-fg-muted"
                      }`}
                    >
                      Uploaded depth video
                      {depthUpload.name ? ` · ${depthUpload.name}` : ""}
                    </span>
                    <CheckboxChip
                      label="Use my uploaded depth video"
                      checked={useUploadedDepth}
                      onChange={() => change(() => setUseUploadedDepth((v) => !v))}
                    />
                  </div>
                  <p className="text-xs text-fg-muted">Used as is; costs less.</p>
                </div>
              ) : null}

              <div className="flex flex-col gap-2">
                <h4 className="text-xs font-medium text-fg-muted">Scene settings</h4>
                {hasStereoTweaks ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      data-testid="deliver-chip-stereo"
                      className={`rounded-full border px-2 py-0.5 text-xs ${
                        stereoDefault
                          ? "border-edge bg-surface-2 text-fg-muted line-through"
                          : "border-primary/30 bg-primary/10 text-primary"
                      }`}
                    >
                      {sceneOverrides.length} scenes adjusted, 3D strength ×
                      {stereoDraft.depth_scale.toFixed(2)} (from the 3D look page)
                    </span>
                    <CheckboxChip
                      label="Use automatic 3D for every scene"
                      checked={stereoDefault}
                      onChange={() => change(() => setStereoDefault((v) => !v))}
                    />
                  </div>
                ) : (
                  <span data-testid="deliver-chip-stereo-none" className="text-xs text-fg-muted">
                    Every scene uses automatic 3D.
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <h4 id="edge-style" className="text-xs font-medium text-fg-muted">
                  Edges
                </h4>
                <div role="radiogroup" aria-labelledby="edge-style" className="grid grid-cols-2 gap-2">
                  {EDGE_OPTIONS.map((m) => (
                    <label
                      key={m}
                      data-testid={`edge-${m}`}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 ${
                        edge === m
                          ? "border-primary bg-primary/10 text-fg"
                          : "border-edge bg-surface-0 text-fg-muted"
                      }`}
                    >
                      <input
                        type="radio"
                        name="edge-style"
                        checked={edge === m}
                        onChange={() => change(() => setEdge(m))}
                        className="accent-primary"
                      />
                      <span className="font-medium">{EDGE_LABELS[m]}</span>
                      <span data-testid={`edge-price-${m}`} className="ml-auto font-mono text-xs">
                        {edgePrices[m] !== undefined ? formatCents(edgePrices[m]) : "…"}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <label
                htmlFor="production-from-scratch"
                className="flex cursor-pointer items-start gap-2"
              >
                <input
                  id="production-from-scratch"
                  type="checkbox"
                  checked={fromScratch}
                  onChange={(e) => change(() => setFromScratch(e.target.checked))}
                  className="mt-0.5 accent-primary"
                />
                <span>
                  Start from scratch
                  <span className="block text-xs text-fg-muted">
                    Don&apos;t reuse earlier work on this video. Full price.
                  </span>
                </span>
              </label>
            </div>
          </details>
        </div>

        <aside className="flex flex-col gap-3 lg:sticky lg:top-0">
          <InstantCheckout
            variant="panel"
            checkout={ck}
            request={request}
            label="Make 3D"
            disabledReason={formats.length === 0 ? "Pick at least one file" : undefined}
            heading={
              <div className="flex items-center gap-2">
                <h3 className="text-[15px] font-semibold text-fg">Your price</h3>
                <span className="ml-auto rounded-full border border-edge bg-surface-2 px-2 py-0.5 text-[11px] text-fg-muted">
                  Classic 3D
                </span>
              </div>
            }
            explain={cancelRule(ck.quote?.charge_timing, prechargeThreshold(limits))}
          />
        </aside>
      </div>
    </div>
  );
}
