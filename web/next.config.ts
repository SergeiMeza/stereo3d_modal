import type { NextConfig } from "next";

const FIREBASE_AUTH_HOST =
  process.env.FIREBASE_AUTH_PROXY_HOST ?? "spatial-video-studio.firebaseapp.com";

const nextConfig: NextConfig = {
  // Firebase's sign-in handler served from our own origin (BL-15): with
  // NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=self the SDK opens /__/auth/handler on
  // this site, so redirect sign-in (Apple on phones and headsets) keeps
  // working where browsers partition third-party storage (Safari). Unused
  // until that env is set.
  async rewrites() {
    return [
      {
        source: "/__/auth/:path*",
        destination: `https://${FIREBASE_AUTH_HOST}/__/auth/:path*`,
      },
      {
        source: "/__/firebase/:path*",
        destination: `https://${FIREBASE_AUTH_HOST}/__/firebase/:path*`,
      },
    ];
  },
};

export default nextConfig;
