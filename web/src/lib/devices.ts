/**
 * The device pages (S3D-51): /devices/<slug>, one per headset or pair of
 * glasses, each with which file to choose, how to open it and one button.
 * Factual and short (S3D-45): "works with" / "ready for", nothing more.
 * File names match the Make 3D page (lib/glossary FORMAT_NAMES).
 */

import { formatName } from "@/lib/glossary";
import { EN, type Tr } from "@/lib/i18n/t";
import { SITE_NAME } from "@/lib/site";

export interface DevicePage {
  slug: string;
  name: string;
  /** "Watch 3D videos on Samsung Galaxy XR" */
  title: string;
  description: string;
  /** 3–5 short lines */
  lines: string[];
  /** "ready for" instead of "works with" */
  upcoming?: string;
  /** one line on the file it uses */
  fileNote?: string;
}

/** The format names the lines carry ({sbs}, {half}, {spatial}). */
function names(t: Tr): Record<string, string> {
  return {
    sbs: formatName("sbs", t),
    half: formatName("half_sbs", t),
    spatial: formatName("mvhevc", t),
    site: SITE_NAME,
  };
}

/** A page's lines: devices.pages.<key>.line1…lineN. */
function lines(t: Tr, key: string, n: number, v: Record<string, string>): string[] {
  return Array.from({ length: n }, (_, i) => t(`devices.pages.${key}.line${i + 1}`, v));
}

function glasses(slug: string, name: string, t: Tr): DevicePage {
  const v = { ...names(t), name };
  return {
    slug,
    name,
    title: t("devices.glasses.title", v),
    description: t("devices.glasses.description", v),
    fileNote: t("devices.notes.sbs", v),
    lines: lines(t, "glasses", 4, v),
  };
}

/** One headset's page, its copy from devices.pages.<key>. */
function headset(
  slug: string,
  key: string,
  name: string,
  n: number,
  t: Tr,
  note: "sbs" | "spatial" | "own",
): DevicePage {
  const v = { ...names(t), name };
  return {
    slug,
    name,
    title: t(`devices.pages.${key}.title`, v),
    description: t(`devices.pages.${key}.description`, v),
    fileNote: note === "own" ? t(`devices.pages.${key}.fileNote`, v) : t(`devices.notes.${note}`, v),
    lines: lines(t, key, n, v),
  };
}

/** The device pages in the reader's language (English by default). */
export function devicePages(t: Tr = EN): readonly DevicePage[] {
  const v = names(t);
  return [
    headset("vision-pro", "visionPro", "Apple Vision Pro", 4, t, "spatial"),
    headset("galaxy-xr", "galaxyXr", "Samsung Galaxy XR", 3, t, "sbs"),
    // owner 2026-11-04: Quest plays full side by side; half at 4K and up
    headset("meta-quest", "metaQuest", "Meta Quest", 4, t, "own"),
    headset("pico", "pico", "Pico", 3, t, "sbs"),
    headset("steam-frame", "steamFrame", "Steam Frame", 3, t, "sbs"),
    glasses("xreal", "XREAL", t),
    glasses("viture", "VITURE", t),
    glasses("rayneo", "RayNeo", t),
    {
      slug: "meta-vr-glasses",
      name: "Meta VR Glasses",
      title: t("devices.pages.metaVrGlasses.title", v),
      description: t("devices.pages.metaVrGlasses.description", v),
      upcoming: t("devices.pages.metaVrGlasses.upcoming", v),
      lines: lines(t, "metaVrGlasses", 3, v),
    },
  ];
}

/** English (the sitemap, static params). */
export const DEVICE_PAGES: readonly DevicePage[] = devicePages();

export function devicePage(slug: string, t: Tr = EN): DevicePage | undefined {
  return (t === EN ? DEVICE_PAGES : devicePages(t)).find((d) => d.slug === slug);
}

export type DeviceIcon = "visor" | "galaxy" | "quest" | "pico" | "frame" | "glasses" | "tv";

/** The landing's "Works with" row (S3D-51): name, icon, page. */
export interface WorksWithItem {
  label: string;
  icon: DeviceIcon;
  slug?: string;
  soon?: boolean;
}

export function worksWith(t: Tr = EN): readonly WorksWithItem[] {
  return [
    { label: "Apple Vision Pro", icon: "visor", slug: "vision-pro" },
    { label: "Samsung Galaxy XR", icon: "galaxy", slug: "galaxy-xr" },
    { label: "Meta Quest", icon: "quest", slug: "meta-quest" },
    { label: "Pico", icon: "pico", slug: "pico" },
    { label: "Steam Frame", icon: "frame", slug: "steam-frame" },
    { label: t("devices.worksWith.xrGlasses"), icon: "glasses" },
    { label: t("devices.worksWith.tvs"), icon: "tv" },
    {
      label: t("devices.worksWith.metaVrGlasses"),
      icon: "glasses",
      slug: "meta-vr-glasses",
      soon: true,
    },
  ];
}

/** English */
export const WORKS_WITH: readonly WorksWithItem[] = worksWith();
