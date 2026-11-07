/**
 * SignInScreen reads ?next= via useSearchParams, which Next requires behind
 * a Suspense boundary in a page; the fallback mirrors RequireAuth's copy.
 */

import { Suspense } from "react";

import SignInScreen from "@/components/auth/SignInScreen";
import { getServerTr } from "@/lib/i18n/server";

export default async function SignInPage() {
  const t = await getServerTr();
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center py-24 text-fg-muted">
          {t("common.checkingSession")}
        </div>
      }
    >
      <SignInScreen />
    </Suspense>
  );
}
