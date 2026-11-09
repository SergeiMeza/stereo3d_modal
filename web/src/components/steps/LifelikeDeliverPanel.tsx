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
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";

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
import { lifelikeFormatsFor, sampleProject, SPLIT_MAX_SECONDS } from "./methods";
import {
  BusinessNote,
  CinemaTierPrices,
  ProCheckoutSheet,
  QuoteProChoice,
  useQuoteProChoice,
} from "@/components/plans/QuotePlans";
import { FrameRatePicker, fpsLabel, pickFrameRate, useFpsChoice } from "./frameRate";
import { useMake3dChoice } from "./make3dAtoms";
import { AlreadyMadeNote, PreviousRuns } from "./PreviousRuns";
import { InstantCheckout, useStepCheckout } from "./useStepCheckout";
import { useClient } from "./ViewIn3D";
import { FileQualityScale, qualitySteps } from "./FileQuality";
import { campaignBadge, campaignNote } from "@/lib/campaign";
import { foveatedDetail, foveatedHint, foveationIncludedApplied, foveationIncludedAt } from "@/lib/foveation";
import { useBilling } from "@/lib/billing";
import {
  commercialHint,
  commercialIncluded,
  commercialIncludedLine,
  commercialIncludedUntil,
  commercialName,
  commercialPct,
} from "@/lib/commercial";
import { depthField } from "@/lib/depthChoice";
import { stabilizeHint, stabilizeName, stabilizePct, stabilizeShare } from "@/lib/stabilize";
import { DepthChoice } from "./DepthChoice";

/** "Your video is N minutes long. …" — the split question. */
export function splitQuestion(outputSeconds: number, t: Tr = EN): string {
  const minutes = Math.max(1, Math.round(outputSeconds / 60));
  return t("make.lifelike.splitQuestion", { minutes, part: Math.round(SPLIT_MAX_SECONDS / 60) });
}

/** Express in words (owner 2026-11-07): first in line, and no promise of
 * time saved. */
export const EXPRESS_HINT = EN("make.lifelike.expressHint");

