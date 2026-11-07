import type { Metadata } from "next";
import { Suspense } from "react";

import { PayRequestPage } from "@/components/pay/PayRequestPage";
import { getServerTr } from "@/lib/i18n/server";

// D7 (owner 2026-11-07): the link in a failed payment's mail; public
export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerTr();
  return {
    title: t("meta.payRequest.title"),
    robots: { index: false },
  };
}

export default async function PayRequestRoute({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <Suspense>
      <PayRequestPage token={token} />
    </Suspense>
  );
}
