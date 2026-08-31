"use client";

/**
 * Conversion history: every run of the project, newest first, with state,
 * quoted price, the conversion_id support handle (click to copy), and — for
 * succeeded runs — a downloads expander with inline preview players.
 */

import { useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import type { Conversion, Project } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";

import { DownloadsList, stepDownloads } from "./DownloadsList";
import { formatCents } from "./money";
import { INPAINT_LABELS, WARP_LABELS } from "./outputOptions";
import { StateChip } from "./StateChip";

const STEP_LABELS: Record<string, string> = {
  depth_preview: "Depth preview",
  stereo_preview: "Stereo preview",
  production: "Production",
};

/** One-line params summary for a run — the settings support (and the user)
 * care about when comparing runs. Only fields the run actually carried. */
export function paramsSummary(c: Conversion): string {
  const p = c.params;
  return [
    p.preset,
    p.formats?.length ? p.formats.join("+") : null,
    p.depth_res !== undefined ? `depth ${p.depth_res}` : null,
    // wire values ("propainter"/"none") are internal terms — show the
    // user-facing mode names instead
    p.inpaint ? INPAINT_LABELS[p.inpaint].toLowerCase() : null,
    p.warp ? WARP_LABELS[p.warp].toLowerCase() : null,
    p.depth_scale !== undefined ? `depth_scale ${p.depth_scale}` : null,
    p.scene_overrides?.length
      ? `${p.scene_overrides.length} scene override${p.scene_overrides.length === 1 ? "" : "s"}`
      : null,
    p.target_fps !== undefined ? `${p.target_fps} fps` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function HistoryList({ project }: { project: Project }): JSX.Element {
  const conversions = [...(project.conversions ?? [])].sort((a, b) =>
    a.created_at < b.created_at ? 1 : -1,
  );
  // The page title lives in the shared PageHeader (WorkspaceScreen).
  return (
    <section aria-label="Conversion history" className="flex flex-col gap-2">
      {conversions.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No conversions yet — run a step from the Depth, Stereo, or Deliver
          pages to get started.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {conversions.map((c) => (
            <HistoryRow key={c.conversion_id} conversion={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoryRow({ conversion: c }: { conversion: Conversion }): JSX.Element {
  const client = useGateway();
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [downloads, setDownloads] = useState<Record<string, string> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  async function copyId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(c.conversion_id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the id is still selectable */
    }
  }

  async function toggleDownloads(): Promise<void> {
    const next = !open;
    setOpen(next);
    if (next && downloads === null) {
      try {
        const d = await client.getDownloads(c.conversion_id);
        setDownloads(d.downloads);
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed to fetch downloads");
      }
    }
  }

  return (
    <li
      data-testid={`history-${c.conversion_id}`}
      className="rounded-lg border border-edge bg-surface-1 p-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">
          {STEP_LABELS[c.step ?? ""] ?? c.kind}
        </span>
        <StateChip state={c.state} />
        <span className="font-mono text-sm text-fg-muted">
          {formatCents(c.quote.amount_cents)}
        </span>
        <button
          type="button"
          onClick={() => void copyId()}
          title="Copy conversion id (quote this to support)"
          className="rounded border border-edge bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-fg-muted hover:text-fg"
        >
          {copied ? "copied" : c.conversion_id}
        </button>
        <time
          dateTime={c.created_at}
          className="ml-auto text-xs text-fg-muted"
        >
          {new Date(c.created_at).toLocaleString()}
        </time>
      </div>
      <p
        data-testid="history-params"
        className="mt-1 font-mono text-[11px] text-fg-muted"
      >
        {paramsSummary(c)}
      </p>
      {c.state === "succeeded" ? (
        <div className="mt-2">
          <Button
            variant="link"
            size="xs"
            aria-expanded={open}
            onClick={() => void toggleDownloads()}
            className="h-auto p-0"
          >
            {open ? "Hide downloads" : "Downloads"}
          </Button>
          {open ? (
            downloads !== null ? (
              <div className="mt-2">
                {/* cross-step audit table: full deliverable scope (step
                    undefined), which still keeps depth_vis un-downloadable */}
                <DownloadsList downloads={stepDownloads(undefined, downloads)} />
              </div>
            ) : error !== null ? (
              <p className="mt-2 text-xs text-red-400">{error}</p>
            ) : (
              <p className="mt-2 text-xs text-fg-muted">
                Fetching download links…
              </p>
            )
          ) : null}
        </div>
      ) : null}
      {c.state === "failed" && c.error ? (
        <p className="mt-2 text-xs text-red-400">{c.error.message}</p>
      ) : null}
    </li>
  );
}
