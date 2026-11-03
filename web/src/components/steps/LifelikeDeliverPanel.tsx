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
 * is going the tracker sits under the price card.
 */

import { useState } from "react";
import type { JSX } from "react";

import {
  conversionMethod,
  type Bitrate,
  type Format,
  type Preset,
  type Project,
  type StepConversionRequest,
} from "@/lib/api/types";
import { useLimits } from "@/lib/api/useLimits";
import { usePricing } from "@/lib/api/usePricing";
import { cancelRule, prechargeThreshold } from "@/lib/billingCopy";
import { parseRational } from "@/lib/frames";
import { qualityChoices, resolutionName } from "@/lib/glossary";

import {
  BitrateControl,
  bitrateField,
  DEFAULT_MAKE_FORMATS,
  deviceForClient,
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
import { LIFELIKE_FORMATS, lifelikeFormatsFor, SPLIT_MAX_SECONDS } from "./methods";
import { FrameRatePicker, fpsLabel, PICK_FRAME_RATE, useFpsChoice } from "./frameRate";
import { InstantCheckout, useStepCheckout } from "./useStepCheckout";
import { useClient } from "./ViewIn3D";

/** "Your video is N minutes long. …" — the split question. */
export function splitQuestion(outputSeconds: number): string {
  const minutes = Math.max(1, Math.round(outputSeconds / 60));
  return `Your video is ${minutes} minutes long. Split it into ${Math.round(
    SPLIT_MAX_SECONDS / 60,
  )}-minute parts so each file plays smoothly?`;
}

/** Express's honest saving from the quote (00081 express_eta): about a
 * minute on short clips, up to about 2× on long ones. */
export function expressHint(eta?: { eta_seconds: number; standard_eta_seconds: number }): string {
  if (!eta || eta.standard_eta_seconds <= 0 || eta.eta_seconds >= eta.standard_eta_seconds) {
    return "Faster: first in line.";
  }
  if (eta.standard_eta_seconds / Math.max(eta.eta_seconds, 1) >= 1.6) {
    return "First in line. Up to about 2× faster on longer videos.";
  }
  const min = Math.max(1, Math.round((eta.standard_eta_seconds - eta.eta_seconds) / 60));
  return `First in line. About ${min} min faster.`;
}

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

export function LifelikeDeliverPanel({
  project,
  onProjectChanged,
}: LifelikeDeliverPanelProps): JSX.Element {
  const ck = useStepCheckout(project, "production", onProjectChanged);
  const limits = useLimits();
  const choices = qualityChoices(project);
  const [chosenPreset, setPreset] = useState<Preset | null>(null);
  const preset = chosenPreset ?? choices.at(-1)?.preset ?? "1080p";
  // S3D-47: in a headset browser, that headset comes preselected
  const client = useClient();
  const [devices, setDevices] = useState<Device[]>(() => {
    const d = deviceForClient(client);
    return d ? [d] : [];
  });
  const [formats, setFormats] = useState<Format[]>(() =>
    devices.length > 0
      ? formatsForDevices(devices, LIFELIKE_FORMATS)
      : DEFAULT_MAKE_FORMATS,
  );
  // S3D-06: preselected; only asked (and only sent) when the quote says the
  // output runs past 15 minutes
  const [split, setSplit] = useState(true);
  const numFrames = project.probe?.num_frames ?? 0;
  const [trim, setTrim] = useState<[number, number] | null>(null);
  const range: [number, number] = trim ?? [0, numFrames];
  // S3D-48: under Advanced up to 4K, unticked; Left when ticked
  const [optionalEye, setOptionalEye] = useState<"left" | "right" | null>(null);
  // S3D-65: 5K, 6K and 8K keep one eye original — ticked and locked there,
  // Left by default; up to 4K it stays optional and unticked
  const [requiredEye, setRequiredEye] = useState<"left" | "right">("left");
  // S3D-50: Foveated Detail, ticked by default whenever it's shown
  const [foveated, setFoveated] = useState(true);
  // S3D-56: under a collapsed Advanced; no price change
  const [bitrate, setBitrate] = useState<Bitrate>("auto");
  // pricing 2026-11 add-ons: Master bitrate (+20%) and Express (+50%,
  // included in Business and Studio, where it starts ticked)
  const addons = usePricing()?.addons;
  const [master, setMaster] = useState(false);
  const [expressChoice, setExpress] = useState<boolean | null>(null);
  const chosen = choices.find((q) => q.preset === preset);
  const eyeRequired = chosen?.originalEyeRequired === true;
  const originalEye = eyeRequired ? requiredEye : optionalEye;
  const sourceShort = project.probe
    ? Math.min(project.probe.width, project.probe.height)
    : 0;
  // only below the video's own size, and only when the gateway offers it
  const foveationOffered =
    limits?.methods?.lifelike?.foveation === true &&
    chosen?.eyeShort !== undefined &&
    chosen.eyeShort < sourceShort;

  // 6K and 8K make no full side-by-side file (half SBS and spatial are)
  const offeredFormats = lifelikeFormatsFor(chosen ?? { preset });
  const sentFormats = formats.filter((f) => offeredFormats.includes(f));
  const tier = ck.quote?.tier ?? "";
  const expressIncluded = addons?.express?.included_in?.includes(tier) === true;
  const express = expressChoice ?? expressIncluded;
  const plain: StepConversionRequest = {
    step: "production",
    preset,
    formats: sentFormats.length > 0 ? sentFormats : offeredFormats.slice(0, 1),
    ...trimFields(range, numFrames),
    ...(originalEye ? { original_eye: originalEye } : {}),
    ...(addons?.master && master ? { bitrate: "master" as const } : bitrateField(bitrate)),
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
          We&apos;re still looking through your video. Prices appear when
          it&apos;s done.
        </p>
      </div>
    );
  }
  const probe = project.probe!;
  const fps = parseRational(probe.fps_rational);

  const splitOffered = ck.quote?.split_suggested === true;
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
        <MakeSection n={++n} title="Where will you watch it?" hint="Pick all that apply.">
          <WatchPicker
            devices={devices}
            onChange={(next) =>
              change(() => {
                setDevices(next);
                if (next.length > 0) {
                  setFormats(formatsForDevices(next, LIFELIKE_FORMATS));
                }
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
            note={
              choices.length === 1
                ? `Your video is ${resolutionName(probe)}.`
                : choices.some((q) => q.label.startsWith("Full resolution"))
                  ? "Full resolution is your video's own size, priced like the step below it."
                  : undefined
            }
          />
          {eyeRequired || foveationOffered || addons?.master || addons?.express ? (
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
            {foveationOffered ? (
              <div className="flex flex-col gap-1.5">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={foveated}
                    onChange={(e) => change(() => setFoveated(e.target.checked))}
                    className="accent-primary"
                  />
                  Foveated Detail <span className="text-xs text-fg-muted">+30%</span>
                </label>
                <p className="pl-6 text-xs text-fg-muted">More detail where you look.</p>
              </div>
            ) : null}
            {addons?.master ? (
              <AddOnRow
                testId="addon-master"
                label="Master bitrate"
                price={`+${Math.round(addons.master.pct * 100)}%`}
                hint="Higher-bitrate files."
                checked={master}
                onChange={(v) => change(() => setMaster(v))}
              />
            ) : null}
            {addons?.express ? (
              <AddOnRow
                testId="addon-express"
                label="Express"
                price={expressIncluded ? "Included" : `+${Math.round(addons.express.pct * 100)}%`}
                hint={expressHint(ck.quote?.express_eta)}
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
            {master ? (
              <p className="text-xs text-fg-muted">Bitrate: Master (add-on).</p>
            ) : null}
            <BitrateControl
              disabled={master}
              value={bitrate}
              onChange={(b) => change(() => setBitrate(b))}
              sizeBytes={ck.quote?.estimated_size_bytes}
            />
          </div>
        </details>
      </div>

      <aside className="flex flex-col gap-3 lg:sticky lg:top-0">
        <InstantCheckout
          variant="panel"
          checkout={ck}
          request={request}
          label="Make 3D"
          disabledReason={
            sentFormats.length === 0
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
          after={
            hasFiles ? (
              <a href="#tab=files" className="text-center text-xs text-primary hover:underline">
                Your earlier files are in Files
              </a>
            ) : null
          }
        />
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
