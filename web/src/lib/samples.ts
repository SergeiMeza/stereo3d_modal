/**
 * Sample videos for the landing page (2026-11): five 15 s clips made with
 * Lifelike 3D on the test service, preset 4K (capped at the 1440p source).
 * The 2D sources are AI-generated clips we made ourselves, so they are ours
 * to share. Big files live on the public CDN under samples/2026-11/ (served
 * with Content-Disposition: attachment and a friendly file name); the muted
 * loops under samples/2026-11/loops/ play inline. Posters are local
 * (public/landing/samples/).
 */

export const SAMPLES_CDN =
  "https://cdn.public.spatial-video-studio.com/samples/2026-11";

export type SampleDownloadKind = "spatial" | "sbs" | "2d";

export interface SampleDownload {
  kind: SampleDownloadKind;
  /** Who the file is for, as the button says it. */
  label: string;
  ext: ".mov" | ".mp4";
  href: string;
  bytes: number;
}

export interface Sample {
  slug: string;
  title: string;
  detail: string;
  /** Per eye, as delivered. */
  size: string;
  seconds: number;
  poster: string;
  loop: { mp4: string; webm: string };
  redCyanLoop: { mp4: string; webm: string };
  downloads: SampleDownload[];
}

function sample(
  slug: string,
  title: string,
  detail: string,
  size: string,
  bytes: { spatial: number; sbs: number; original: number },
): Sample {
  const loops = `${SAMPLES_CDN}/loops/${slug}`;
  return {
    slug,
    title,
    detail,
    size,
    seconds: 15,
    poster: `/landing/samples/${slug}-poster-1600.webp`,
    loop: { mp4: `${loops}-loop.mp4`, webm: `${loops}-loop.webm` },
    redCyanLoop: {
      mp4: `${loops}-redcyan-loop.mp4`,
      webm: `${loops}-redcyan-loop.webm`,
    },
    downloads: [
      {
        kind: "spatial",
        label: "Vision Pro (spatial video)",
        ext: ".mov",
        href: `${SAMPLES_CDN}/${slug}-spatial.mov`,
        bytes: bytes.spatial,
      },
      {
        kind: "sbs",
        label: "Quest, Pico, Galaxy XR, XR glasses (side by side)",
        ext: ".mp4",
        href: `${SAMPLES_CDN}/${slug}-sbs.mp4`,
        bytes: bytes.sbs,
      },
      {
        kind: "2d",
        label: "2D original, to compare",
        ext: ".mp4",
        href: `${SAMPLES_CDN}/${slug}-2d.mp4`,
        bytes: bytes.original,
      },
    ],
  };
}

export const SAMPLES: Sample[] = [
  sample(
    "mustang-golden-hour",
    "Mustang at golden hour",
    "A classic car through city streets at sunset.",
    "2560×1440 per eye",
    { spatial: 25_962_810, sbs: 52_054_247, original: 28_714_713 },
  ),
  sample(
    "pool-day",
    "Pool day",
    "A backyard swim, splashes and sun on the water.",
    "2560×1440 per eye",
    { spatial: 25_341_089, sbs: 66_120_140, original: 34_061_403 },
  ),
  sample(
    "seoul-street",
    "Seoul street",
    "Rooftops, an alley cat and a morning coffee.",
    "2560×1440 per eye",
    { spatial: 30_540_479, sbs: 51_351_026, original: 28_166_547 },
  ),
  sample(
    "diner-freeze",
    "Diner time freeze",
    "Breakfast frozen in mid-air in a retro diner.",
    "2560×1440 per eye",
    { spatial: 26_192_352, sbs: 51_068_838, original: 25_037_751 },
  ),
  sample(
    "matsuri-night",
    "Matsuri night",
    "Lanterns and street food at a summer festival. Portrait.",
    "1440×2560 per eye",
    { spatial: 21_422_666, sbs: 57_998_596, original: 25_601_700 },
  ),
];

/** The before/after pair in the hero: the source (framed like the 3D
 * result) and the same moment in red-cyan. */
export const HERO_COMPARE = {
  before: "/landing/samples/mustang-golden-hour-before-1600.webp",
  after: "/landing/samples/mustang-golden-hour-redcyan-1600.webp",
  title: "Mustang at golden hour",
};
