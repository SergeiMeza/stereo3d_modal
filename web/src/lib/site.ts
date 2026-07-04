/**
 * Canonical production origin for SEO surfaces (metadataBase, canonical
 * URLs, sitemap, robots, JSON-LD). www.stereo3d.studio is the primary
 * domain (Vercel-recommended www setup); the stereo3d.studio apex and
 * stereo3dstudio.com both 301-redirect to it. Hardcoded rather than
 * derived from Vercel env so canonicals always point at production —
 * Vercel preview deploys are already noindexed via X-Robots-Tag, so
 * previews claiming the production canonical is correct, not a leak.
 */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.stereo3d.studio";

export const SITE_NAME = "Stereo3D Studio";
