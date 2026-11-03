/**
 * /pricing — the public price list (S3D-18). The numbers come from the
 * gateway's GET /v1/pricing in the browser.
 */

import type { Metadata } from "next";

import { PricingScreen } from "@/components/pricing/PricingScreen";

export const metadata: Metadata = {
  title: "Prices",
  description:
    "Stereo3D Studio prices: pay per minute of video, no subscription. Lifelike 3D and Classic 3D, 1080p to 4K.",
  alternates: { canonical: "/pricing" },
};

export default function PricingPage() {
  return <PricingScreen />;
}
