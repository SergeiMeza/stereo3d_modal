/**
 * /pricing — the public price list (S3D-18). The numbers come from the
 * gateway's GET /v1/pricing in the browser.
 */

import type { Metadata } from "next";

import { PricingScreen } from "@/components/pricing/PricingScreen";
import { METHOD_NAMES } from "@/lib/glossary";
import { getServerTr } from "@/lib/i18n/server";
import { SITE_NAME } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerTr();
  return {
    title: t("meta.pricing.title"),
    description: t("meta.pricing.description", { site: SITE_NAME, lifelike: METHOD_NAMES.lifelike }),
    alternates: { canonical: "/pricing" },
  };
}

export default function PricingPage() {
  return <PricingScreen />;
}
