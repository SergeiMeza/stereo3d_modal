"use client";

/**
 * Lifelike Preview page (step lifelike_preview): the customer picks a
 * moment on the timeline and gets about 5 seconds of it in 3D, in the
 * quality they choose — quote first, then the run, like every paid step.
 *
 * The shared StepReview supplies the frame-exact source player and the
 * timeline; "Preview from here" fixes the moment at the playhead. The
 * request is [moment, moment + 5 s) in SOURCE frames (half open, shifted
 * back near the end so it always spans the full length when the source
 * allows). The latest preview plays in its own player: it is a 5-second
 * clip, so it can't follow the full-length source transport.
 */

import { useState } from "react";
import type { JSX, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type {
  Conversion,
  Preset,
  Project,
  StepConversionRequest,
} from "@/lib/api/types";
import { qualitiesFor, qualityName } from "@/lib/glossary";
import { frameToTimecode, parseRational, type RationalFPS } from "@/lib/frames";

import { Field, selectClass } from "./controls";
import {
  LIFELIKE_PREVIEW_SECONDS,
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

/** The preview's source range for a chosen start frame: about
 * LIFELIKE_PREVIEW_SECONDS long, half open, inside [0, numFrames). */
export function previewRange(
  start: number,
  numFrames: number,
  fps: RationalFPS,
): [number, number] {
  const span = Math.max(
    1,
    Math.round((LIFELIKE_PREVIEW_SECONDS * fps.num) / fps.den),
  );
  const to = Math.min(Math.max(0, start) + span, numFrames);
  const from = Math.max(0, to - span);
  return [from, to];
}

export interface LifelikePreviewPanelProps {
  project: Project;
  onProjectChanged: () => void;
}

export function LifelikePreviewPanel({
  project,
  onProjectChanged,
}: LifelikePreviewPanelProps): JSX.Element {
  const ck = useStepCheckout(project, "lifelike_preview", onProjectChanged);
  const [preset, setPreset] = useState<Preset>("1080p");
  const [moment, setMoment] = useState(0);

  const runs = (project.conversions ?? []).filter(
    (c) => c.step === "lifelike_preview",
  );
  const lastSucceeded = runs
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
            Analysis is still running — previews unlock when it finishes.
          </p>
        </PanelCard>
      </PanelShell>
    );
  }
  const probe = project.probe!;
  const sourceFps = parseRational(probe.fps_rational);
  const [from, to] = previewRange(moment, probe.num_frames, sourceFps);
  const tc = (f: number) => frameToTimecode(f, sourceFps);
  const presets = qualitiesFor(probe);

  const request: StepConversionRequest = {
    step: "lifelike_preview",
    preset,
    formats: ["sbs"], // side by side: plays right here
    from_frame: from,
    to_frame: to,
    platform: "web",
  };

  return (
    <PanelShell>
      <StepReview
        project={project}
        sourceFps={sourceFps}
        heading="Pick a moment"
        headingExtras={
          <span className="text-[11px] text-fg-muted">
            Scrub the timeline, then preview about {LIFELIKE_PREVIEW_SECONDS}{" "}
            seconds from there.
          </span>
        }
      >
        {({ playhead, scrub }) => (
          <div className="flex flex-wrap items-center gap-3">
            <span data-testid="preview-moment" className="text-xs text-fg">
              Preview: <span className="font-mono">{tc(from)}</span> –{" "}
              <span className="font-mono">{tc(to)}</span>
            </span>
            <Button
              variant="outline"
              size="xs"
              data-testid="preview-from-here"
              disabled={playhead === moment}
              onClick={() => {
                setMoment(playhead);
                ck.invalidate();
              }}
            >
              Preview from here ({tc(playhead)})
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => scrub(from)}
            >
              Go to the preview start
            </Button>
          </div>
        )}
      </StepReview>

      <PanelCard>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="lifelike-preview-preset" label="Quality">
            <select
              id="lifelike-preview-preset"
              value={preset}
              onChange={(e) => {
                setPreset(e.target.value as Preset);
                ck.invalidate();
              }}
              className={selectClass}
            >
              {presets.map((p) => (
                <option key={p} value={p}>
                  {qualityName(p)}
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
      </PanelCard>

      {lastSucceeded !== undefined ? (
        <section className="flex flex-col gap-2" aria-label="Latest preview">
          <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
            Latest preview
            {lastSucceeded.params.from_frame !== undefined ? (
              <span className="ml-2 font-mono normal-case">
                from {tc(lastSucceeded.params.from_frame)}
              </span>
            ) : null}
          </h3>
          {paymentLocked(lastSucceeded) ? (
            <PaymentLockedNotice />
          ) : output !== null ? (
            <video
              key={output.url}
              src={output.url}
              controls
              playsInline
              preload="metadata"
              data-testid="lifelike-preview-video"
              className="w-full max-w-3xl rounded-md border border-edge bg-black"
            />
          ) : (
            <p className="text-xs text-fg-muted">Fetching the preview…</p>
          )}
        </section>
      ) : null}

      <PriorRuns
        title="Prior previews"
        conversions={runs}
        meta={(c) =>
          [
            qualityName(c.params.preset),
            c.params.from_frame !== undefined
              ? `from ${tc(c.params.from_frame)}`
              : null,
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
    <div data-testid="lifelike-preview-panel" className="flex flex-col gap-6">
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
