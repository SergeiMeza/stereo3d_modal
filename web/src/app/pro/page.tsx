/**
 * /pro — Spatial Video Studio Pro on the web (S3D-68). Signed in only: the
 * purchase belongs to the account. ProScreen reads ?next= (useSearchParams),
 * so it sits behind Suspense.
 */

import type { Metadata } from "next";
import { Suspense } from "react";

import { RequireAuth } from "@/components/auth/RequireAuth";
import { ProScreen } from "@/components/pro/ProScreen";
import { getServerTr } from "@/lib/i18n/server";
import { SITE_NAME } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerTr();
  return {
    // the product's name, the same in every language
    title: "Pro",
    description: t("meta.pro.description", { site: SITE_NAME, pro: "Pro" }),
    alternates: { canonical: "/pro" },
  };
}

export default function ProPage() {
  return (
    <RequireAuth>
      <Suspense fallback={null}>
        <ProScreen />
      </Suspense>
    </RequireAuth>
  );
}
