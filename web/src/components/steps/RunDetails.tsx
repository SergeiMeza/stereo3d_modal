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
import { eyeSize, METHOD_NAMES, qualityChoices, qualityLabelFor, STEP_NAMES, stepName } from "@/lib/glossary";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";

import { audioLine, fileQualityLine } from "./FileQuality";
import { fpsLabel } from "./frameRate";
import { formatCents } from "./money";
import { runPrice } from "./PreviousRuns";
import { useRunFiles } from "./RunFiles";
import { runDetailsOpenAtom, runReceiptsAtom } from "./runDetailsAtoms";
import { ltrRuns } from "@/lib/i18n/bidi";
import { offerLabel } from "@/lib/campaign";

const TERMINAL: ReadonlySet<Conversion["state"]> = new Set(["succeeded", "failed", "canceled", "expired"]);

/** Formats with words (files.details.fileWords.<format>): "Side by side .mp4" */
const FILE_WORD_KEYS: Record<string, string> = {
  sbs: "sbs",
  half_sbs: "halfSbs",
  anaglyph: "anaglyph",
  depth: "depth",
  depth_vis: "depthVis",
};

/** "Vision Pro .mov" (a device name, the same in every language) */
function fileWords(format: string, t: Tr): string {
  if (format === "mvhevc") return "Vision Pro .mov";
  const key = FILE_WORD_KEYS[format];
  return key ? t(`files.details.fileWords.${key}`) : format;
}

