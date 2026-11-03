/**
 * /pricing — the public price list (S3D-18). The numbers come from the
 * gateway's GET /v1/pricing in the browser.
 */

import type { Metadata } from "next";

import { PricingScreen } from "@/components/pricing/PricingScreen";

export const metadata: Metadata = {
  title: "Prices",
  description:
    "Stereo3D Studio prices: pay per minute of video, or save with a plan. Lifelike 3D, 1080p to 8K.",
  alternates: { canonical: "/pricing" },
};

export default function PricingPage() {
  return <PricingScreen />;
}
