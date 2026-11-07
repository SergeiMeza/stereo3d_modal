/**
 * /plans — Business and Studio (pricing 2026-11). The numbers come from
 * GET /v1/pricing in the browser; /pricing shows the same cards under the
 * per-minute prices.
 */

import type { Metadata } from "next";

import { PlansScreen } from "@/components/pricing/PlansScreen";
import { getServerTr } from "@/lib/i18n/server";
import { SITE_NAME } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerTr();
  return {
    title: t("meta.plans.title"),
    description: t("meta.plans.description", { site: SITE_NAME, business: "Business", studio: "Studio" }),
    alternates: { canonical: "/plans" },
  };
}

export default function PlansPage() {
  return <PlansScreen />;
}
