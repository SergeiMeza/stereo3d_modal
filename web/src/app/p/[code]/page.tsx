import type { Metadata } from "next";
import { Suspense } from "react";

import { HandoffPage } from "@/components/pay/HandoffPage";
import { getServerTr } from "@/lib/i18n/server";

// P8: opened on a phone or computer from a headset's link; public
export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerTr();
  return {
    title: t("meta.payHandoff.title"),
    robots: { index: false },
  };
}

export default async function HandoffRoute({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return (
    <Suspense>
      <HandoffPage code={code} />
    </Suspense>
  );
}
