/**
 * The device pages (S3D-51): /devices/<slug>, one per headset or pair of
 * glasses, each with which file to choose, how to open it and one button.
 * Factual and short (S3D-45): "works with" / "ready for", nothing more.
 * File names match the Make 3D page (lib/glossary FORMAT_NAMES).
 */

import { FORMAT_NAMES } from "@/lib/glossary";

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

const NOTE_SBS = `A ${FORMAT_NAMES.sbs} file: one picture for each eye.`;
const NOTE_HALF = `A ${FORMAT_NAMES.half_sbs} file: one picture for each eye, each squeezed to half width.`;
const NOTE_SPATIAL = `A ${FORMAT_NAMES.mvhevc} file: plays in 3D in Photos.`;

const SBS = FORMAT_NAMES.sbs;
const HALF = FORMAT_NAMES.half_sbs;
const SPATIAL = FORMAT_NAMES.mvhevc;

function glasses(slug: string, name: string): DevicePage {
  return {
    slug,
    name,
    title: `Watch 3D videos on ${name} glasses`,
    description: `Turn your 2D videos into side-by-side 3D and watch them on ${name} glasses.`,
    fileNote: NOTE_SBS,
    lines: [
      `Make any video 3D and pick the ${SBS} file.`,
      "Play it on the phone or computer your glasses are connected to.",
      "Switch the glasses to 3D (SBS) mode.",
      "Play the video full screen.",
    ],
  };
}

export const DEVICE_PAGES: readonly DevicePage[] = [
  {
    slug: "vision-pro",
    name: "Apple Vision Pro",
    title: "Watch 3D videos on Apple Vision Pro",
    description:
      "Turn your 2D videos into spatial video and watch them in 3D on Apple Vision Pro.",
    fileNote: NOTE_SPATIAL,
    lines: [
      `Make any video 3D and pick the ${SPATIAL} file.`,
      "Download it on Vision Pro, or AirDrop it from your iPhone or Mac.",
      "Open it in Files or Photos. It plays in 3D.",
      "Or open this site in Safari on Vision Pro and select View in 3D.",
    ],
  },
  {
    slug: "galaxy-xr",
    name: "Samsung Galaxy XR",
    title: "Watch 3D videos on Samsung Galaxy XR",
    description:
      "Turn your 2D videos into side-by-side 3D and watch them on Samsung Galaxy XR.",
    fileNote: NOTE_SBS,
    lines: [
      `Make any video 3D and pick the ${SBS} file.`,
      "Copy it to the headset, or download it there.",
      "Open it in Gallery or Files, then choose 3D side-by-side.",
    ],
  },
  {
    slug: "meta-quest",
    name: "Meta Quest",
    title: "Watch 3D videos on Meta Quest",
    description:
      "Turn your 2D videos into side-by-side 3D and watch them on Meta Quest.",
    fileNote: NOTE_HALF,
    lines: [
      `Make any video 3D and pick the ${HALF} file.`,
      "Open this site in the Meta Quest Browser and select View in 3D, or open the file in a video player.",
      "In the player, choose 3D side by side.",
    ],
  },
  {
    slug: "pico",
    name: "Pico",
    title: "Watch 3D videos on Pico",
    description: "Turn your 2D videos into side-by-side 3D and watch them on Pico.",
    fileNote: NOTE_SBS,
    lines: [
      `Make any video 3D and pick the ${SBS} file.`,
      "Open this site in the Pico Browser and select View in 3D, or open the file in a video player.",
      "In the player, choose 3D left and right (side by side).",
    ],
  },
  {
    slug: "steam-frame",
    name: "Steam Frame",
    title: "Watch 3D videos on Steam Frame",
    description:
      "Turn your 2D videos into side-by-side 3D and watch them on Steam Frame.",
    fileNote: NOTE_SBS,
    lines: [
      `Make any video 3D and pick the ${SBS} file.`,
      "Copy it to the headset and open it in a video player.",
      "In the player, choose 3D side by side.",
    ],
  },
  glasses("xreal", "XREAL"),
  glasses("viture", "VITURE"),
  glasses("rayneo", "RayNeo"),
  {
    slug: "meta-vr-glasses",
    name: "Meta VR Glasses",
    title: "3D videos for Meta VR Glasses",
    description:
      "Spatial Video Studio on the web is ready for Meta VR Glasses, expected in spring 2027.",
    upcoming: "spring 2027",
    lines: [
      "Meta VR Glasses are expected in spring 2027.",
      `Spatial Video Studio on the web makes ${SBS} and ${SPATIAL} files today.`,
      "We'll add how to watch here when the glasses are out.",
    ],
  },
];

export function devicePage(slug: string): DevicePage | undefined {
  return DEVICE_PAGES.find((d) => d.slug === slug);
}

export type DeviceIcon = "visor" | "galaxy" | "quest" | "pico" | "frame" | "glasses" | "tv";

/** The landing's "Works with" row (S3D-51): name, icon, page. */
export const WORKS_WITH: readonly {
  label: string;
  icon: DeviceIcon;
  slug?: string;
  soon?: boolean;
}[] = [
  { label: "Apple Vision Pro", icon: "visor", slug: "vision-pro" },
  { label: "Samsung Galaxy XR", icon: "galaxy", slug: "galaxy-xr" },
  { label: "Meta Quest", icon: "quest", slug: "meta-quest" },
  { label: "Pico", icon: "pico", slug: "pico" },
  { label: "Steam Frame", icon: "frame", slug: "steam-frame" },
  { label: "XR glasses (XREAL, VITURE, RayNeo)", icon: "glasses" },
  { label: "3D TVs", icon: "tv" },
  {
    label: "Ready for Meta VR Glasses, spring 2027",
    icon: "glasses",
    slug: "meta-vr-glasses",
    soon: true,
  },
];
