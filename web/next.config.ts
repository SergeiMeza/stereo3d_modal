import type { NextConfig } from "next";

/** Apple's app-site-association (passkeys for the SVS app, webcredentials):
 * public/.well-known/apple-app-site-association, also at the root path. */
export const AASA_PATH = "/.well-known/apple-app-site-association";
export const AASA_ROOT_PATH = "/apple-app-site-association";

/** Every path but Apple's files: those must answer on the bare domain too,
 * never redirected (Apple's fetch doesn't follow redirects). */
export const BARE_TO_WWW_SOURCE =
  "/:path((?!\\.well-known(?:/|$)|apple-app-site-association$).*)";

const nextConfig: NextConfig = {
  async headers() {
    return [AASA_PATH, AASA_ROOT_PATH].map((source) => ({
      source,
      headers: [{ key: "Content-Type", value: "application/json" }],
    }));
  },
  // stereo3d.studio → www, except Apple's files. Vercel does this redirect
  // at the domain level today (it can't exclude paths); once that's off,
  // this one takes over.
  async redirects() {
    return [
      {
        source: BARE_TO_WWW_SOURCE,
        has: [{ type: "host", value: "stereo3d.studio" }],
        destination: "https://www.stereo3d.studio/:path",
        permanent: true,
      },
    ];
  },
  async rewrites() {
    return [{ source: AASA_ROOT_PATH, destination: AASA_PATH }];
  },
};

export default nextConfig;
