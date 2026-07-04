/**
 * /robots.txt — index the public pages (landing, legal), keep crawlers
 * out of the signed-in app surfaces, which render nothing useful without
 * a session anyway.
 */

import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/projects", "/account", "/onboarding", "/signin"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
