"use client";

/**
 * Lifelike Preview page (screen 05, step lifelike_preview). Left, your
 * video with the quality, length and Quick look, and ONE main button with
 * its price ("Preview this moment · $1.04"); right, your preview with a
 * free 3D check on this screen — Red-cyan, Wiggle or Side by side
 * (S3D-32); below, "Pick a moment": the timeline with the preview's box,
 * which starts at the playhead. Past previews sit on the strip as bands
 * above the thumbnails and in a short list (owner 2026-11-07): picking
 * one shows it in "Your preview" (pastPreviewPickAtom); the box, the price
 * and the next preview's button never follow a pick.
 *
 * Priced per frame like the final (S3D-13): 2–10 s, 5 by default; Quick
 * look renders half the frame rate for half the price. The price, the
 * minimum and when it's charged sit behind the "?" (S3D-45). Scrubbing
 * doesn't re-price: the start moment can't change a preview's price, so
 * the quote is for the same length from the start of the video.
 */

import { useAtom } from "jotai";
import { useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";
import type { StripBand } from "@/components/workspace/FilmstripTimeline";
import type {
  Conversion,
  Format,
  Preset,
  Project,
  PublicPricing,
  StepConversionRequest,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { usePricing } from "@/lib/api/usePricing";
import { formatClock, formatShortDay } from "@/lib/format";
import { headsetPreviewFormats, isHeadset, type Client } from "@/lib/headset";
import {
  clipRange,
  frameToSeconds,
  parseRational,
  type RationalFPS,
} from "@/lib/frames";
import { qualityChoices, qualityLabelFor } from "@/lib/glossary";

import { LIFELIKE_PREVIEW_SECONDS, lifelikeFormatsFor, SAMPLE_PROJECT } from "./methods";
import { formatCents, formatCentsShort } from "./money";
import { StateChip } from "./StateChip";
import {
  CHECK_MODES,
  DEFAULT_CHECK_MODE,
  StereoCheckViewer,
  type CheckMode,
} from "./StereoCheckViewer";
import { pastPreviewPickAtom } from "./pastPreviewAtoms";
import { PreviewDownloads } from "./RunFiles";
import { bestPlayable, StepReview, useRunDownloads } from "./StepReview";
import { PlansSheet, usePlansSheet } from "@/components/plans/PlansSheet";
import { FrameRatePicker, fpsLabel, PICK_FRAME_RATE, useFpsChoice } from "./frameRate";
import { withoutBars } from "@/lib/bars";

import { InstantCheckout, useStepCheckout } from "./useStepCheckout";
import { useClient, ViewIn3D } from "./ViewIn3D";
import { DownloadGate } from "@/components/billing/PayToDownload";
import { buttonVariants } from "@/components/ui/button";

/** The preview's source range for a chosen start frame: about
 * LIFELIKE_PREVIEW_SECONDS long, half open, inside [0, numFrames). */
export function previewRange(
  start: number,
  numFrames: number,
  fps: RationalFPS,
  seconds: number = LIFELIKE_PREVIEW_SECONDS,
): [number, number] {
  return clipRange(start, numFrames, fps, seconds);
}

/** "Nov 7": the day a preview was ordered. */
export function previewDay(iso: string): string {
  return formatShortDay(iso);
}

/** A run's state as a strip band shows it. */
function bandState(c: Conversion): StripBand["state"] {
  if (c.state === "succeeded") return "done";
  if (c.state === "failed" || c.state === "canceled" || c.state === "expired") return "failed";
  return "running";
}

/** A preview's floor (S3D-13/17), from /v1/pricing. */
function previewMinimum(p: PublicPricing): number {
  return p.preview_minimum_cents ?? p.minimum_cents;
}

/** Preview lengths offered (S3D-13). */
export const PREVIEW_LENGTHS = [2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const MIN_LENGTH = PREVIEW_LENGTHS[0];
const MAX_LENGTH = PREVIEW_LENGTHS[PREVIEW_LENGTHS.length - 1];

export interface LifelikePreviewPanelProps {
  project: Project;
  onProjectChanged: () => void;
}

function segClass(on: boolean): string {
  return `h-7 rounded px-2.5 text-xs transition-colors ${
    on ? "bg-surface-0 text-fg shadow-sm" : "text-fg-muted hover:text-fg"
  }`;
}

export function LifelikePreviewPanel(props: LifelikePreviewPanelProps): JSX.Element {
  const { project } = props;
  const ready =
    project.analyze.state === "succeeded" && project.probe && project.scenes;
  if (!ready) {
    return (
      <PanelShell>
        <Card>
          <CardContent>
            <p className="text-sm text-fg-muted">
              We&apos;re still analyzing your video. Previews open when
              it&apos;s done.
            </p>
          </CardContent>
        </Card>
      </PanelShell>
    );
  }
  return <ReadyPreviewPanel {...props} />;
}

/** The panel once the video is analysed (its hooks need the probe). */
function ReadyPreviewPanel({
  project,
  onProjectChanged,
}: LifelikePreviewPanelProps): JSX.Element {
  const ck = useStepCheckout(project, "lifelike_preview", onProjectChanged);
  const pricing = usePricing();
  const gateway = useGateway();
  // 00081: one play per preview file and page visit
  const played = useRef(new Set<string>());
  // null = the best quality the video reaches (the Overview prices that)
  const [chosenPreset, setPreset] = useState<Preset | null>(null);
  const [seconds, setSeconds] = useState<number>(LIFELIKE_PREVIEW_SECONDS);
  const [quickLook, setQuickLook] = useState(false);
  const [mode, setMode] = useState<CheckMode>(DEFAULT_CHECK_MODE);
  const [pick, setPick] = useAtom(pastPreviewPickAtom(project.project_id));

  // QA 2026-11-05 batch 2: a preview just started shows at once (the
  // project's list catches up on its next read)
  const listed = project.conversions ?? [];
  const fresh =
    ck.active && ck.active.step === "lifelike_preview" && !listed.some((c) => c.conversion_id === ck.active!.conversion_id)
      ? [ck.active]
      : [];
  const runs = [...fresh, ...listed]
    .filter((c) => c.step === "lifelike_preview")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const succeeded = runs.filter((c) => c.state === "succeeded");
  // a pick lapses once a newer preview starts: the panel follows the new one
  const newestId = runs[0]?.conversion_id ?? null;
  const picked =
    pick !== null && pick.newestAtPick === newestId
      ? runs.find((c) => c.conversion_id === pick.id)
      : undefined;
  const latest = succeeded[0];
  const shown = picked ?? latest;
  const showPast = (id: string) =>
    setPick(id === latest?.conversion_id ? null : { id, newestAtPick: newestId });
  const downloads = useRunDownloads(shown?.state === "succeeded" ? shown : undefined);
  const output = bestPlayable(downloads);
  const client = useClient();

  const probe = project.probe!;
  const sourceFps = parseRational(probe.fps_rational);
  const clock = (f: number) => formatClock(frameToSeconds(f, sourceFps));
  const halfRate = Math.round((sourceFps.num / sourceFps.den / 2) * 100) / 100;
  // the size each quality makes, without the bars when they're removed
  const presets = withoutBars(qualityChoices(project), project);
  const preset = chosenPreset ?? presets.at(-1)?.preset ?? "1080p";
  const choice = presets.find((q) => q.preset === preset);
  const cuts = project.scenes?.cuts ?? [];

  // 6K and 8K make no full side-by-side: their previews come as half
  // side-by-side (the gateway's per-quality formats)
  const offered = lifelikeFormatsFor(choice ?? { preset });
  const wanted: Format[] = isHeadset(client)
    ? headsetPreviewFormats(client as Exclude<Client, "desktop">, preset)
    : ["sbs"];
  const fits = wanted.filter((f) => offered.includes(f));
  // the side-by-side plays here; the Vision Pro file comes too, so a
  // preview can go to a headset (the gateway makes both)
  const previewFormats: Format[] = [
    ...(fits.length > 0 ? fits : (["half_sbs"] as Format[])),
    ...(fits.includes("mvhevc") || !offered.includes("mvhevc") ? [] : (["mvhevc"] as Format[])),
  ];
  const logPlay = (file: string) => {
    if (!shown) return;
    const key = `${shown.conversion_id}/${file}`;
    if (played.current.has(key)) return;
    played.current.add(key);
    gateway.logPlay(shown.conversion_id, file, "preview");
  };

  const plainAt = (start: number): StepConversionRequest => {
    const [from, to] = previewRange(start, probe.num_frames, sourceFps, seconds);
    return {
      step: "lifelike_preview",
      preset,
      // side by side plays right here; a headset asks for the file it
      // shows in 3D (S3D-47)
      formats: previewFormats,
      from_frame: from,
      to_frame: to,
      platform: "web",
    };
  };
  // owner 2026-11-04: above 30 fps the frame rate is a required choice
  // (it replaces Quick look there); at 30 or below Quick look halves it
  const fpsChoice = useFpsChoice(project, "lifelike_preview", plainAt(0));
  // plans canvas, Sheet C: after a free preview finishes here, or when the
  // free previews are used up (once a session, people without a plan)
  const freeDone =
    ck.settled &&
    ck.active?.state === "succeeded" &&
    (ck.active.billing?.status === "free_preview" || ck.active.quote.amount_cents === 0);
  const usedUp = ck.quote?.free_previews?.remaining === 0;
  const plansSheet = usePlansSheet(!project.sample && (freeDone || usedUp));
  const fpsMissing = fpsChoice.required && fpsChoice.value === null;
  const requestAt = (start: number): StepConversionRequest => ({
    ...plainAt(start),
    ...(fpsChoice.required
      ? fpsChoice.field
      : quickLook
        ? { target_fps: halfRate, quick_look: true } // Quick look: half the frame rate, half the price (gateway 00178: the flag shows with the run)
        : {}),
  });
  const quoteRequest = requestAt(0);
  const frames = quoteRequest.to_frame! - quoteRequest.from_frame!;

  function change(apply: () => void): void {
    apply();
    ck.invalidate();
  }

  const shownMeta = shown
    ? [
        shown.params.from_frame !== undefined && shown.params.to_frame !== undefined
          ? `${clock(shown.params.from_frame)} – ${clock(shown.params.to_frame)}`
          : null,
        qualityLabelFor(project, shown.params.preset),
        previewDay(shown.created_at),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  // past previews on the strip, the one shown highlighted
  const bands: StripBand[] = runs.flatMap((c) =>
    c.params.from_frame !== undefined && c.params.to_frame !== undefined
      ? [
          {
            id: c.conversion_id,
            from: c.params.from_frame,
            to: c.params.to_frame,
            state: bandState(c),
            label: [
              `${clock(c.params.from_frame)} – ${clock(c.params.to_frame)}`,
              qualityLabelFor(project, c.params.preset),
              previewDay(c.created_at),
              bandState(c) === "running" ? "being made" : bandState(c) === "failed" ? "didn't finish" : null,
            ]
              .filter(Boolean)
              .join(" · "),
            selected: c.conversion_id === shown?.conversion_id,
          },
        ]
      : [],
  );

  const previewCard: ReactNode = (
    <section
      aria-label="Your preview"
      className="flex h-full flex-col gap-2 rounded-md border border-edge bg-surface-1 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold text-fg">Your preview</h3>
        {shown ? <StateChip conversion={shown} /> : null}
        {picked && picked.conversion_id !== latest?.conversion_id ? (
          <button
            type="button"
            onClick={() => setPick(null)}
            className="text-[11px] text-primary hover:underline"
          >
            {latest ? "Back to latest" : "Back"}
          </button>
        ) : null}
        <span data-testid="preview-shown-meta" className="ml-auto text-[11px] text-fg-muted">
          {shownMeta}
        </span>
      </div>
      {shown !== undefined && shown.state !== "succeeded" ? (
        <div
          data-testid="preview-unfinished"
          className="flex flex-1 items-center justify-center rounded-md border border-dashed border-edge p-6 text-center text-xs text-fg-muted"
          style={{ aspectRatio: `${probe.width} / ${probe.height}` }}
        >
          {bandState(shown) === "failed"
            ? "This preview didn't finish. You paid nothing for it."
            : "This preview is being made. It shows here when it's done."}
        </div>
      ) : shown === undefined ? (
        <div
          data-testid="preview-empty"
          className="flex flex-1 items-center justify-center rounded-md border border-dashed border-edge p-6 text-center text-xs text-fg-muted"
          style={{ aspectRatio: `${probe.width} / ${probe.height}` }}
        >
          Your preview appears here.
        </div>
      ) : downloads === null ? (
        <p className="text-xs text-fg-muted">Fetching the preview…</p>
      ) : output === null ? (
        // a headset's own format (Vision Pro spatial video) plays flat
        // inline; View in 3D shows it in 3D
        <>
          {downloads.mvhevc ? (
            <DownloadGate hide>
              <video
                src={downloads.mvhevc}
                controls
                playsInline
                preload="metadata"
                data-testid="lifelike-preview-video"
                onPlay={() => logPlay("mvhevc")}
                className="w-full rounded-md border border-edge bg-black"
              />
            </DownloadGate>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <ViewIn3D files={downloads} onPlay={logPlay} />
            <a href="#tab=make" className="ml-auto text-xs text-primary hover:underline">
              Make the whole video in 3D
            </a>
          </div>
          {shown ? <PreviewDownloads conversion={shown} /> : null}
        </>
      ) : (
        <>
          {/* S3D-35: the 3D check plays the file — gated like a download */}
          <DownloadGate verb="play" className={buttonVariants({ variant: "outline", size: "sm" })}>
            <StereoCheckViewer
              onPlay={() => logPlay(output.name)}
              url={output.url}
              aspect={probe.width / probe.height}
              mode={mode}
            />
          </DownloadGate>
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="radiogroup"
              aria-label="View"
              className="flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5"
            >
              {CHECK_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.id}
                  onClick={() => setMode(m.id)}
                  className={segClass(mode === m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-fg-muted">
              Free 3D check on this screen
            </span>
            <ViewIn3D files={downloads} size="xs" onPlay={logPlay} />
          </div>
          {shown ? <PreviewDownloads conversion={shown} /> : null}
          <div className="flex items-center text-xs">
            <span className="font-mono text-fg-muted">
              {formatCents(shown.quote.amount_cents)}
            </span>
            <a href="#tab=make" className="ml-auto text-primary hover:underline">
              Make the whole video in 3D
            </a>
          </div>
        </>
      )}
    </section>
  );

  return (
    <PanelShell>
      <PlansSheet
        open={plansSheet.open}
        onClose={plansSheet.close}
        preset={preset}
        reason={freeDone ? "preview_done" : "previews_used"}
      />
      <StepReview
        project={project}
        sourceFps={sourceFps}
        heading="Your video"
        aside={previewCard}
        range={(playhead) =>
          previewRange(playhead, probe.num_frames, sourceFps, seconds)
        }
        bands={bands}
        onSelectBand={showPast}
        belowPlayer={({ playhead }) => {
          const run = requestAt(playhead);
          const range: [number, number] = [run.from_frame!, run.to_frame!];
          return (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-end gap-4">
                <div className="flex flex-col gap-1">
                  <span id="pv-quality" className="text-[11px] text-fg-muted">
                    Quality
                  </span>
                  <div
                    role="radiogroup"
                    aria-labelledby="pv-quality"
                    className="flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5"
                  >
                    {presets.map((q) => (
                      <button
                        key={q.preset}
                        type="button"
                        role="radio"
                        aria-checked={preset === q.preset}
                        data-value={q.preset}
                        onClick={() => change(() => setPreset(q.preset))}
                        className={segClass(preset === q.preset)}
                      >
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] text-fg-muted">Length</span>
                  <div className="flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5">
                    <button
                      type="button"
                      aria-label="Shorter"
                      disabled={seconds <= MIN_LENGTH}
                      onClick={() => change(() => setSeconds((s) => s - 1))}
                      className={segClass(false)}
                    >
                      −
                    </button>
                    <span
                      data-testid="preview-length"
                      aria-label="Length"
                      className="px-2 font-mono text-xs text-fg"
                    >
                      {seconds} s
                    </span>
                    <button
                      type="button"
                      aria-label="Longer"
                      disabled={seconds >= MAX_LENGTH}
                      onClick={() => change(() => setSeconds((s) => s + 1))}
                      className={segClass(false)}
                    >
                      +
                    </button>
                  </div>
                </div>
                {fpsChoice.required ? null : (
                  <label className="flex h-8 cursor-pointer items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={quickLook}
                      onChange={(e) => change(() => setQuickLook(e.target.checked))}
                      className="accent-primary"
                    />
                    Quick look <span className="text-fg-muted">· half price</span>
                  </label>
                )}
              </div>
              {fpsChoice.required ? (
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] text-fg-muted">
                    Frame rate · your video is {fpsLabel(probe.fps)}
                  </span>
                  <FrameRatePicker
                    compact
                    choice={fpsChoice}
                    onChange={(v) => change(() => fpsChoice.set(v))}
                  />
                </div>
              ) : null}
              <p data-testid="preview-moment" className="text-[11px] text-fg-muted">
                {choice?.hint ? `${choice.hint} · ` : ""}
                <span className="font-mono">
                  {clock(range[0])} – {clock(range[1])}
                </span>
              </p>
              <InstantCheckout
                checkout={ck}
                request={run}
                quoteRequest={quoteRequest}
                label="Preview this moment"
                trackerDownloads={false}
                disabledReason={project.sample ? SAMPLE_PROJECT : fpsMissing ? PICK_FRAME_RATE : undefined}
                explain={
                  <span className="flex flex-col gap-1.5">
                    <span>
                      {frames} frames at the {choice?.label ?? preset} rate: the
                      same price per frame as the whole video.
                    </span>
                    <span>
                      Quick look uses half the frame rate for half the price.
                      {/* the quote's own line names the minimum when it applies */}
                      {pricing &&
                      ck.quote?.quote.amount_cents !== previewMinimum(pricing)
                        ? ` Minimum charge ${formatCentsShort(previewMinimum(pricing))}.`
                        : ""}{" "}
                      If it fails, you pay nothing.
                    </span>
                  </span>
                }
              />
            </div>
          );
        }}
        timelineHeading={
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-semibold text-fg">Pick a moment</h3>
            <span className="text-[11px] text-fg-muted">
              {bands.length > 0
                ? "Click the strip to move the preview. The bars along its top are your past previews."
                : "Click the strip to move the preview."}
            </span>
          </div>
        }
      >
        {({ playhead }) => {
          const scene = cuts.filter((c) => c <= playhead).length + 1;
          return (
            <PreviewRangeNote
              range={previewRange(playhead, probe.num_frames, sourceFps, seconds)}
              clock={clock}
              scene={scene}
              scenes={cuts.length + 1}
            />
          );
        }}
      </StepReview>

      {succeeded.length > 1 || runs.length > succeeded.length ? (
        <section aria-label="Past previews" className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-fg-muted">Past previews</h3>
          <ul className="flex flex-col gap-2">
            {runs.map((c) => (
              <PreviewRow
                key={c.conversion_id}
                conversion={c}
                range={
                  c.params.from_frame !== undefined && c.params.to_frame !== undefined
                    ? `${clock(c.params.from_frame)} – ${clock(c.params.to_frame)}`
                    : ""
                }
                quality={qualityLabelFor(project, c.params.preset)}
                day={previewDay(c.created_at)}
                shown={c.conversion_id === shown?.conversion_id}
                onShow={() => showPast(c.conversion_id)}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </PanelShell>
  );
}

/** "2:31 – 2:36 · Scene 7 of 14" under the timeline. */
function PreviewRangeNote({
  range,
  clock,
  scene,
  scenes,
}: {
  range: [number, number];
  clock: (f: number) => string;
  scene: number;
  scenes: number;
}): JSX.Element {
  return (
    <p data-testid="preview-range" className="text-[11px] text-fg-muted">
      Preview <span className="font-mono text-fg">{clock(range[0])} – {clock(range[1])}</span>
      {" · "}Scene {scene} of {scenes}
    </p>
  );
}

function PreviewRow({
  conversion: c,
  range,
  quality,
  day,
  shown,
  onShow,
}: {
  conversion: Conversion;
  range: string;
  quality: string;
  day: string;
  shown: boolean;
  onShow?: () => void;
}): JSX.Element {
  return (
    <li
      data-testid={`preview-row-${c.conversion_id}`}
      className="flex flex-wrap items-center gap-3 rounded-md border border-edge bg-surface-1 px-3 py-2 text-xs"
    >
      <span className="font-mono text-fg">{range}</span>
      <span className="text-fg-muted">{quality}</span>
      <span className="text-fg-muted">{day}</span>
      <StateChip conversion={c} />
      <span className="ml-auto font-mono text-fg-muted">
        {formatCents(c.quote.amount_cents)}
      </span>
      {onShow ? (
        <button
          type="button"
          onClick={onShow}
          disabled={shown}
          className="text-primary hover:underline disabled:text-fg-muted disabled:no-underline"
        >
          {shown ? "Showing" : "Show"}
        </button>
      ) : null}
    </li>
  );
}

function PanelShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div data-testid="lifelike-preview-panel" className="flex flex-col gap-6">
      {children}
    </div>
  );
}