function AddOnRow({
  testId,
  label,
  price,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  testId: string;
  label: string;
  price: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  /** shown ticked and fixed (a plan includes it) */
  disabled?: boolean;
}): JSX.Element {
  return (
    <div data-testid={testId} className="flex flex-col gap-1.5">
      <label className={`flex items-center gap-2 text-sm ${disabled ? "" : "cursor-pointer"}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="accent-primary"
        />
        {label} <span className="ltr text-xs text-fg-muted">{price}</span>
      </label>
      <p className="ps-6 text-xs text-fg-muted">{hint}</p>
    </div>
  );
}

export interface LifelikeDeliverPanelProps {
  project: Project;
  onProjectChanged: () => void;
}

/** owner 2026-11-05: HDR output is automatic and free (no control); the
 * side-by-side files stay in standard colour for headsets without HDR. */
export function hdrLine(formats: readonly Format[], t: Tr = EN): string {
  return formats.some((f) => f === "sbs" || f === "half_sbs")
    ? t("make.lifelike.hdrWithSbs")
    : t("make.lifelike.hdr");
}

export { withoutBars } from "@/lib/bars";

export function LifelikeDeliverPanel({
  project,
  onProjectChanged,
}: LifelikeDeliverPanelProps): JSX.Element {
  const t = useT();
  const ck = useStepCheckout(project, "production", onProjectChanged);
  const limits = useLimits();
  const choices = qualityChoices(project, t);
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
      const b = campaignBadge(pricing, q.preset, "lifelike", t);
      return b ? [[q.preset, b]] : [];
    }),
  ) as Partial<Record<Preset, string>>;
  const [expressChoice, setExpress] = useMake3dChoice(pid, "express");
  const [commercialChoice, setCommercial] = useMake3dChoice(pid, "commercial");
  // owner 2026-11-10: Smoother motion (+10% on any plan, its share from
  // /v1/pricing) and the 3D depth (no price change, shared with the preview)
  const [stabilizeChoice, setStabilize] = useMake3dChoice(pid, "stabilize");
  const [depth, setDepth] = useMake3dChoice(pid, "depth");
  const plan = useBilling().status?.plan;
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
  // owner 2026-11-09: Commercial use, +50% on any plan (its share from
  // /v1/pricing); a plan active on 2026-11-09 includes it until its
  // renewal, shown ticked and included
  const commercialShare = commercialPct(pricing);
  const commercialUntil = commercialIncludedUntil(plan);
  const commercialFree = commercialIncluded(plan, ck.lastQuote?.quote.breakdown);
  const commercial = commercialShare !== null && (commercialFree || commercialChoice);
  const stabilizeOffered = stabilizePct(pricing);
  const stabilize = stabilizeOffered !== null && stabilizeChoice;
  const plain: StepConversionRequest = {
    step: "production",
    preset,
    formats: sentFormats.length > 0 ? sentFormats : offeredFormats.slice(0, 1),
    ...trimFields(range, numFrames),
    ...(originalEye ? { original_eye: originalEye } : {}),
    // always sent where offered, so the quote says what the files come to
    ...(qualityOffered ? { quality: fileQuality } : {}),
    ...(addons?.express && express ? { express: true } : {}),
    ...(commercial ? { commercial: true } : {}),
    ...(stabilize ? { stabilize: true } : {}),
    ...depthField(depth),
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
          {t("make.deliver.analyzing")}
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
        <MakeSection n={++n} title={t("make.controls.watchQuestion")} hint={t("make.deliver.pickAll")}>
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
            title={splitQuestion(outputSeconds, t)}
            hint={t("make.lifelike.splitHint")}
          >
            <div role="radiogroup" aria-label={t("make.lifelike.splitIntoParts")} className="flex flex-col gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="lifelike-split"
                  checked={split}
                  onChange={() => setSplit(true)}
                  className="accent-primary"
                />
                {t("make.lifelike.splitIntoParts")}
                <span className="text-xs text-fg-muted">
                  {partsEstimate(outputSeconds, SPLIT_MAX_SECONDS, t)}
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
                {t("make.lifelike.keepOneFile")}
              </label>
            </div>
          </MakeSection>
        ) : null}

        <MakeSection n={++n} title={t("make.controls.filesYoullGet")} hint={t("make.deliver.allIncluded")}>
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
              {hdrLine(sentFormats, t)}
            </p>
          ) : null}
        </MakeSection>

        <MakeSection n={++n} title={t("make.controls.quality")}>
          <QualityTiles
            choices={withoutBars(choices, project)}
            value={preset}
            onChange={(p) => change(() => setPreset(p))}
            prices={prices}
            badges={offerBadges}
            note={
              [
                choices.length === 1
                  ? t("make.lifelike.yourVideoIs", { resolution: resolutionName(probe) })
                  : choices.some(
                        (q) =>
                          q.label.startsWith("Full resolution") ||
                          q.label === t("glossary.fullResolution", { short: String(q.eyeShort) }),
                      )
                    ? t("make.lifelike.fullResolutionNote")
                    : null,
                // owner 2026-11-07: the launch offer, in the gateway's words
                Object.keys(offerBadges).length > 0 ? campaignNote(pricing, t) : null,
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
          <div className="border-t border-edge pt-3">
            <DepthChoice value={depth} onChange={(d) => change(() => setDepth(d))} />
          </div>
          {eyeRequired || foveationOffered || foveationShownIncluded || qualityOffered || addons?.express || stabilizeOffered !== null || commercialShare !== null ? (
          <div className="flex flex-col gap-3 border-t border-edge pt-3">
            {eyeRequired ? (
              // S3D-65: always on at 5K, 6K and 8K — shown as fixed
              <div data-testid="original-eye-fixed" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
                <span className="flex items-center gap-2">
                  <input type="checkbox" checked disabled aria-label={t("make.lifelike.keepOneEye")} className="accent-primary" />
                  {t("make.lifelike.keepOneEye")}
                </span>
                <EyePicker value={requiredEye} onChange={(e) => change(() => setRequiredEye(e))} />
                <span className="text-xs text-fg-muted">{t("make.lifelike.alwaysOn")}</span>
              </div>
            ) : null}
            {foveationShownIncluded ? (
              <div data-testid="foveated-included" className="flex flex-col gap-1.5">
                <p className="text-sm">
                  {foveatedDetail(t)} <span className="text-fg-muted">{t("make.lifelike.includedDot")}</span>
                </p>
                <p className="text-xs text-fg-muted">{foveatedHint(t)}</p>
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
                  {foveatedDetail(t)}
                  {/* the add-on's share from /v1/pricing, like Master and Express */}
                  {addons?.foveated?.pct ? (
                    <span data-testid="foveated-pct" className="ltr text-xs text-fg-muted">
                      +{Math.round(addons.foveated.pct * 100)}%
                    </span>
                  ) : null}
                </label>
                <p className="ps-6 text-xs text-fg-muted">{foveatedHint(t)}</p>
              </div>
            ) : null}
            {qualityOffered ? (
              <FileQualityScale
                value={fileQuality}
                onChange={(q) => change(() => setFileQuality(q))}
                pricing={pricing}
                quality={ck.lastQuote?.quality}
                sizeBytes={ck.lastQuote?.estimated_size_bytes}
                quote={ck.lastQuote}
              />
            ) : null}
            {addons?.express ? (
              <AddOnRow
                testId="addon-express"
                label={t("quote.view.express")}
                price={expressIncluded ? t("quote.view.included") : `+${Math.round(addons.express.pct * 100)}%`}
                hint={t("make.lifelike.expressHint")}
                checked={express}
                onChange={(v) => change(() => setExpress(v))}
              />
            ) : null}
            {stabilizeOffered !== null ? (
              <AddOnRow
                testId="addon-stabilize"
                label={stabilizeName(t)}
                price={stabilizeShare(stabilizeOffered)}
                hint={stabilizeHint(t)}
                checked={stabilize}
                onChange={(v) => change(() => setStabilize(v))}
              />
            ) : null}
            {commercialShare !== null ? (
              <AddOnRow
                testId="addon-commercial"
                label={commercialName(t)}
                price={commercialFree ? commercialIncludedLine(commercialUntil, t) : `+${Math.round(commercialShare * 100)}%`}
                hint={commercialHint(t)}
                checked={commercial}
                disabled={commercialFree}
                onChange={(v) => change(() => setCommercial(v))}
              />
            ) : null}
          </div>
          ) : null}
        </MakeSection>

        {fpsChoice.required ? (
          <MakeSection
            n={++n}
            testId="fps-section"
            title={t("make.fps.label")}
            hint={t("make.lifelike.fpsHint", { fps: fpsLabel(project.probe?.fps ?? 0, t) })}
          >
            <FrameRatePicker
              choice={fpsChoice}
              onChange={(v) => change(() => fpsChoice.set(v))}
            />
          </MakeSection>
        ) : null}

        <MakeSection
          n={++n}
          title={t("make.deliver.whichPart")}
          hint={t("make.deliver.whichPartHint")}
          aside={
            <span
              data-testid="trim-chip"
              className="rounded-full border border-edge bg-surface-2 px-2 py-0.5 text-[11px] text-fg-muted"
            >
              {trimChip(range, numFrames, fps, t)}
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
            {t("make.deliver.advanced")}
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
                  {t("make.lifelike.keepOneEye")}
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
          label={t("make.deliver.makeLabel")}
          disabledReason={
            project.sample
              ? sampleProject(t)
              : sentFormats.length === 0
              ? t("make.deliver.pickOneFile")
              : fpsMissing
                ? pickFrameRate(t)
                : undefined
          }
          heading={
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-semibold text-fg">{t("quote.view.yourPrice")}</h3>
              <span className="ll-chip ms-auto rounded-full px-2 py-0.5 text-[11px]">
                Lifelike 3D
              </span>
            </div>
          }
          explain={cancelRule(ck.quote?.charge_timing, prechargeThreshold(limits), t)}
          beforeButton={(q) => (
            <>
              <QuoteProChoice quote={q} mode={payMode} onMode={setPayMode} />
              <CinemaTierPrices quote={q} projectId={project.project_id} />
              <BusinessNote quote={q} projectId={project.project_id} probe={project.probe} />
            </>
          )}
          primary={withPro ? { label: t("make.lifelike.subscribeAndConvert"), onClick: () => setProSheet(true) } : null}
          after={
            <>
              <AlreadyMadeNote project={project} active={ck.active} request={request} />
              {hasFiles ? (
                <a href="#tab=files" className="text-center text-xs text-primary hover:underline">
                  {t("make.lifelike.earlierFiles")}
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
  const t = useT();
  return (
    <span
      role="radiogroup"
      aria-label={t("make.lifelike.whichEye")}
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
          {eye === "left" ? t("make.lifelike.left") : t("make.lifelike.right")}
        </button>
      ))}
    </span>
  );
}
