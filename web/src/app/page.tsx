/**
 * / — landing route. Server component so the page can carry SEO surfaces
 * (canonical URL, JSON-LD for Organization/WebSite/SoftwareApplication);
 * the interactive body lives in LandingContent (client, auth-aware CTA).
 * Site-wide metadata (titles, OG/Twitter cards) is in app/layout.tsx.
 */

import type { Metadata } from "next";

import { FEEDBACK_EMAIL } from "@/lib/contact";
import { LandingContent } from "@/components/landing/LandingContent";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: "Spatial AI Labs Ltd",
      url: SITE_URL,
      email: FEEDBACK_EMAIL,
      address: {
        "@type": "PostalAddress",
        addressLocality: "London",
        addressCountry: "GB",
      },
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: SITE_URL,
      name: SITE_NAME,
      publisher: { "@id": `${SITE_URL}/#organization` },
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#app`,
      name: SITE_NAME,
      url: SITE_URL,
      applicationCategory: "MultimediaApplication",
      operatingSystem: "Web",
      description:
        "Convert 2D videos to 3D: Vision Pro spatial video for Apple Vision Pro, and side by side 3D for Meta Quest, Pico, Samsung Galaxy XR and 3D displays.",
      creator: { "@id": `${SITE_URL}/#organization` },
    },
  ],
};

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <LandingContent />
    </>
  );
}
