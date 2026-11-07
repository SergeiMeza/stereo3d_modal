import type { Metadata } from "next";

import { RequireAuth } from "@/components/auth/RequireAuth";
import { BusinessDetailsForm } from "@/components/billing/BusinessDetailsForm";
import { getServerTr } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerTr();
  return {
    title: t("meta.businessDetails.title"),
    robots: { index: false },
  };
}

export default async function BusinessDetailsPage() {
  const t = await getServerTr();
  return (
    <RequireAuth>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {t("meta.businessDetails.heading")}
          </h1>
          <p className="text-sm text-fg-muted">
            {t("meta.businessDetails.intro")}
          </p>
        </div>
        <BusinessDetailsForm />
      </div>
    </RequireAuth>
  );
}
