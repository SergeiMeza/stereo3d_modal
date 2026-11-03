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
}

const SBS = FORMAT_NAMES.sbs;
const HALF = FORMAT_NAMES.half_sbs;
const SPATIAL = FORMAT_NAMES.mvhevc;

function glasses(slug: string, name: string): DevicePage {
  return {
    slug,
    name,
    title: `Watch 3D videos on ${name} glasses`,
    description: `Turn your 2D videos into side-by-side 3D and watch them on ${name} glasses.`,
    lines: [
      `Choose ${SBS} when you make your video 3D.`,
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
    lines: [
      `Choose ${SPATIAL} when you make your video 3D.`,
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
    lines: [
      `Choose ${SBS} when you make your video 3D.`,
      "Download it on the headset.",
      "Open it in Gallery or Files and choose 3D side by side.",
    ],
  },
  {
    slug: "meta-quest",
    name: "Meta Quest",
    title: "Watch 3D videos on Meta Quest",
    description:
      "Turn your 2D videos into side-by-side 3D and watch them on Meta Quest.",
    lines: [
      `Choose ${HALF} when you make your video 3D.`,
      "Open this site in the Meta Quest Browser and select View in 3D, or open the file in a video player.",
      "In the player, choose 3D side by side.",
    ],
  },
  {
    slug: "pico",
    name: "Pico",
    title: "Watch 3D videos on Pico",
    description: "Turn your 2D videos into side-by-side 3D and watch them on Pico.",
    lines: [
      `Choose ${SBS} when you make your video 3D.`,
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
    lines: [
      `Choose ${SBS} when you make your video 3D.`,
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
      "Stereo3D Studio is ready for Meta VR Glasses, expected in spring 2027.",
    upcoming: "spring 2027",
    lines: [
      "Meta VR Glasses are expected in spring 2027.",
      `Stereo3D Studio makes ${SBS} and ${SPATIAL} files today.`,
      "We'll add how to watch here when the glasses are out.",
    ],
  },
];

export function devicePage(slug: string): DevicePage | undefined {
  return DEVICE_PAGES.find((d) => d.slug === slug);
}

/** The landing's "Works with" row. */
export const WORKS_WITH: readonly { label: string; slug: string }[] = [
  { label: "Apple Vision Pro", slug: "vision-pro" },
  { label: "Samsung Galaxy XR", slug: "galaxy-xr" },
  { label: "Meta Quest", slug: "meta-quest" },
  { label: "Pico", slug: "pico" },
  { label: "Steam Frame", slug: "steam-frame" },
  { label: "XR glasses", slug: "xreal" },
];
