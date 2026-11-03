/**
 * Sample videos for the landing page (2026-11): nine 9–15 s clips of the
 * owner's licensed footage, made with Lifelike 3D on the test service at
 * 4K with the Master bitrate (Foveated Detail on the portrait clip). Big
 * files live on the public CDN under samples/2026-11/ (served with
 * Content-Disposition: attachment and a friendly file name); the muted
 * loops under samples/2026-11/loops/ play inline, H.264 listed first.
 * Posters are local (public/landing/samples/). The five earlier samples'
 * CDN files stay in place for old links but are no longer listed.
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
  seconds = 15,
): Sample {
  const loops = `${SAMPLES_CDN}/loops/${slug}`;
  return {
    slug,
    title,
    detail,
    size,
    seconds,
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
    "rooftop-party",
    "Rooftop party",
    "Hands in the air at a sunset party above the forest.",
    "3840×2160 per eye",
    { spatial: 281_202_002, sbs: 245_373_999, original: 26_401_666 },
    12,
  ),
  sample(
    "drift-chase",
    "Drift chase",
    "A drone chases a drifting car through clouds of tyre smoke.",
    "3840×2160 per eye",
    { spatial: 222_517_286, sbs: 296_814_594, original: 29_772_452 },
  ),
  sample(
    "rooftop-singalong",
    "Rooftop singalong",
    "Singing, guitar and drinks with friends on a rooftop.",
    "3840×2160 per eye",
    { spatial: 195_018_598, sbs: 178_562_808, original: 17_248_841 },
    9,
  ),
  sample(
    "sunset-session",
    "Sunset session",
    "A singer and her band on a rooftop as the sun goes down.",
    "3840×2160 per eye",
    { spatial: 319_972_232, sbs: 299_105_920, original: 29_190_011 },
  ),
  sample(
    "studio-take",
    "Studio take",
    "A singer gives it everything at the mic.",
    "3840×2160 per eye",
    { spatial: 180_343_615, sbs: 179_324_835, original: 18_121_783 },
    9,
  ),
  sample(
    "street-dance",
    "Street dance",
    "Three friends dance in front of a glass tower. Portrait.",
    "2160×3840 per eye",
    { spatial: 286_271_450, sbs: 282_889_234, original: 29_034_621 },
  ),
  sample(
    "inside-the-wave",
    "Inside the wave",
    "A surfer's view through the barrel of a breaking wave.",
    "3840×2160 per eye",
    { spatial: 129_546_110, sbs: 168_236_172, original: 16_533_473 },
    9,
  ),
  sample(
    "fencing-hall",
    "Fencing hall",
    "Fencers spar in a training hall as others stride past.",
    "3840×2160 per eye",
    { spatial: 236_561_946, sbs: 250_113_238, original: 24_547_136 },
    13,
  ),
  sample(
    "river-stones",
    "River stones",
    "A girl steps across sunlit stones by a forest stream.",
    "3840×2026 per eye",
    { spatial: 304_095_765, sbs: 258_753_773, original: 29_621_691 },
    14,
  ),
];
