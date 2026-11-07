"use client";

/**
 * Files: a run's Details (owner 2026-11-07). A small toggle under each run
 * or preview opens a compact list of what the gateway returned for it:
 * what it was, the part, the output, the look settings it stored, when it
 * was ordered and finished, what it cost, its files, and the Run ID with a
 * copy button for support. Only what the run carries: a missing value
 * leaves its row out. Closed by default; each run's open state is its own
 * atom (runDetailsAtoms). Two columns at desktop, one at 390 px.
 */

import { useAtom } from "jotai";
import { ChevronDown } from "lucide-react";
import { Collapsible } from "radix-ui";
import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";

import { conversionMethod, type Conversion, type Project } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { formatBytes, formatClock, formatDuration, formatVideoLength } from "@/lib/format";
import { cutsToRanges, frameToSeconds, parseRational } from "@/lib/frames";
import { eyeSize, METHOD_NAMES, qualityChoices, qualityLabelFor, STEP_NAMES } from "@/lib/glossary";

import { audioLine, fileQualityLine } from "./FileQuality";
import { fpsLabel } from "./frameRate";
import { formatCents } from "./money";
import { runPrice } from "./PreviousRuns";
import { useRunFiles } from "./RunFiles";
import { runDetailsOpenAtom, runReceiptsAtom } from "./runDetailsAtoms";

const TERMINAL: ReadonlySet<Conversion["state"]> = new Set(["succeeded", "failed", "canceled", "expired"]);

/** "Vision Pro .mov" */
const FILE_WORDS: Record<string, string> = {
  mvhevc: "Vision Pro .mov",
  sbs: "Side by side .mp4",
  half_sbs: "Side by side (half size) .mp4",
  anaglyph: "Red-cyan .mp4",
  depth: "Depth .mp4",
  depth_vis: "Depth view .mp4",
};

function fileWords(format: string): string {
  return FILE_WORDS[format] ?? format;
}

/** "Nov 7, 14:05" */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "Scene 3" / "Scenes 3–5", only while the cuts are the ones it ran with. */
function scenesOf(project: Project, c: Conversion, from: number, to: number): string | null {
  const scenes = project.scenes;
  if (!scenes || !project.probe) return null;
  if (c.scenes_version !== undefined && c.scenes_version !== scenes.version) return null;
  const ranges = cutsToRanges(scenes.cuts ?? [], project.probe.num_frames);
  const hit = ranges.map((r, i) => ({ r, i })).filter(({ r }) => r[0] < to && r[1] > from);
  if (hit.length === 0) return null;
  const a = hit[0].i + 1;
  const b = hit[hit.length - 1].i + 1;
  return a === b ? `Scene ${a}` : `Scenes ${a}–${b}`;
}

export interface DetailRow {
  label: string;
  value: ReactNode;
}

