/**
 * SignInScreen reads ?next= via useSearchParams, which Next requires behind
 * a Suspense boundary in a page; the fallback mirrors RequireAuth's copy.
 */

import { Suspense } from "react";

import SignInScreen from "@/components/auth/SignInScreen";

export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center py-24 text-fg-muted">
          Checking session…
        </div>
      }
    >
      <SignInScreen />
    </Suspense>
  );
}
