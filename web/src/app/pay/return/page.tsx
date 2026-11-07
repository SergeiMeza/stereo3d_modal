import type { Metadata } from "next";
import { Suspense } from "react";

import { RequireAuth } from "@/components/auth/RequireAuth";
import { PayReturnScreen } from "@/components/billing/PayReturnScreen";
import { getServerTr } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerTr();
  return {
    title: t("meta.payReturn.title"),
    robots: { index: false },
  };
}

export default function PayReturnPage() {
  return (
    <RequireAuth>
      <Suspense>
        <PayReturnScreen />
      </Suspense>
    </RequireAuth>
  );
}
