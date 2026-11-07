"use client";

/**
 * Make 3D for Lifelike projects (screens 06 and 07, step production).
 * Left, numbered sections: where you'll watch it (S3D-07, multi-select,
 * preselecting the files), the split question for long videos (S3D-06,
 * before the run, "Split into parts" preselected), the files, the quality
 * tiles with this video's price each (S3D-04: only at or below the
 * source, real sizes), and which part (S3D-10 trim). Right, the price
 * card: the quote's lines, Ready in, the charging line with the cancel
 * rule behind "?", and ONE button "Make 3D · $X" (S3D-45). While a run
 * is going the tracker sits under the price card. Earlier full runs sit
 * first, in Previous runs (owner 2026-11-07), and a note by the button
 * says when the form matches one already made or being made.
 */

import { useState } from "react";
import type { JSX } from "react";

import {
  conversionMethod,
  type Format,
  type Preset,
  type Project,
  type StepConversionRequest,
} from "@/lib/api/types";
import { useLimits } from "@/lib/api/useLimits";
import { useAccountSettings } from "@/lib/useAccountSettings";
import { usePricing } from "@/lib/api/usePricing";
import { cancelRule, prechargeThreshold } from "@/lib/billingCopy";
import { parseRational } from "@/lib/frames";
import { barSides, withoutBars } from "@/lib/bars";
import { eyeSize, qualityChoices, resolutionName } from "@/lib/glossary";
import { BarsToggle } from "@/components/workspace/BarsSetting";

import {
  DEFAULT_MAKE_FORMATS,
  deviceForClient,
  DEVICES,
  FileTiles,
  formatsForDevices,
  MakeSection,
  partsEstimate,
  QualityTiles,
  TrimControl,
  trimChip,
  trimFields,
  usePresetPrices,
  WatchPicker,
  type Device,
} from "./makeControls";
import { lifelikeFormatsFor, SAMPLE_PROJECT, SPLIT_MAX_SECONDS } from "./methods";
import {
  BusinessNote,
  CinemaTierPrices,
  ProCheckoutSheet,
  QuoteProChoice,
  useQuoteProChoice,
} from "@/components/plans/QuotePlans";
import { FrameRatePicker, fpsLabel, PICK_FRAME_RATE, useFpsChoice } from "./frameRate";
import { useMake3dChoice } from "./make3dAtoms";
import { AlreadyMadeNote, PreviousRuns } from "./PreviousRuns";
import { InstantCheckout, useStepCheckout } from "./useStepCheckout";
import { useClient } from "./ViewIn3D";
import { FileQualityScale, qualitySteps } from "./FileQuality";
import { campaignBadge, campaignNote } from "@/lib/campaign";
import { FOVEATED_DETAIL, FOVEATED_HINT, foveationIncludedApplied, foveationIncludedAt } from "@/lib/foveation";

/** "Your video is N minutes long. …" — the split question. */
export function splitQuestion(outputSeconds: number): string {
  const minutes = Math.max(1, Math.round(outputSeconds / 60));
  return `Your video is ${minutes} minutes long. Split it into ${Math.round(
    SPLIT_MAX_SECONDS / 60,
  )}-minute parts so each file plays smoothly?`;
}

/** Express in words (owner 2026-11-07): first in line, and no promise of
 * time saved. */
export const EXPRESS_HINT = "First in line.";

function AddOnRow({
  testId,
  label,
  price,
  hint,
  checked,
  onChange,
}: {
  testId: string;
  label: string;
  price: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <div data-testid={testId} className="flex flex-col gap-1.5">
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="accent-primary"
        />
        {label} <span className="text-xs text-fg-muted">{price}</span>
      </label>
      <p className="pl-6 text-xs text-fg-muted">{hint}</p>
    </div>
  );
}

export interface LifelikeDeliverPanelProps {
  project: Project;
  onProjectChanged: () => void;
}

/** owner 2026-11-05: HDR output is automatic and free (no control); the
 * side-by-side files stay in standard colour for headsets without HDR. */
export function hdrLine(formats: readonly Format[]): string {
  const base = "Your 3D will be in HDR, so bright highlights and rich colour are kept. Free.";
  return formats.some((f) => f === "sbs" || f === "half_sbs")
    ? `${base} Side-by-side files are made in standard colour for headsets that don't show HDR.`
    : base;
}

