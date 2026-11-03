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
import { LIFELIKE_FORMATS, SPLIT_MAX_SECONDS } from "./methods";
import { InstantCheckout, useStepCheckout } from "./useStepCheckout";
import { useClient } from "./ViewIn3D";

/** "Your video is N minutes long. …" — the split question. */
export function splitQuestion(outputSeconds: number): string {
  const minutes = Math.max(1, Math.round(outputSeconds / 60));
  return `Your video is ${minutes} minutes long. Split it into ${Math.round(
    SPLIT_MAX_SECONDS / 60,
  )}-minute parts so each file plays smoothly?`;
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
  // S3D-48: under Quality, unticked; Left when ticked
  const [optionalEye, setOptionalEye] = useState<"left" | "right" | null>(null);
  // S3D-65: 5K, 6K and 8K keep one eye original — ticked and locked there,
  // Left by default; up to 4K it stays optional and unticked
  const [requiredEye, setRequiredEye] = useState<"left" | "right">("left");
  // S3D-50: Foveated Detail, ticked by default whenever it's shown
  const [foveated, setFoveated] = useState(true);
  // S3D-56: under a collapsed Advanced; no price change
  const [bitrate, setBitrate] = useState<Bitrate>("auto");
  const chosen = choices.find((q) => q.preset === preset);
  const eyeRequired = chosen?.originalEyeRequired === true;
  const originalEye = eyeRequired ? requiredEye : optionalEye;
  const setEye = (e: "left" | "right") =>
    eyeRequired ? setRequiredEye(e) : setOptionalEye(e);
  const sourceShort = project.probe
    ? Math.min(project.probe.width, project.probe.height)
    : 0;
  // only below the video's own size, and only when the gateway offers it
  const foveationOffered =
    limits?.methods?.lifelike?.foveation === true &&
    chosen?.eyeShort !== undefined &&
    chosen.eyeShort < sourceShort;

  const base: StepConversionRequest = {
    step: "production",
    preset,
    formats: formats.length > 0 ? formats : DEFAULT_MAKE_FORMATS,
    ...trimFields(range, numFrames),
    ...(originalEye ? { original_eye: originalEye } : {}),
    ...bitrateField(bitrate),
    // shown: ticked sends "static", unticked sends null; hidden: absent
    ...(foveationOffered ? { foveation: foveated ? ("static" as const) : null } : {}),
    platform: "web",
  };
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
    formats,
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
            offered={LIFELIKE_FORMATS}
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
          <div className="flex flex-col gap-3 border-t border-edge pt-3">
            <div className="flex flex-col gap-1.5">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={originalEye !== null}
                  disabled={eyeRequired}
                  onChange={(e) =>
                    change(() => setOptionalEye(e.target.checked ? "left" : null))
                  }
                  className="accent-primary"
                />
                Keep the original picture in one eye
              </label>
              <p className="pl-6 text-xs text-fg-muted">
                One eye shows your original frames at full resolution.
              </p>
              {originalEye !== null ? (
                <div
                  role="radiogroup"
                  aria-label="Which eye"
                  className="flex gap-4 pl-6 text-sm"
                >
                  {(["left", "right"] as const).map((eye) => (
                    <label key={eye} className="flex cursor-pointer items-center gap-2">
                      <input
                        type="radio"
                        name="original-eye"
                        checked={originalEye === eye}
                        onChange={() => change(() => setEye(eye))}
                        className="accent-primary"
                      />
                      {eye === "left" ? "Left" : "Right"}
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
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
          </div>
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
          data-testid="lifelike-advanced"
          className="rounded-xl border border-edge bg-surface-1 px-4 py-3"
        >
          <summary className="cursor-pointer text-sm font-medium text-fg-muted">
            Advanced
          </summary>
          <div className="mt-3">
            <BitrateControl
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
            formats.length === 0 ? "Pick at least one file" : undefined
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
