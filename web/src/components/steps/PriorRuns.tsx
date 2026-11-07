"use client";

/**
 * Compact list of a step's prior conversions (newest first): state, a
 * step-specific params summary from the caller, quoted price, time, and —
 * for succeeded runs — a downloads expander with inline players, scoped to
 * the run's step (stepDownloads). The full cross-step table lives on
 * History.
 */

import { useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import type { Conversion } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useT } from "@/lib/i18n/I18nProvider";

import { DownloadsList, stepDownloads } from "./DownloadsList";
import { formatCents } from "./money";
import { StateChip } from "./StateChip";
import { loadErrorText, useIsSample } from "./loadError";

export interface PriorRunsProps {
  title: string;
  conversions: Conversion[];
  /** One-line params summary for a row (e.g. "depth 980 · 12 fps"). */
  meta: (c: Conversion) => string;
}

export function PriorRuns({
  title,
  conversions,
  meta,
}: PriorRunsProps): JSX.Element | null {
  const sorted = [...conversions].sort((a, b) =>
    a.created_at < b.created_at ? 1 : -1,
  );
  if (sorted.length === 0) return null;
  return (
    <section aria-label={title} data-testid="prior-runs" className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
        {title}
      </h3>
      <ul className="flex flex-col gap-2">
        {sorted.map((c) => (
          <PriorRunRow key={c.conversion_id} conversion={c} meta={meta(c)} />
        ))}
      </ul>
    </section>
  );
}

function PriorRunRow({
  conversion: c,
  meta,
}: {
  conversion: Conversion;
  meta: string;
}): JSX.Element {
  const t = useT();
  const client = useGateway();
  const [open, setOpen] = useState(false);
  const [downloads, setDownloads] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sample = useIsSample();

  async function toggle(): Promise<void> {
    const next = !open;
    setOpen(next);
    if (next && downloads === null) {
      try {
        const d = await client.getDownloads(c.conversion_id);
        setDownloads(d.downloads);
      } catch (e) {
        setError(loadErrorText(e, sample, t("files.load.failed"), t));
      }
    }
  }

  return (
    <li
      data-testid={`prior-run-${c.conversion_id}`}
      className="rounded-lg border border-edge bg-surface-1 p-2.5"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <StateChip conversion={c} />
        <span className="font-mono text-xs text-fg-muted">{meta}</span>
        <span className="font-mono text-xs">{formatCents(c.quote.amount_cents, t)}</span>
        <time dateTime={c.created_at} className="ms-auto text-[11px] text-fg-muted">
          {new Date(c.created_at).toLocaleString(t.intl)}
        </time>
      </div>
      {c.state === "succeeded" ? (
        <div className="mt-1.5">
          <Button
            variant="link"
            size="xs"
            aria-expanded={open}
            onClick={() => void toggle()}
            className="h-auto p-0"
          >
            {open ? t("runs.prior.hideDownloads") : t("runs.prior.downloads")}
          </Button>
          {open ? (
            downloads !== null ? (
              <div className="mt-2">
                <DownloadsList downloads={stepDownloads(c.step, downloads)} />
              </div>
            ) : error !== null ? (
              <p className="mt-2 text-xs text-red-400">{error}</p>
            ) : (
              <p className="mt-2 text-xs text-fg-muted">{t("runs.prior.fetching")}</p>
            )
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
