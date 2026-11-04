import type { Metadata } from "next";

import { RequireAuth } from "@/components/auth/RequireAuth";
import { BusinessDetailsForm } from "@/components/billing/BusinessDetailsForm";

export const metadata: Metadata = {
  title: "Business details",
  robots: { index: false },
};

export default function BusinessDetailsPage() {
  return (
    <RequireAuth>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">
            Business details
          </h1>
          <p className="text-sm text-fg-muted">
            What your invoices show. Saving changes your next invoices, not the
            ones already sent.
          </p>
        </div>
        <BusinessDetailsForm />
      </div>
    </RequireAuth>
  );
}