/** "Nov 7, 14:05" */
function when(iso: string, t: Tr): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(t.intl, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "Scene 3" / "Scenes 3–5", only while the cuts are the ones it ran with. */
function scenesOf(project: Project, c: Conversion, from: number, to: number, t: Tr): string | null {
  const scenes = project.scenes;
  if (!scenes || !project.probe) return null;
  if (c.scenes_version !== undefined && c.scenes_version !== scenes.version) return null;
  const ranges = cutsToRanges(scenes.cuts ?? [], project.probe.num_frames);
  const hit = ranges.map((r, i) => ({ r, i })).filter(({ r }) => r[0] < to && r[1] > from);
  if (hit.length === 0) return null;
  const a = hit[0].i + 1;
  const b = hit[hit.length - 1].i + 1;
  return a === b ? t("files.details.scene", { n: a }) : t("files.details.scenes", { a, b });
}

export interface DetailRow {
  label: string;
  value: ReactNode;
  /** the English label, for the row's test id in every language */
  id?: string;
}

/** The rows for a run: only what it carries. Exported for tests. */
export function detailRows(project: Project, c: Conversion, t: Tr = EN): DetailRow[] {
  const rows: DetailRow[] = [];
  // key: files.details.rows.<key>
  const add = (key: string, value: ReactNode | null | undefined | false) => {
    const k = `files.details.rows.${key}`;
    if (value !== null && value !== undefined && value !== false && value !== "") {
      rows.push({ label: t(k), value, id: EN(k) });
    }
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
    "what",
    [
      STEP_NAMES[c.step ?? "production"] ? stepName(c.step ?? "production", t) : t("runs.tracker.runFallback"),
      METHOD_NAMES[conversionMethod(c)],
      quickLook ? t("files.details.rows.quickLook") : null,
    ]
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
      "part",
      [
        whole && !preview ? t("files.details.wholeVideo") : `${clock(from)} – ${clock(to)}`,
        formatVideoLength(secs, t),
        scenesOf(project, c, from, to, t),
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }

  // Output
  const choice = qualityChoices(project, t).find((q) => q.preset === p.preset);
  const size = probe && choice?.eyeShort ? eyeSize(probe, choice.eyeShort) : null;
  add(
    "quality",
    [
      qualityLabelFor(project, p.preset, t),
      size ? t("files.details.perEye", { width: String(size.width), height: String(size.height) }) : null,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  const fps = p.target_fps ?? probe?.fps;
  add("frameRate", fps ? fpsLabel(fps, t) : null);
  const made = c.state === "succeeded" && c.outputs && c.outputs.length > 0
    ? [...new Set(c.outputs.map((o) => o.replace(/_part\d+$/, "")))]
    : p.formats ?? [];
  add(c.state === "succeeded" ? "filesMade" : "filesOrdered", made.map((f) => fileWords(f, t)).join(", "));
  if (c.parts && c.parts.length > 1) add("parts", String(c.parts.length));

  // Look and depth, as the run stored them
  add("strength", p.depth_scale !== undefined ? `×${p.depth_scale.toFixed(2)}` : null);
  add("depthDetail", p.depth_res !== undefined ? t("files.details.px", { value: String(p.depth_res) }) : null);
  add("scenesTuned", p.scene_overrides && p.scene_overrides.length > 0 ? String(p.scene_overrides.length) : null);
  add(
    "originalEye",
    p.original_eye ? (p.original_eye === "left" ? t("files.details.left") : t("files.details.right")) : null,
  );
  // owner 2026-11-07: the File quality asked for, with what the finished
  // files measure ("High (measured 41 Mbit/s)"); the asked-for setting
  // alone while running or on older runs; never a guess
  // Classic keeps its bitrate list (owner 2026-11-07): its row says Bitrate
  add(conversionMethod(c) === "lifelike" ? "fileQuality" : "bitrate", fileQualityLine(c, t));
  add("audio", audioLine(c, t));
  // owner 2026-11-07: a Lifelike run always says On or Off for each
  // add-on, offered or not; Classic runs have none
  if (conversionMethod(c) === "lifelike") {
    const onOff = (v: boolean) => (v ? t("files.details.on") : t("files.details.off"));
    // owner 2026-11-07: included at 1080p when it applied; nothing when it
    // didn't apply there (a source at 1080p or below)
    if (c.foveation?.included === true) add("foveation", c.foveation.applied ? t("files.details.included") : null);
    else add("foveation", onOff(p.foveation === "static" || c.foveation?.applied === true));
    add("express", onOff(p.express === true));
    // gateway 00178: the run's own flags
    if (c.step === "lifelike_preview" && c.quick_look !== undefined) add("quickLook", onOff(c.quick_look));
    if (c.intro !== undefined) add("intro", onOff(c.intro));
  }

  // Timing
  add("ordered", when(c.created_at, t));
  if (TERMINAL.has(c.state)) {
    add("finished", when(c.updated_at, t));
    // gateway 00178: from when it left the line, so the wait isn't counted
    const took = (new Date(c.updated_at).getTime() - new Date(c.started_at ?? c.created_at).getTime()) / 1000;
    if (c.state === "succeeded" && took > 0) add("took", formatDuration(Math.round(took), t));
  }

  // Billing
  const free = c.billing?.status === "free_preview" || c.quote.breakdown?.free_preview === true;
  add("price", free ? t("files.details.freePreview") : runPrice(c, t));
  // gateway 00178: the free previews it used
  const units = c.free_preview_units ?? 0;
  if (units > 0) add("freePreviewsUsed", String(units));
  const b = c.quote.breakdown;
  if (!free && b) {
    const pro = b.pro_discount_cents ?? 0;
    const other = b.discount_cents ?? 0;
    if (pro > 0) {
      add(
        "discount",
        b.pro_discount_pct
          ? t("files.details.proDiscountPct", {
              plan: "Pro",
              pct: String(Math.round(b.pro_discount_pct * 100)),
              amount: formatCents(pro, t),
            })
          : t("files.details.proDiscount", { plan: "Pro", amount: formatCents(pro, t) }),
      );
    } else if (other > 0) {
      add("discount", t("files.details.minus", { amount: formatCents(other, t) }));
    }
  }
  // owner 2026-11-07: the launch offer the run had, in the quote's words
  const offer = c.campaign_cents ?? b?.campaign_cents ?? 0;
  if (!free && offer > 0) {
    add(
      "launchOffer",
      t("files.details.offer", {
        label: offerLabel(b?.campaign_pct, b?.campaign_label ?? t("files.details.rows.launchOffer"), t),
        amount: formatCents(offer, t),
      }),
    );
  }
  return rows;
}

export function RunDetails({ project, conversion: c }: { project: Project; conversion: Conversion }): JSX.Element {
  const t = useT();
  const [open, setOpen] = useAtom(runDetailsOpenAtom(c.conversion_id));
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger
        data-testid="run-details-toggle"
        className="group inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
      >
        {t("files.details.toggle")}
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
  const t = useT();
  const rows = detailRows(project, c, t);
  const receipt = useReceipt(c);
  const row = (key: string) => ({ label: t(`files.details.rows.${key}`), id: EN(`files.details.rows.${key}`) });
  return (
    <dl className={DETAIL_LIST_CLASS}>
      {rows.map((r) => (
        <Row key={r.id ?? r.label} label={r.label} id={r.id}>
          {typeof r.value === "string" ? ltrRuns(r.value, t) : r.value}
        </Row>
      ))}
      {receipt ? (
        <Row {...row("receipt")}>
          <a href={receipt} target="_blank" rel="noreferrer" className="text-primary hover:underline">
            {t("files.details.viewReceipt")}
          </a>
        </Row>
      ) : null}
      {c.invoice?.hosted_url || c.invoice?.pdf_url ? (
        <Row {...row("invoice")}>
          <span className="inline-flex flex-wrap items-center gap-2">
            {c.invoice.number ? <span className="font-mono">{c.invoice.number}</span> : null}
            {c.invoice.hosted_url ? (
              <a href={c.invoice.hosted_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                {t("files.details.viewInvoice")}
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
      <Row {...row("runId")}>
        <RunId id={c.conversion_id} />
      </Row>
    </dl>
  );
}

/** One label and value of a details list (Run details, Source details). */
export function DetailItem({
  label,
  id,
  children,
}: {
  label: string;
  /** the test id's name when the label is translated (default: the label) */
  id?: string;
  children: ReactNode;
}): JSX.Element {
  // right to left: a value built from parts keeps its numbers in order
  const t = useT();
  return (
    <Row label={label} id={id}>
      {typeof children === "string" ? ltrRuns(children, t) : children}
    </Row>
  );
}

/** The details list's frame, shared with Source details. */
export const DETAIL_LIST_CLASS =
  "grid grid-cols-1 gap-x-4 gap-y-1 rounded-lg border border-edge bg-surface-0 p-3 text-xs sm:grid-cols-[max-content_1fr]";

function Row({ label, id, children }: { label: string; id?: string; children: ReactNode }): JSX.Element {
  return (
    <div data-testid={`detail-${id ?? label}`} className="contents">
      <dt className="pt-1 text-fg-muted sm:pt-0">{label}</dt>
      <dd className="min-w-0 break-words text-fg">{children}</dd>
    </div>
  );
}

/** Sizes, and until when unused files are kept. */
function FilesRows({ project, conversion: c }: { project: Project; conversion: Conversion }): JSX.Element | null {
  const t = useT();
  const deleted = project.files_deleted_at !== undefined;
  const { files } = useRunFiles(deleted ? undefined : c);
  const row = (key: string) => ({ label: t(`files.details.rows.${key}`), id: EN(`files.details.rows.${key}`) });
  if (deleted) {
    return <Row {...row("files")}>{t("files.details.deletedOn", { date: when(project.files_deleted_at!, t) })}</Row>;
  }
  const sized = (files ?? []).filter((f) => f.size_bytes !== undefined);
  return (
    <>
      {sized.length > 0 ? (
        <Row {...row("fileSizes")}>
          {sized
            .map((f) =>
              f.part
                ? t("files.details.fileSizePart", {
                    name: fileWords(f.format, t),
                    part: f.part,
                    size: formatBytes(f.size_bytes!),
                  })
                : t("files.details.fileSize", { name: fileWords(f.format, t), size: formatBytes(f.size_bytes!) }),
            )
            .join(", ")}
        </Row>
      ) : null}
      {project.files_delete_at ? <Row {...row("keptUntil")}>{when(project.files_delete_at, t)}</Row> : null}
    </>
  );
}

function RunId({ id }: { id: string }): JSX.Element {
  // local UI: the word after a copy
  const t = useT();
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
        {copied ? t("files.details.copied") : t("files.details.copy")}
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
