"use client";

/**
 * A finished run's files (screens 08 and 09, S3D-31): one group per device
 * with a short how-to-watch line, then a row per file — Part N / Full,
 * the friendly file name, its size and Download. "View in 3D" (S3D-47)
 * sits above the groups. Signed links expire: a click on an expired link
 * fetches fresh ones first. Files stay downloadable after a failed
 * payment (S3D-22). In China mode the sample project's files (on the
 * samples CDN) show the region notice instead of View in 3D and Download.
 */

import { useAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import type { JSX, MouseEvent } from "react";

import type { Conversion, DownloadFile, Downloads, Format, Step } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { formatBytes } from "@/lib/format";
import { outputName } from "@/lib/glossary";
import { headsetHint, isHeadset, stereoFormatsFor } from "@/lib/headset";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";

import { splitPart, stepDownloads } from "./DownloadsList";
import { useClient, ViewIn3D } from "./ViewIn3D";
import { DownloadGate } from "@/components/billing/PayToDownload";
import { SampleRegionNotice } from "@/components/SampleRegionNotice";
import { sampleMediaBlocked } from "@/lib/samples";
import { useRegion } from "@/lib/useRegion";
import { AnotherFormat } from "./AnotherFormat";
import { runFilesAtom } from "./runFilesAtoms";
import { loadErrorText, useIsSample } from "./loadError";

interface DeviceGroupCopy {
  device: string;
  how: string;
}

const PREVIEW_STEPS: ReadonlySet<string> = new Set([
  "lifelike_preview",
  "stereo_preview",
]);

/** Who a file is for and how to watch it, in one line. */
export function deviceGroup(format: string, step?: Step | null, t: Tr = EN): DeviceGroupCopy {
  if (step && PREVIEW_STEPS.has(step) && format !== "mvhevc") {
    return {
      device: t("files.groups.anyScreen"),
      how:
        step === "lifelike_preview"
          ? t("files.groups.previewLifelikeHow")
          : t("files.groups.previewHow"),
    };
  }
  switch (format) {
    case "mvhevc":
      // a device name only, the same in every language
      return { device: "Apple Vision Pro", how: t("files.groups.mvhevcHow") };
    // owner decision 2026-11-04: Meta Quest plays full side by side
    case "sbs":
      return {
        device: t("files.groups.sbsDevice"),
        how: t("files.groups.sideBySideHow"),
      };
    case "half_sbs":
      return {
        device: t("files.groups.halfSbsDevice"),
        how: t("files.groups.sideBySideHow"),
      };
    case "anaglyph":
      return { device: t("files.groups.anyScreen"), how: t("files.groups.anaglyphHow") };
    case "depth":
      return { device: t("files.groups.depthDevice"), how: t("files.groups.depthHow") };
    default:
      return { device: outputName(format, t), how: "" };
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
  /** load the files again (a new format arrived, ADR 0137) */
  reload: () => void;
} {
  const client = useGateway();
  const id = conversion?.conversion_id ?? null;
  const step = conversion?.step;
  // ADR 0138: the run's files live in its atom (runFilesAtoms), so Get
  // another format sees when a new file is listed
  const [state, setState] = useAtom(runFilesAtom(id ?? ""));
  const sample = useIsSample();
  const t = useT();
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const load = useCallback(async () => {
    if (id === null) return null;
    const d = await client.getDownloads(id);
    const next = {
      files: filesOf(step, d),
      expiresAt: Date.now() + Math.max(0, (d.expires_in ?? 3600) - 30) * 1000,
      error: null,
    };
    // the ref first: a click right after must see the fresh links
    stateRef.current = next;
    setState(next);
    return next;
  }, [client, id, step, setState]);

  useEffect(() => {
    if (id === null || stateRef.current.files !== null) return;
    let cancelled = false;
    load().catch((e: unknown) => {
      if (!cancelled) setState((s) => ({ ...s, error: loadErrorText(e, sample, t("files.load.failed"), t) }));
    });
    return () => {
      cancelled = true;
    };
  }, [id, load, sample, setState, t]);

  const freshUrl = useCallback(
    async (name: string) => {
      let s: { files: DownloadFile[] | null; expiresAt: number } | null = stateRef.current;
      if (!s?.files || Date.now() >= s.expiresAt) s = await load();
      return s?.files?.find((f) => f.name === name)?.url ?? null;
    },
    [load],
  );

  const expired = useCallback(
    () => stateRef.current.files !== null && Date.now() >= stateRef.current.expiresAt,
    [],
  );

  const reload = useCallback(() => {
    void load().catch(() => {});
  }, [load]);

  return {
    files: id === null ? null : state.files,
    error: state.error,
    expired,
    freshUrl,
    reload,
  };
}

/** A format's short link text (Vision Pro is a device name, kept as is). */
function shortName(format: string, t: Tr): string {
  switch (format) {
    case "mvhevc":
      return "Vision Pro";
    case "sbs":
      return t("files.short.sbs");
    case "half_sbs":
      return t("files.short.halfSbs");
    case "anaglyph":
      return t("files.short.anaglyph");
    default:
      return outputName(format, t);
  }
}

/** A preview's files as small Download links, one per format (previews
 * are downloadable, free ones too, so a clip can go to a headset by
 * AirDrop; S3D-35 gates them like any download). */
export function PreviewDownloads({ conversion }: { conversion: Conversion }): JSX.Element | null {
  const t = useT();
  const { files, expired, freshUrl } = useRunFiles(conversion);
  const region = useRegion();
  if (!files || files.length === 0) return null;
  // China mode: samples-CDN files can't load; the player or View in 3D
  // beside these links already shows the region notice
  const list = groupFiles(files)
    .flatMap(([, l]) => l)
    .filter((f) => !sampleMediaBlocked(f.url, region));
  if (list.length === 0) return null;
  return (
    <DownloadGate className="text-xs text-primary hover:underline">
      <span data-testid="preview-downloads" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-fg-muted">{t("files.download")}</span>
        {list.map((f) => (
          <a
            key={f.name}
            href={f.url}
            download
            title={f.filename}
            data-testid={`preview-download-${f.name}`}
            onClick={(e) => {
              if (!expired()) return;
              e.preventDefault();
              const a = e.currentTarget;
              void freshUrl(f.name).then((url) => {
                if (!url) return;
                a.href = url;
                a.click();
              });
            }}
            className="text-primary hover:underline"
          >
            {shortName(f.format, t)}
            <span className="text-fg-muted"> · .{f.filename?.split(".").pop() ?? (f.format === "mvhevc" ? "mov" : "mp4")}</span>
          </a>
        ))}
      </span>
    </DownloadGate>
  );
}

export function RunFiles({
  conversion,
}: {
  conversion: Conversion;
}): JSX.Element {
  const t = useT();
  const { files, error, expired, freshUrl, reload } = useRunFiles(conversion);
  const client = useClient();
  const region = useRegion();
  const gateway = useGateway();
  // 00081: a play of View in 3D (fire-and-forget)
  const logPlay = (file: string) =>
    gateway.logPlay(conversion.conversion_id, file, PREVIEW_STEPS.has(conversion.step ?? "") ? "preview" : "view_in_3d");
  const preview = PREVIEW_STEPS.has(conversion.step ?? "");
  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (files === null) {
    return <p className="text-xs text-fg-muted">{t("files.fetching")}</p>;
  }
  if (files.length === 0) {
    return <p className="text-xs text-fg-muted">{t("files.empty")}</p>;
  }
  // ADR 0137: a finished run can get another format from its files, free
  const another =
    conversion.step === "production" ? <AnotherFormat conversion={conversion} onNewFile={reload} /> : null;
  const byFormat = Object.fromEntries(files.filter((f) => !f.part || f.part === 1).map((f) => [f.format, f.url]));

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

  // S3D-47 (screen 13b): in a headset browser the files that headset
  // shows in 3D come first as "This headset", each row with View in 3D
  // and one hint line for the page; the other files fold away
  const headsetFormats = stereoFormatsFor(client);
  const groups = groupFiles(files);
  const mine = groups.filter(([f]) => headsetFormats.includes(f as Format));
  const others = groups.filter(([f]) => !headsetFormats.includes(f as Format));
  const onHeadset = isHeadset(client) && mine.length > 0;
  // China mode: samples-CDN files can't load (View in 3D says so above the
  // groups; on a headset the notice stands there instead)
  const blocked = (f: DownloadFile) => sampleMediaBlocked(f.url, region);

  function group([format, list]: [string, DownloadFile[]], thisHeadset: boolean): JSX.Element {
    const g = deviceGroup(format, conversion.step, t);
    return (
      <section
        key={format}
        data-testid={`file-group-${format}`}
        className="flex flex-col gap-1.5 rounded-lg border border-edge bg-surface-0 p-3"
      >
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h4 className="text-sm font-medium text-fg">{g.device}</h4>
          {thisHeadset ? (
            <span className="rounded-full border border-primary/30 bg-primary/10 px-2 text-[11px] text-primary">
              {t("files.thisHeadset")}
            </span>
          ) : (
            <span className="text-xs text-fg-muted">{g.how}</span>
          )}
        </div>
        <ul className="flex flex-col gap-1">
          {list.map((f) => (
            <li
              key={f.name}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${thisHeadset ? "text-sm" : "text-xs"}`}
            >
              <span className="w-12 shrink-0 text-fg-muted">
                {f.part ? t("files.row.part", { part: f.part }) : preview ? t("files.row.clip") : t("files.row.full")}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-fg">
                {f.filename ?? outputName(f.name, t)}
              </span>
              {f.size_bytes !== undefined ? (
                <span className="text-fg-muted">{formatBytes(f.size_bytes)}</span>
              ) : null}
              {blocked(f) ? null : thisHeadset ? (
                <ViewIn3D files={{ [format]: f.url }} size="lg" hideHint onPlay={() => logPlay(f.name)} />
              ) : null}
              {blocked(f) ? null : (
                <DownloadGate
                  verb="download"
                  className={`text-primary hover:underline ${thisHeadset ? "px-2 py-3" : ""}`}
                >
                  <a
                    href={f.url}
                    // S3D-31: a bare download attribute — the saved name is the
                    // one the gateway sends (Content-Disposition), never ours
                    download
                    onClick={(e) => open(e, f.name)}
                    className={`text-primary hover:underline ${thisHeadset ? "px-2 py-3" : ""}`}
                  >
                    {t("files.download")}
                  </a>
                </DownloadGate>
              )}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (onHeadset) {
    return (
      <div data-testid="run-files" className="flex flex-col gap-3">
        {headsetHint(client, t) ? (
          <p data-testid="view-in-3d-hint" className="text-sm text-fg-muted">
            {headsetHint(client, t)}
          </p>
        ) : null}
        {files.some(blocked) ? <SampleRegionNotice /> : null}
        {mine.map((g) => group(g, true))}
        {another}
        {others.length > 0 ? (
          <details data-testid="other-files">
            <summary className="cursor-pointer text-sm text-fg-muted">
              {t("files.otherFiles", {
                devices: others.map(([f]) => deviceGroup(f, conversion.step, t).device).join(", "),
                count: others.reduce((n, [, l]) => n + l.length, 0),
              })}
            </summary>
            <div className="mt-2 flex flex-col gap-3">{others.map((g) => group(g, false))}</div>
          </details>
        ) : null}
      </div>
    );
  }

  return (
    <div data-testid="run-files" className="flex flex-col gap-3">
      <div>
        <ViewIn3D files={byFormat} onPlay={logPlay} />
      </div>
      {groups.map((g) => group(g, false))}
      {another}
    </div>
  );
}