/** The rows for a run: only what it carries. Exported for tests. */
export function detailRows(project: Project, c: Conversion): DetailRow[] {
  const rows: DetailRow[] = [];
  const add = (label: string, value: ReactNode | null | undefined | false) => {
    if (value !== null && value !== undefined && value !== false && value !== "") rows.push({ label, value });
  };
  const probe = project.probe;
  const srcFps = probe ? parseRational(probe.fps_rational) : null;
  const p = c.params;
  const preview = c.step !== "production";

  // What: older runs (no quick_look flag) by their half frame rate; newer
  // ones say it on their own Quick look row
  const quickLook =
    c.quick_look === undefined &&
    c.step === "lifelike_preview" &&
    probe !== undefined &&
    probe.fps <= 30 &&
    p.target_fps !== undefined &&
    Math.abs(p.target_fps - probe.fps / 2) < 0.6;
  add(
    "What",
    [STEP_NAMES[c.step ?? "production"] ?? "Run", METHOD_NAMES[conversionMethod(c)], quickLook ? "Quick look" : null]
      .filter(Boolean)
      .join(" · "),
  );

  // Range
  if (probe && srcFps) {
    const whole = p.from_frame === undefined || p.to_frame === undefined;
    const from = p.from_frame ?? 0;
    const to = Math.min(p.to_frame ?? probe.num_frames, probe.num_frames);
    const secs = frameToSeconds(to - from, srcFps);
    const clock = (f: number) => formatClock(frameToSeconds(f, srcFps));
    add(
      "Part",
      [
        whole && !preview ? "Whole video" : `${clock(from)} – ${clock(to)}`,
        formatVideoLength(secs),
        scenesOf(project, c, from, to),
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }

  // Output
  const choice = qualityChoices(project).find((q) => q.preset === p.preset);
  const size = probe && choice?.eyeShort ? eyeSize(probe, choice.eyeShort) : null;
  add(
    "Quality",
    [qualityLabelFor(project, p.preset), size ? `${size.width}×${size.height} per eye` : null].filter(Boolean).join(" · "),
  );
  const fps = p.target_fps ?? probe?.fps;
  add("Frame rate", fps ? fpsLabel(fps) : null);
  const made = c.state === "succeeded" && c.outputs && c.outputs.length > 0
    ? [...new Set(c.outputs.map((o) => o.replace(/_part\d+$/, "")))]
    : p.formats ?? [];
  add(c.state === "succeeded" ? "Files made" : "Files ordered", made.map(fileWords).join(", "));
  if (c.parts && c.parts.length > 1) add("Parts", String(c.parts.length));

  // Look and depth, as the run stored them
  add("3D strength", p.depth_scale !== undefined ? `×${p.depth_scale.toFixed(2)}` : null);
  add("Depth detail", p.depth_res !== undefined ? `${p.depth_res} px` : null);
  add("Scenes tuned", p.scene_overrides && p.scene_overrides.length > 0 ? String(p.scene_overrides.length) : null);
  add("Original eye", p.original_eye ? (p.original_eye === "left" ? "Left" : "Right") : null);
  // owner 2026-11-07: the File quality asked for, with what the finished
  // files measure ("High (measured 41 Mbit/s)"); the asked-for setting
  // alone while running or on older runs; never a guess
  add("File quality", fileQualityLine(c));
  add("Audio", audioLine(c));
  // owner 2026-11-07: a Lifelike run always says On or Off for each
  // add-on, offered or not; Classic runs have none
  if (conversionMethod(c) === "lifelike") {
    const onOff = (v: boolean) => (v ? "On" : "Off");
    // owner 2026-11-07: included at 1080p when it applied; nothing when it
    // didn't apply there (a source at 1080p or below)
    if (c.foveation?.included === true) add("Foveated Detail", c.foveation.applied ? "Included" : null);
    else add("Foveated Detail", onOff(p.foveation === "static" || c.foveation?.applied === true));
    add("Express", onOff(p.express === true));
    // gateway 00178: the run's own flags
    if (c.step === "lifelike_preview" && c.quick_look !== undefined) add("Quick look", onOff(c.quick_look));
    if (c.intro !== undefined) add("Intro", onOff(c.intro));
  }

  // Timing
  add("Ordered", when(c.created_at));
  if (TERMINAL.has(c.state)) {
    add("Finished", when(c.updated_at));
    // gateway 00178: from when it left the line, so the wait isn't counted
    const took = (new Date(c.updated_at).getTime() - new Date(c.started_at ?? c.created_at).getTime()) / 1000;
    if (c.state === "succeeded" && took > 0) add("Took", formatDuration(Math.round(took)));
  }

  // Billing
  const free = c.billing?.status === "free_preview" || c.quote.breakdown?.free_preview === true;
  add("Price", free ? "Free preview" : runPrice(c));
  // gateway 00178: the free previews it used
  const units = c.free_preview_units ?? 0;
  if (units > 0) add("Free previews used", String(units));
  const b = c.quote.breakdown;
  if (!free && b) {
    const pro = b.pro_discount_cents ?? 0;
    const other = b.discount_cents ?? 0;
    if (pro > 0) {
      add("Discount", `Pro${b.pro_discount_pct ? ` ${Math.round(b.pro_discount_pct * 100)}%` : ""} · −${formatCents(pro)}`);
    } else if (other > 0) {
      add("Discount", `−${formatCents(other)}`);
    }
  }
  // owner 2026-11-07: the launch offer the run had, in the quote's words
  const offer = c.campaign_cents ?? b?.campaign_cents ?? 0;
  if (!free && offer > 0) add("Launch offer", `${b?.campaign_label ?? "Launch offer"} · −${formatCents(offer)}`);
  return rows;
}

export function RunDetails({ project, conversion: c }: { project: Project; conversion: Conversion }): JSX.Element {
  const [open, setOpen] = useAtom(runDetailsOpenAtom(c.conversion_id));
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger
        data-testid="run-details-toggle"
        className="group inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
      >
        Details
        <ChevronDown aria-hidden className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
      </Collapsible.Trigger>
      {/* rendered only while open: a closed panel reads nothing */}
      {open ? (
        <Collapsible.Content data-testid="run-details" className="mt-2">
          <DetailsBody project={project} conversion={c} />
        </Collapsible.Content>
      ) : null}
    </Collapsible.Root>
  );
}

function DetailsBody({ project, conversion: c }: { project: Project; conversion: Conversion }): JSX.Element {
  const rows = detailRows(project, c);
  const receipt = useReceipt(c);
  return (
    <dl className={DETAIL_LIST_CLASS}>
      {rows.map((r) => (
        <Row key={r.label} label={r.label}>
          {r.value}
        </Row>
      ))}
      {receipt ? (
        <Row label="Receipt">
          <a href={receipt} target="_blank" rel="noreferrer" className="text-primary hover:underline">
            View receipt
          </a>
        </Row>
      ) : null}
      {c.invoice?.hosted_url || c.invoice?.pdf_url ? (
        <Row label="Invoice">
          <span className="inline-flex flex-wrap items-center gap-2">
            {c.invoice.number ? <span className="font-mono">{c.invoice.number}</span> : null}
            {c.invoice.hosted_url ? (
              <a href={c.invoice.hosted_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                View invoice
              </a>
            ) : null}
            {c.invoice.pdf_url ? (
              <a href={c.invoice.pdf_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                PDF
              </a>
            ) : null}
          </span>
        </Row>
      ) : null}
      {c.state === "succeeded" ? <FilesRows project={project} conversion={c} /> : null}
      <Row label="Run ID">
        <RunId id={c.conversion_id} />
      </Row>
    </dl>
  );
}

/** One label and value of a details list (Run details, Source details). */
export function DetailItem({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return <Row label={label}>{children}</Row>;
}

/** The details list's frame, shared with Source details. */
export const DETAIL_LIST_CLASS =
  "grid grid-cols-1 gap-x-4 gap-y-1 rounded-lg border border-edge bg-surface-0 p-3 text-xs sm:grid-cols-[max-content_1fr]";

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div data-testid={`detail-${label}`} className="contents">
      <dt className="pt-1 text-fg-muted sm:pt-0">{label}</dt>
      <dd className="min-w-0 break-words text-fg">{children}</dd>
    </div>
  );
}

/** Sizes, and until when unused files are kept. */
function FilesRows({ project, conversion: c }: { project: Project; conversion: Conversion }): JSX.Element | null {
  const deleted = project.files_deleted_at !== undefined;
  const { files } = useRunFiles(deleted ? undefined : c);
  if (deleted) {
    return <Row label="Files">Deleted on {when(project.files_deleted_at!)}</Row>;
  }
  const sized = (files ?? []).filter((f) => f.size_bytes !== undefined);
  return (
    <>
      {sized.length > 0 ? (
        <Row label="File sizes">
          {sized
            .map((f) => `${fileWords(f.format)}${f.part ? ` part ${f.part}` : ""} ${formatBytes(f.size_bytes!)}`)
            .join(", ")}
        </Row>
      ) : null}
      {project.files_delete_at ? <Row label="Kept until">{when(project.files_delete_at)}</Row> : null}
    </>
  );
}

function RunId({ id }: { id: string }): JSX.Element {
  // local UI: the word after a copy
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span data-testid="run-id" className="font-mono break-all">
        {id}
      </span>
      <button
        type="button"
        data-testid="run-id-copy"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(id)
            .then(() => setCopied(true))
            .catch(() => {});
        }}
        className="text-primary hover:underline"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

/** A charged run's receipt: the run's own receipt_url (gateway 00178),
 * else, on older gateways, from the purchases list (its first page). */
function useReceipt(c: Conversion): string | null {
  const gateway = useGateway();
  const [receipts, setReceipts] = useAtom(runReceiptsAtom);
  const charged = c.billing?.status === "charged" || c.billing?.status === "balance_settled" || c.billing?.status === "refunded";
  // the run says (a value or null): no paging through the purchases
  const own = "receipt_url" in c || "invoice" in c;
  useEffect(() => {
    if (own || !charged || receipts.state !== "idle") return;
    setReceipts({ state: "loading", urls: {} });
    gateway
      .getBillingHistory(undefined, "runs")
      .then((h) => {
        const urls: Record<string, string> = {};
        for (const row of h.rows ?? []) {
          const url = row.receipt_url ?? row.invoice?.hosted_invoice_url;
          if (!url) continue;
          for (const item of row.items ?? []) urls[item.conversion_id] ??= url;
        }
        for (const ch of h.charges ?? []) {
          const url = ch.receipt_url ?? ch.hosted_invoice_url;
          if (!url) continue;
          for (const item of ch.items ?? []) urls[item.conversion_id] ??= url;
        }
        setReceipts({ state: "loaded", urls });
      })
      .catch(() => setReceipts({ state: "loaded", urls: {} }));
  }, [own, charged, receipts.state, gateway, setReceipts]);
  if (own) return c.receipt_url ?? null;
  return receipts.urls[c.conversion_id] ?? null;
}
