"use client";

/**
 * A finished run's files (screens 08 and 09, S3D-31): one group per device
 * with a short how-to-watch line, then a row per file — Part N / Full,
 * the friendly file name, its size and Download. "View in 3D" (S3D-47)
 * sits above the groups. Signed links expire: a click on an expired link
 * fetches fresh ones first. Files stay downloadable after a failed
 * payment (S3D-22).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, MouseEvent } from "react";

import type { Conversion, DownloadFile, Downloads, Step } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { formatBytes } from "@/lib/format";
import { outputName } from "@/lib/glossary";

import { splitPart, stepDownloads } from "./DownloadsList";
import { ViewIn3D } from "./ViewIn3D";

interface DeviceGroupCopy {
  device: string;
  how: string;
}

const PREVIEW_STEPS: ReadonlySet<string> = new Set([
  "lifelike_preview",
  "stereo_preview",
]);

/** Who a file is for and how to watch it, in one line. */
export function deviceGroup(format: string, step?: Step | null): DeviceGroupCopy {
  if (step && PREVIEW_STEPS.has(step) && format !== "mvhevc") {
    return {
      device: "Any screen",
      how:
        step === "lifelike_preview"
          ? "Plays here, with the free 3D check."
          : "Plays here, or in a headset's player.",
    };
  }
  switch (format) {
    case "mvhevc":
      return { device: "Apple Vision Pro", how: "AirDrop or Files. Shows in Photos." };
    case "sbs":
      return {
        device: "Galaxy XR, Pico, Steam Frame, XR glasses",
        how: "Open in the player and choose 3D side by side.",
      };
    case "half_sbs":
      return {
        device: "Meta Quest, 3D TVs and projectors",
        how: "Open in the player and choose 3D side by side.",
      };
    case "anaglyph":
      return { device: "Any screen", how: "Watch with red-cyan glasses." };
    case "depth":
      return { device: "Depth video", how: "For your own editing tools." };
    default:
      return { device: outputName(format), how: "" };
  }
}

const GROUP_ORDER = ["mvhevc", "sbs", "half_sbs", "anaglyph", "depth"];

/** A run's files from GET .../downloads, scoped to what its step sells:
 * the gateway's `files` list when present, else the name → URL map. */
export function filesOf(step: Step | null | undefined, d: Downloads): DownloadFile[] {
  const keep = stepDownloads(step, d.downloads);
  if (d.files && d.files.length > 0) {
    return d.files.filter((f) => keep[f.name] !== undefined || f.name in keep);
  }
  return Object.entries(keep).map(([name, url]) => {
    const sp = splitPart(name);
    return { name, url, format: sp?.base ?? name, ...(sp ? { part: sp.part } : {}) };
  });
}

/** format → files (parts in order), groups in the device order. */
export function groupFiles(files: DownloadFile[]): [string, DownloadFile[]][] {
  const by = new Map<string, DownloadFile[]>();
  for (const f of files) {
    const list = by.get(f.format) ?? [];
    list.push(f);
    by.set(f.format, list);
  }
  for (const list of by.values()) list.sort((a, b) => (a.part ?? 0) - (b.part ?? 0));
  const rank = (f: string) => {
    const i = GROUP_ORDER.indexOf(f);
    return i < 0 ? GROUP_ORDER.length : i;
  };
  return [...by.entries()].sort(([a], [b]) => rank(a) - rank(b));
}

/** Fetches a run's files once; refetches when the links have expired. */
export function useRunFiles(conversion: Conversion | undefined): {
  files: DownloadFile[] | null;
  error: string | null;
  /** true once the signed links have expired */
  expired: () => boolean;
  /** a fresh URL for a file (fetches new links when these expired) */
  freshUrl: (name: string) => Promise<string | null>;
} {
  const client = useGateway();
  const id = conversion?.conversion_id ?? null;
  const step = conversion?.step;
  const [state, setState] = useState<{
    id: string;
    files: DownloadFile[];
    expiresAt: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const load = useCallback(async () => {
    if (id === null) return null;
    const d = await client.getDownloads(id);
    const next = {
      id,
      files: filesOf(step, d),
      expiresAt: Date.now() + Math.max(0, (d.expires_in ?? 3600) - 30) * 1000,
    };
    // the ref first: a click right after must see the fresh links
    stateRef.current = next;
    setState(next);
    return next;
  }, [client, id, step]);

  useEffect(() => {
    if (id === null || stateRef.current?.id === id) return;
    let cancelled = false;
    load().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load the files.");
    });
    return () => {
      cancelled = true;
    };
  }, [id, load]);

  const freshUrl = useCallback(
    async (name: string) => {
      let s = stateRef.current;
      if (!s || Date.now() >= s.expiresAt) s = await load();
      return s?.files.find((f) => f.name === name)?.url ?? null;
    },
    [load],
  );

  const expired = useCallback(
    () => stateRef.current !== null && Date.now() >= stateRef.current.expiresAt,
    [],
  );

  return {
    files: state && state.id === id ? state.files : null,
    error,
    expired,
    freshUrl,
  };
}

export function RunFiles({
  conversion,
}: {
  conversion: Conversion;
}): JSX.Element {
  const { files, error, expired, freshUrl } = useRunFiles(conversion);
  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (files === null) {
    return <p className="text-xs text-fg-muted">Fetching your files…</p>;
  }
  if (files.length === 0) {
    return <p className="text-xs text-fg-muted">No files in this run.</p>;
  }
  const byFormat = Object.fromEntries(files.filter((f) => !f.part || f.part === 1).map((f) => [f.format, f.url]));
  const preview = PREVIEW_STEPS.has(conversion.step ?? "");

  // a live link downloads as is; an expired one gets fresh links first
  function open(e: MouseEvent<HTMLAnchorElement>, name: string): void {
    if (!expired()) return;
    e.preventDefault();
    const a = e.currentTarget;
    void freshUrl(name).then((url) => {
      if (!url) return;
      a.href = url;
      a.click();
    });
  }

  return (
    <div data-testid="run-files" className="flex flex-col gap-3">
      <div>
        <ViewIn3D files={byFormat} />
      </div>
      {groupFiles(files).map(([format, list]) => {
        const g = deviceGroup(format, conversion.step);
        return (
          <section
            key={format}
            data-testid={`file-group-${format}`}
            className="flex flex-col gap-1.5 rounded-lg border border-edge bg-surface-0 p-3"
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <h4 className="text-sm font-medium text-fg">{g.device}</h4>
              <span className="text-xs text-fg-muted">{g.how}</span>
            </div>
            <ul className="flex flex-col gap-1">
              {list.map((f) => (
                <li
                  key={f.name}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                >
                  <span className="w-12 shrink-0 text-fg-muted">
                    {f.part ? `Part ${f.part}` : preview ? "Clip" : "Full"}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-fg">
                    {f.filename ?? outputName(f.name)}
                  </span>
                  {f.size_bytes !== undefined ? (
                    <span className="text-fg-muted">{formatBytes(f.size_bytes)}</span>
                  ) : null}
                  <a
                    href={f.url}
                    download={f.filename ?? true}
                    onClick={(e) => open(e, f.name)}
                    className="text-primary hover:underline"
                  >
                    {preview ? "Play" : "Download"}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
