/**
 * /sitemap.xml — only the public, indexable pages. App routes are
 * session-gated and disallowed in robots.ts. lastModified is baked at
 * build time, which is exactly when these static pages can change.
 */

import type { MetadataRoute } from "next";

import { DEVICE_PAGES } from "@/lib/devices";
import { SITE_URL } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    {
      url: `${SITE_URL}/`,
      lastModified,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/pricing`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/plans`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    // WEB-02: the introduction the Spatial Video Studio apps open
    {
      url: `${SITE_URL}/app`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    // the headset app's own introduction, with spatial samples
    {
      url: `${SITE_URL}/vision-pro`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    ...DEVICE_PAGES.map((d) => ({
      url: `${SITE_URL}/devices/${d.slug}`,
      lastModified,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    {
      url: `${SITE_URL}/privacy`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/terms`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