export { withoutBars } from "@/lib/bars";

export function LifelikeDeliverPanel({
  project,
  onProjectChanged,
}: LifelikeDeliverPanelProps): JSX.Element {
  const ck = useStepCheckout(project, "production", onProjectChanged);
  const limits = useLimits();
  const choices = qualityChoices(project);
  // ADR 0138: the picks live in one atom per project (make3dAtoms)
  const pid = project.project_id;
  const [chosenPreset, setPreset] = useMake3dChoice(pid, "preset");
  const preset = chosenPreset ?? choices.at(-1)?.preset ?? "1080p";
  // S3D-47: in a headset browser, that headset comes preselected
  const client = useClient();
  // onboarding (owner 2026-11-04): otherwise the headsets the person
  // named in the welcome, until they change the pick here
  const headsets = useAccountSettings().settings?.headsets;
  const [devicesChoice, setDevices] = useMake3dChoice(pid, "devices");
  const inUse = deviceForClient(client);
  const devices: Device[] =
    devicesChoice ??
    (inUse
      ? [inUse]
      : (headsets ?? []).filter((h): h is Device => DEVICES.some((d) => d.id === h)));
  // the devices preselect the files for the chosen quality (Meta Quest:
  // full side by side up to 3K, half above; owner 2026-11-04) until the
  // person ticks or unticks a file themselves
  const [formatsChoice, setFormats] = useMake3dChoice(pid, "formats");
  const formats: Format[] =
    formatsChoice ??
    (devices.length > 0
      ? formatsForDevices(devices, lifelikeFormatsFor(choices.find((q) => q.preset === preset) ?? { preset }), preset)
      : DEFAULT_MAKE_FORMATS);
  // S3D-06: preselected; only asked (and only sent) when the quote says the
  // output runs past 15 minutes
  const [split, setSplit] = useMake3dChoice(pid, "split");
  const numFrames = project.probe?.num_frames ?? 0;
  const [trim, setTrim] = useMake3dChoice(pid, "trim");
  const range: [number, number] = trim ?? [0, numFrames];
  // S3D-48: under Advanced up to 4K, unticked; Left when ticked
  const [optionalEye, setOptionalEye] = useMake3dChoice(pid, "optionalEye");
  // S3D-65: 5K, 6K and 8K keep one eye original — ticked and locked there,
  // Left by default; up to 4K it stays optional and unticked
  const [requiredEye, setRequiredEye] = useMake3dChoice(pid, "requiredEye");
  // S3D-50: Foveated Detail, ticked by default whenever it's shown
  const [foveated, setFoveated] = useMake3dChoice(pid, "foveated");
  // owner 2026-11-07: File quality, Standard · High · Master (High and
  // Master take their share from /v1/pricing); it replaced the Mbit/s
  // list and the Master bitrate add-on. Express is included in Business
  // and Studio, where it starts ticked; its share comes from /v1/pricing
  const pricing = usePricing();
  const addons = pricing?.addons;
  const [fileQuality, setFileQuality] = useMake3dChoice(pid, "quality");
  const qualityOffered = qualitySteps(pricing).length > 1;
  // owner 2026-11-07: the launch offer marks the qualities it covers
  const offerBadges = Object.fromEntries(
    choices.flatMap((q) => {
      const b = campaignBadge(pricing, q.preset);
      return b ? [[q.preset, b]] : [];
    }),
  ) as Partial<Record<Preset, string>>;
  const [expressChoice, setExpress] = useMake3dChoice(pid, "express");
  // plans canvas, Quote A: pay once (always first) or with Pro
  const [payMode, setPayMode] = useMake3dChoice(pid, "payMode");
  const [proSheet, setProSheet] = useState(false);
  const proChoice = useQuoteProChoice(ck.quote);
  const withPro = payMode === "pro" && proChoice !== null;
  const chosen = choices.find((q) => q.preset === preset);
  const eyeRequired = chosen?.originalEyeRequired === true;
  const originalEye = eyeRequired ? requiredEye : optionalEye;
  const sourceShort = project.probe
    ? Math.min(project.probe.width, project.probe.height)
    : 0;
  // owner 2026-11-07: free and always on at the qualities /v1/pricing
  // lists as included (1080p): no toggle there, the quote says whether it
  // applies
  const foveationIncluded = foveationIncludedAt(pricing, preset);
  // elsewhere an add-on: only below the video's own size, and only when
  // the gateway offers it
  const foveationOffered =
    !foveationIncluded &&
    limits?.methods?.lifelike?.foveation === true &&
    chosen?.eyeShort !== undefined &&
    chosen.eyeShort < sourceShort;

  // 6K and 8K make no full side-by-side file (half SBS and spatial are)
  const offeredFormats = lifelikeFormatsFor(chosen ?? { preset });
  const sentFormats = formats.filter((f) => offeredFormats.includes(f));
  // the last quote's plan, steady while a change re-prices
  const tier = ck.lastQuote?.tier ?? "";
  // included Foveated Detail shows only when this quality's quote says it
  // applies (a source at 1080p or below gets none, and nothing shows)
  const foveationShownIncluded =
    foveationIncluded &&
    ck.lastQuote?.params?.preset === preset &&
    foveationIncludedApplied(ck.lastQuote?.foveation);
  const expressIncluded = addons?.express?.included_in?.includes(tier) === true;
  const express = expressChoice ?? expressIncluded;
  const plain: StepConversionRequest = {
    step: "production",
    preset,
    formats: sentFormats.length > 0 ? sentFormats : offeredFormats.slice(0, 1),
    ...trimFields(range, numFrames),
    ...(originalEye ? { original_eye: originalEye } : {}),
    // always sent where offered, so the quote says what the files come to
    ...(qualityOffered ? { quality: fileQuality } : {}),
    ...(addons?.express && express ? { express: true } : {}),
    // shown: ticked sends "static", unticked sends null; hidden: absent
    ...(foveationOffered ? { foveation: foveated ? ("static" as const) : null } : {}),
    platform: "web",
  };
  // owner 2026-11-04: above 30 fps the frame rate is a required choice
  const fpsChoice = useFpsChoice(project, "production", plain);
  const base: StepConversionRequest = { ...plain, ...fpsChoice.field };
  const fpsMissing = fpsChoice.required && fpsChoice.value === null;
  const prices = usePresetPrices(
    project,
    base,
    choices.map((q) => q.preset),
    "lifelike",
    Object.fromEntries(
      choices
        .filter((q) => q.originalEyeRequired)
        .map((q) => [q.preset, { original_eye: originalEye ?? requiredEye }]),
    ),
  );

  const ready =
    project.analyze.state === "succeeded" && project.probe && project.scenes;
  if (!ready) {
    return (
      <div data-testid="lifelike-deliver-panel">
        <p className="rounded-xl border border-edge bg-surface-1 p-4 text-sm text-fg-muted">
          We&apos;re still analyzing your video. Prices appear when
          it&apos;s done.
        </p>
      </div>
    );
  }
  const probe = project.probe!;
  const fps = parseRational(probe.fps_rational);

  const splitOffered = ck.lastQuote?.split_suggested === true;
  const request: StepConversionRequest = {
    ...base,
    formats: sentFormats,
    ...(splitOffered && split ? { split_max_seconds: SPLIT_MAX_SECONDS } : {}),
  };
  const outputSeconds = ck.quote?.output_seconds ?? probe.duration_s;
  const hasFiles = (project.conversions ?? []).some(
    (c) =>
      c.step === "production" &&
      conversionMethod(c) === "lifelike" &&
      c.state === "succeeded",
  );

  function change(apply: () => void): void {
    apply();
    ck.invalidate();
  }

  let n = 0;
  return (
    <div
      data-testid="lifelike-deliver-panel"
      className="grid items-start gap-4 pb-24 lg:grid-cols-[1fr_340px] lg:pb-0"
    >
      <div className="flex min-w-0 flex-col gap-4">
        <PreviousRuns project={project} active={ck.active} />
        <MakeSection n={++n} title="Where will you watch it?" hint="Pick all that apply.">
          <WatchPicker
            devices={devices}
            onChange={(next) =>
              change(() => {
                setDevices(next);
                // owner 2026-11-05: the devices preselect the files only
                // while none were ticked by hand; a pick is never overwritten
              })
            }
          />
        </MakeSection>

        {splitOffered && !ck.running ? (
          <MakeSection
            n={++n}
            testId="split-prompt"
            title={splitQuestion(outputSeconds)}
            hint="Parts end at a scene change. No extra charge."
          >
            <div role="radiogroup" aria-label="Split into parts" className="flex flex-col gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="lifelike-split"
                  checked={split}
                  onChange={() => setSplit(true)}
                  className="accent-primary"
                />
                Split into parts
                <span className="text-xs text-fg-muted">
                  {partsEstimate(outputSeconds, SPLIT_MAX_SECONDS)}
                </span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="lifelike-split"
                  checked={!split}
                  onChange={() => setSplit(false)}
                  className="accent-primary"
                />
                Keep as one file
              </label>
            </div>
          </MakeSection>
        ) : null}

        <MakeSection n={++n} title="Files you'll get" hint="All included in the price.">
          <FileTiles
            offered={offeredFormats}
            formats={formats}
            onToggle={(f) =>
              change(() =>
                setFormats(
                  formats.includes(f) ? formats.filter((x) => x !== f) : [...formats, f],
                ),
              )
            }
          />
          {project.hdr_output === true ? (
            <p data-testid="make-hdr" className="text-xs text-fg-muted">
              {hdrLine(sentFormats)}
            </p>
          ) : null}
        </MakeSection>

        <MakeSection n={++n} title="Quality">
          <QualityTiles
            choices={withoutBars(choices, project)}
            value={preset}
            onChange={(p) => change(() => setPreset(p))}
            prices={prices}
            badges={offerBadges}
            note={
              [
                choices.length === 1
                  ? `Your video is ${resolutionName(probe)}.`
                  : choices.some((q) => q.label.startsWith("Full resolution"))
                    ? "Full resolution is your video's own size, priced like the step below it."
                    : null,
                // owner 2026-11-07: the launch offer, in the gateway's words
                Object.keys(offerBadges).length > 0 ? campaignNote(pricing) : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
          />
          {/* owner request 2026-11-04: the black bars setting, as on Overview */}
          {barSides(project) !== null ? (
            <div className="border-t border-edge pt-3">
              <BarsToggle
                project={project}
                fullSize={probe && chosen?.eyeShort ? eyeSize(probe, chosen.eyeShort) : null}
                onProjectChanged={() => change(() => onProjectChanged())}
              />
            </div>
          ) : null}
          {eyeRequired || foveationOffered || foveationShownIncluded || qualityOffered || addons?.express ? (
          <div className="flex flex-col gap-3 border-t border-edge pt-3">
            {eyeRequired ? (
              // S3D-65: always on at 5K, 6K and 8K — shown as fixed
              <div data-testid="original-eye-fixed" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
                <span className="flex items-center gap-2">
                  <input type="checkbox" checked disabled aria-label="Keep one eye as the original" className="accent-primary" />
                  Keep one eye as the original
                </span>
                <EyePicker value={requiredEye} onChange={(e) => change(() => setRequiredEye(e))} />
                <span className="text-xs text-fg-muted">Always on at this quality</span>
              </div>
            ) : null}
            {foveationShownIncluded ? (
              <div data-testid="foveated-included" className="flex flex-col gap-1.5">
                <p className="text-sm">
                  {FOVEATED_DETAIL} <span className="text-fg-muted">· included</span>
                </p>
                <p className="text-xs text-fg-muted">{FOVEATED_HINT}</p>
              </div>
            ) : null}
            {foveationOffered ? (
              <div className="flex flex-col gap-1.5">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={foveated}
                    onChange={(e) => change(() => setFoveated(e.target.checked))}
                    className="accent-primary"
                  />
                  Foveated Detail
                  {/* the add-on's share from /v1/pricing, like Master and Express */}
                  {addons?.foveated?.pct ? (
                    <span data-testid="foveated-pct" className="text-xs text-fg-muted">
                      +{Math.round(addons.foveated.pct * 100)}%
                    </span>
                  ) : null}
                </label>
                <p className="pl-6 text-xs text-fg-muted">{FOVEATED_HINT}</p>
              </div>
            ) : null}
            {qualityOffered ? (
              <FileQualityScale
                value={fileQuality}
                onChange={(q) => change(() => setFileQuality(q))}
                pricing={pricing}
                quality={ck.lastQuote?.quality}
                sizeBytes={ck.lastQuote?.estimated_size_bytes}
              />
            ) : null}
            {addons?.express ? (
              <AddOnRow
                testId="addon-express"
                label="Express"
                price={expressIncluded ? "Included" : `+${Math.round(addons.express.pct * 100)}%`}
                hint={EXPRESS_HINT}
                checked={express}
                onChange={(v) => change(() => setExpress(v))}
              />
            ) : null}
          </div>
          ) : null}
        </MakeSection>

        {fpsChoice.required ? (
          <MakeSection
            n={++n}
            testId="fps-section"
            title="Frame rate"
            hint={`Your video is ${fpsLabel(project.probe?.fps ?? 0)}. Pick the rate to make it at.`}
          >
            <FrameRatePicker
              choice={fpsChoice}
              onChange={(v) => change(() => fpsChoice.set(v))}
            />
          </MakeSection>
        ) : null}

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
          data-testid="lifelike-advanced"
          className="rounded-xl border border-edge bg-surface-1 px-4 py-3"
        >
          <summary className="cursor-pointer text-sm font-medium text-fg-muted">
            Advanced
          </summary>
          <div className="mt-3 flex flex-col gap-4">
            {!eyeRequired ? (
              <div data-testid="original-eye-optional" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={optionalEye !== null}
                    onChange={(e) => change(() => setOptionalEye(e.target.checked ? "left" : null))}
                    className="accent-primary"
                  />
                  Keep one eye as the original
                </label>
                {optionalEye !== null ? (
                  <EyePicker value={optionalEye} onChange={(e) => change(() => setOptionalEye(e))} />
                ) : null}
              </div>
            ) : null}
          </div>
        </details>
      </div>

      <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-0">
        <InstantCheckout
          variant="panel"
          checkout={ck}
          request={request}
          label="Make 3D"
          disabledReason={
            project.sample
              ? SAMPLE_PROJECT
              : sentFormats.length === 0
              ? "Pick at least one file"
              : fpsMissing
                ? PICK_FRAME_RATE
                : undefined
          }
          heading={
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-semibold text-fg">Your price</h3>
              <span className="ll-chip ml-auto rounded-full px-2 py-0.5 text-[11px]">
                Lifelike 3D
              </span>
            </div>
          }
          explain={cancelRule(ck.quote?.charge_timing, prechargeThreshold(limits))}
          beforeButton={(q) => (
            <>
              <QuoteProChoice quote={q} mode={payMode} onMode={setPayMode} />
              <CinemaTierPrices quote={q} projectId={project.project_id} />
              <BusinessNote quote={q} projectId={project.project_id} probe={project.probe} />
            </>
          )}
          primary={withPro ? { label: "Subscribe and convert", onClick: () => setProSheet(true) } : null}
          after={
            <>
              <AlreadyMadeNote project={project} active={ck.active} request={request} />
              {hasFiles ? (
                <a href="#tab=files" className="text-center text-xs text-primary hover:underline">
                  Your earlier files are in Files
                </a>
              ) : null}
            </>
          }
        />
        {ck.quote ? (
          <ProCheckoutSheet
            open={proSheet}
            quote={ck.quote}
            onClose={() => setProSheet(false)}
            onPayOnce={() => {
              setProSheet(false);
              setPayMode("once");
            }}
            onPurchased={() => {
              // Pro is on: the quote re-prices; the person still taps Make 3D
              setProSheet(false);
              setPayMode("once");
              ck.invalidate();
            }}
          />
        ) : null}
      </aside>
    </div>
  );
}

/** Left | Right, as a compact segmented pair. */
function EyePicker({
  value,
  onChange,
}: {
  value: "left" | "right";
  onChange: (e: "left" | "right") => void;
}): JSX.Element {
  return (
    <span
      role="radiogroup"
      aria-label="Which eye"
      className="inline-flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5 text-xs"
    >
      {(["left", "right"] as const).map((eye) => (
        <button
          key={eye}
          type="button"
          role="radio"
          aria-checked={value === eye}
          onClick={() => onChange(eye)}
          className={`rounded px-2.5 py-1 ${
            value === eye ? "bg-surface-0 text-fg shadow-sm" : "text-fg-muted hover:text-fg"
          }`}
        >
          {eye === "left" ? "Left" : "Right"}
        </button>
      ))}
    </span>
  );
}
