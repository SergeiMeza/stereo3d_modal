import type { Metadata } from "next";

import { RequireAuth } from "@/components/auth/RequireAuth";
import { BillingScreen } from "@/components/billing/BillingScreen";

export const metadata: Metadata = {
  title: "Billing",
  robots: { index: false },
};

export default function BillingPage() {
  return (
    <RequireAuth>
      <BillingScreen />
    </RequireAuth>
  );
}
