/**
 * /plans — Business and Studio (pricing 2026-11). The numbers come from
 * GET /v1/pricing in the browser; /pricing shows the same cards under the
 * per-minute prices.
 */

import type { Metadata } from "next";

import { PlansScreen } from "@/components/pricing/PlansScreen";

export const metadata: Metadata = {
  title: "Plans",
  description: "Stereo3D Studio Business and Studio plans: usage included every month, lower prices, free previews and Express.",
  alternates: { canonical: "/plans" },
};

export default function PlansPage() {
  return <PlansScreen />;
}
