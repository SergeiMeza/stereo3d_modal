import { RequireAuth } from "@/components/auth/RequireAuth";
import type { Metadata } from "next";

import { BusinessSetup } from "@/components/business/BusinessSetup";
import { getServerTr } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerTr();
  return { title: t("meta.businessSetup.title", { business: "Business", studio: "Studio" }) };
}

export default function BusinessSetupPage() {
  return (
    <RequireAuth>
      <BusinessSetup />
    </RequireAuth>
  );
}
