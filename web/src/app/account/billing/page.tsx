import type { Metadata } from "next";

import { RequireAuth } from "@/components/auth/RequireAuth";
import { BillingScreen } from "@/components/billing/BillingScreen";
import { getServerTr } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerTr();
  return {
    title: t("meta.billing.title"),
    robots: { index: false },
  };
}

export default function BillingPage() {
  return (
    <RequireAuth>
      <BillingScreen />
    </RequireAuth>
  );
}
