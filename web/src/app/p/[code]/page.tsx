import type { Metadata } from "next";
import { Suspense } from "react";

import { HandoffPage } from "@/components/pay/HandoffPage";

// P8: opened on a phone or computer from a headset's link; public
export const metadata: Metadata = {
  title: "Pay for your 3D video",
  robots: { index: false },
};

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
