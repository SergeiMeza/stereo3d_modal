"use client";

/**
 * Deliver page for Lifelike projects (step production). Lifelike is its
 * own product, not a copy of Classic's page: a quality (1080p, 1440p, 3K,
 * 4K — only those at or below the source; Lifelike never upscales), the
 * Lifelike formats (Vision Pro spatial video, full and half side by side)
 * and the quote. No depth, edge or reuse controls.
 *
 * Long outputs: when the quote says split_suggested (output over 15
 * minutes), the page asks before the run whether to split it into
 * 15-minute parts — "Split into parts" preselected — and the run then
 * carries split_max_seconds 900. Split runs download as Part 1, Part 2…
 * (DownloadsList).
 */

import { useState } from "react";
import type { JSX, ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";
import {
  conversionMethod,
  type Conversion,
  type Format,
  type Preset,
  type Project,
  type StepConversionRequest,
} from "@/lib/api/types";
import {
  formatName,
  qualityChoices,
  qualityChoiceText,
  qualityLabelFor,
} from "@/lib/glossary";
import { parseRational } from "@/lib/frames";

import { CheckboxChip, Field, selectClass } from "./controls";
import { splitPart } from "./DownloadsList";
import {
  LIFELIKE_FORMAT_LABELS,
  LIFELIKE_FORMATS,
  SPLIT_MAX_SECONDS,
} from "./methods";
import { PriorRuns } from "./PriorRuns";
import {
  bestPlayable,
  paymentLocked,
  PaymentLockedNotice,
  StepReview,
  useRunDownloads,
} from "./StepReview";
import { StepCheckoutSection, useStepCheckout } from "./useStepCheckout";

/** "This video is N minutes long. …" — the split question. */
export function splitQuestion(outputSeconds: number): string {
  const minutes = Math.max(1, Math.round(outputSeconds / 60));
  return `This video is ${minutes} minutes long. Split it into ${Math.round(
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
  const [preset, setPreset] = useState<Preset>("1080p");
  const [formats, setFormats] = useState<Format[]>(["mvhevc", "half_sbs"]);
  // LL-D6: preselected; only asked (and only sent) when the quote says the
  // output runs past 15 minutes
  const [split, setSplit] = useState(true);

  const runs = (project.conversions ?? []).filter(
    (c) => c.step === "production" && conversionMethod(c) === "lifelike",
  );
  const lastSucceeded = runs
    .filter((c) => c.state === "succeeded")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] as
    | Conversion
    | undefined;
  const downloads = useRunDownloads(lastSucceeded);
  const output = bestPlayable(downloads);
  const lastWasSplit =
    downloads !== null && Object.keys(downloads).some((n) => splitPart(n));

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
  const sourceFps = parseRational(project.probe!.fps_rational);
  const presets = qualityChoices(project);

  const splitOffered = ck.quote?.split_suggested === true;
  const request: StepConversionRequest = {
    step: "production",
    preset,
    formats,
    ...(splitOffered && split ? { split_max_seconds: SPLIT_MAX_SECONDS } : {}),
    platform: "web",
  };

  return (
    <PanelShell>
      <StepReview
        project={project}
        sourceFps={sourceFps}
        heading="Final output"
        headingExtras={
          paymentLocked(lastSucceeded) ? (
            <PaymentLockedNotice />
          ) : lastWasSplit ? (
            <span className="text-[11px] text-fg-muted">
              Your last run came in parts — download each part below.
            </span>
          ) : output === null ? (
            <span className="text-[11px] text-fg-muted">
              Deliver to review the final output beside the source.
            </span>
          ) : null
        }
        follower={
          output !== null
            ? {
                url: output.url,
                label: output.name,
                title:
                  "The latest delivered video, synced to the source (Vision Pro spatial video plays on the headset — download it below)",
                testId: "deliver-output-video",
              }
            : null
        }
      />

      <PanelCard>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="lifelike-production-preset" label="Quality">
            <select
              id="lifelike-production-preset"
              value={preset}
              onChange={(e) => {
                setPreset(e.target.value as Preset);
                ck.invalidate();
              }}
              className={selectClass}
            >
              {presets.map((q) => (
                <option key={q.preset} value={q.preset}>
                  {qualityChoiceText(q)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-medium text-fg-muted">Formats</legend>
          <div className="flex flex-wrap gap-2">
            {LIFELIKE_FORMATS.map((f) => (
              <CheckboxChip
                key={f}
                label={LIFELIKE_FORMAT_LABELS[f]}
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

        {splitOffered && !ck.running ? (
          <fieldset
            data-testid="split-prompt"
            className="flex flex-col gap-2 rounded-lg border border-edge bg-surface-2 p-3"
          >
            <legend className="sr-only">Split into parts</legend>
            <p className="text-sm text-fg">
              {splitQuestion(
                ck.quote?.output_seconds ?? project.probe!.duration_s,
              )}
            </p>
            <div className="flex flex-wrap gap-4">
              <label className="flex cursor-pointer items-center gap-2 text-xs">
                <input
                  type="radio"
                  name="lifelike-split"
                  checked={split}
                  onChange={() => setSplit(true)}
                  className="accent-primary"
                />
                Split into parts
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs">
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
            <p className="text-xs text-fg-muted">
              Parts break between scenes wherever possible, and each part has
              its own sound.
            </p>
          </fieldset>
        ) : null}

        <StepCheckoutSection
          checkout={ck}
          request={request}
          disabledReason={
            formats.length === 0 ? "Select at least one format" : undefined
          }
        />
      </PanelCard>

      <PriorRuns
        title="Prior deliveries"
        conversions={runs}
        meta={(c) =>
          [
            qualityLabelFor(project, c.params.preset),
            c.params.formats.map(formatName).join(" + "),
            c.parts && c.parts.length > 0 ? `${c.parts.length} parts` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        }
      />
    </PanelShell>
  );
}

function PanelShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div data-testid="lifelike-deliver-panel" className="flex flex-col gap-6">
      {children}
    </div>
  );
}

function PanelCard({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}
