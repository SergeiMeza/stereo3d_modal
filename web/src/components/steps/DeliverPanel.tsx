"use client";

/**
 * Deliver page (step production) — the final full-quality run.
 *
 * Layout mirrors the other pro pages (the shared StepReview): the
 * frame-exact source preview with the latest production output BESIDE it as
 * a follower of the same transport, and the timeline — review the final
 * deliverable against the source, scene by scene, with one set of controls.
 *
 * Production sends THE SAME depth_res / scene_overrides / depth_scale the
 * user set on the Depth and Stereo pages: depth_res from the last succeeded
 * depth run, per-scene tweaks from the shared stereo draft store
 * (localStorage). Summary chips make that inheritance explicit FIRST, each
 * with a "use pipeline default" escape. Presets and formats are the SAME
 * set the Stereo page previews (shared outputOptions). Compatible artifacts
 * are reused automatically — the quote's reuse_stages/discount lines show
 * it.
 *
 * There is NO displacement slider anywhere on the pro steps: per-scene
 * strength is scene_overrides[].displacement, the global multiplier is
 * depth_scale (both inherited here).
 */

import { useState } from "react";
import type { JSX, ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";
import type {
  Conversion,
  Format,
  Preset,
  Project,
  StepConversionRequest,
} from "@/lib/api/types";
import { parseRational } from "@/lib/frames";

import { CheckboxChip, Field, selectClass } from "./controls";
import {
  FORMAT_LABELS,
  INPAINT_LABELS,
  OUTPUT_FORMATS,
  RESOLUTION_PRESETS,
} from "./outputOptions";
import { PriorRuns } from "./PriorRuns";
import { draftToSceneOverrides, loadStereoDraft } from "./stereoStore";
import { bestPlayable, StepReview, useRunDownloads } from "./StepReview";
import { StepCheckoutSection, useStepCheckout } from "./useStepCheckout";

export interface DeliverPanelProps {
  project: Project;
  onProjectChanged: () => void;
}

export function DeliverPanel({
  project,
  onProjectChanged,
}: DeliverPanelProps): JSX.Element {
  const ck = useStepCheckout(project, "production", onProjectChanged);

  const [preset, setPreset] = useState<Preset>("1080p");
  const [formats, setFormats] = useState<Format[]>(["mvhevc", "half_sbs"]);
  const [fromScratch, setFromScratch] = useState(false);
  // "use pipeline default" escapes for the inherited settings
  const [depthDefault, setDepthDefault] = useState(false);
  const [stereoDefault, setStereoDefault] = useState(false);

  const productionRuns = (project.conversions ?? []).filter(
    (c) => c.step === "production",
  );
  const lastSucceeded = productionRuns
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
        <PanelCard>
          <p className="text-sm text-fg-muted">
            Analysis is still running — quotes unlock when it finishes.
          </p>
        </PanelCard>
      </PanelShell>
    );
  }
  const probe = project.probe!;
  const scenes = project.scenes!;
  const sourceFps = parseRational(probe.fps_rational);

  // ------------------------------------------------ inherited pipeline state
  const lastDepthRun = (project.conversions ?? [])
    .filter((c) => c.step === "depth_preview" && c.state === "succeeded")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  const inheritedDepthRes = lastDepthRun?.params.depth_res;
  const stereoDraft = loadStereoDraft(project.project_id, scenes.version);
  const sceneOverrides = draftToSceneOverrides(stereoDraft, [0, ...scenes.cuts]);
  const hasStereoTweaks =
    sceneOverrides.length > 0 || stereoDraft.depth_scale !== 1;

  const sendDepthRes = !depthDefault && inheritedDepthRes !== undefined;
  const sendStereo = !stereoDefault && hasStereoTweaks;

  function buildRequest(over: { fromScratch?: boolean } = {}): StepConversionRequest {
    const fs = over.fromScratch ?? fromScratch;
    return {
      step: "production",
      preset,
      ...(formats.length > 0 ? { formats } : {}),
      // Always full quality (propainter, also the gateway's production
      // default) — the cheap "splatted" opt-out is deliberately not
      // exposed in the UI this release.
      inpaint: "propainter",
      ...(sendDepthRes ? { depth_res: inheritedDepthRes } : {}),
      ...(sendStereo && stereoDraft.depth_scale !== 1
        ? { depth_scale: stereoDraft.depth_scale }
        : {}),
      ...(sendStereo && sceneOverrides.length > 0
        ? { scene_overrides: sceneOverrides }
        : {}),
      // no target_fps: production's gateway default IS the full source rate
      ...(fs ? { from_scratch: true } : {}),
      platform: "web",
    };
  }

  function toggleFromScratch(v: boolean): void {
    setFromScratch(v);
    if (ck.quote) void ck.fetchQuote(buildRequest({ fromScratch: v })); // re-quote with the new path
  }

  return (
    <PanelShell>
      <StepReview
        project={project}
        sourceFps={sourceFps}
        heading="Final output"
        headingExtras={
          output === null ? (
            <span className="text-[11px] text-fg-muted">
              Run production to review the final output beside the source.
            </span>
          ) : null
        }
        follower={
          output !== null
            ? {
                url: output.url,
                label: output.name,
                title:
                  "The latest production run's output, synced to the source transport (MV-HEVC is not browser-playable — download it below)",
                testId: "deliver-output-video",
              }
            : null
        }
      />

      <PanelCard>
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
          Inherited from your previews
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {inheritedDepthRes !== undefined ? (
            <>
              <span
                data-testid="deliver-chip-depth"
                className={`rounded-full border px-2 py-0.5 text-xs ${
                  depthDefault
                    ? "border-edge bg-surface-2 text-fg-muted line-through"
                    : "border-primary/30 bg-primary/10 text-primary"
                }`}
              >
                Depth {inheritedDepthRes} ×14 (from Depth page)
              </span>
              <CheckboxChip
                label="Use pipeline default depth resolution"
                checked={depthDefault}
                onChange={() => {
                  setDepthDefault((v) => !v);
                  ck.invalidate();
                }}
              />
            </>
          ) : (
            <span data-testid="deliver-chip-depth-none" className="text-xs text-fg-muted">
              No depth run yet — the preset&apos;s default depth resolution applies.
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasStereoTweaks ? (
            <>
              <span
                data-testid="deliver-chip-stereo"
                className={`rounded-full border px-2 py-0.5 text-xs ${
                  stereoDefault
                    ? "border-edge bg-surface-2 text-fg-muted line-through"
                    : "border-primary/30 bg-primary/10 text-primary"
                }`}
              >
                {sceneOverrides.length} scene overrides + depth_scale{" "}
                {stereoDraft.depth_scale.toFixed(2)} (from Stereo page)
              </span>
              <CheckboxChip
                label="Use pipeline defaults (adaptive)"
                checked={stereoDefault}
                onChange={() => {
                  setStereoDefault((v) => !v);
                  ck.invalidate();
                }}
              />
            </>
          ) : (
            <span data-testid="deliver-chip-stereo-none" className="text-xs text-fg-muted">
              No Stereo-page tweaks — every scene uses its adaptive profile.
            </span>
          )}
        </div>
        <p className="text-xs text-fg-muted">
          Production reuses compatible artifacts automatically — the quote
          shows each reused stage and its discount.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="production-preset" label="Preset">
          <select
            id="production-preset"
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

      <label
        htmlFor="production-from-scratch"
        className="flex cursor-pointer items-center gap-2"
      >
        <input
          id="production-from-scratch"
          type="checkbox"
          checked={fromScratch}
          onChange={(e) => toggleFromScratch(e.target.checked)}
          className="accent-primary"
        />
        <span className="text-xs">
          Start from scratch{" "}
          <span className="text-fg-muted">
            (skip artifact reuse — full price, nothing stale)
          </span>
        </span>
      </label>

      <StepCheckoutSection checkout={ck} request={buildRequest()} />
      </PanelCard>

      <PriorRuns
        title="Prior production runs"
        conversions={productionRuns}
        meta={(c) =>
          [
            c.params.preset,
            c.params.formats.join("+"),
            c.params.depth_res !== undefined ? `depth ${c.params.depth_res}` : null,
            c.params.inpaint ? INPAINT_LABELS[c.params.inpaint].toLowerCase() : null,
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
    <div data-testid="deliver-panel" className="flex flex-col gap-6">
      {children}
    </div>
  );
}

/** The params card. */
function PanelCard({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}
