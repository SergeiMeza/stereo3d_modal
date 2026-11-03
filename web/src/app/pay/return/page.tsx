import type { Metadata } from "next";
import { Suspense } from "react";

import { RequireAuth } from "@/components/auth/RequireAuth";
import { PayReturnScreen } from "@/components/billing/PayReturnScreen";

export const metadata: Metadata = {
  title: "Payment",
  robots: { index: false },
};

export default function PayReturnPage() {
  return (
    <RequireAuth>
      <Suspense>
        <PayReturnScreen />
      </Suspense>
    </RequireAuth>
  );
}
