/**
 * Canonical production origin for SEO surfaces (metadataBase, canonical
 * URLs, sitemap, robots, JSON-LD). stereo3d.studio is the primary domain;
 * stereo3dstudio.com 301-redirects to it. Hardcoded rather than derived
 * from Vercel env so canonicals always point at production — Vercel
 * preview deploys are already noindexed via X-Robots-Tag, so previews
 * claiming the production canonical is correct, not a leak.
 */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://stereo3d.studio";

export const SITE_NAME = "Stereo3D Studio";
