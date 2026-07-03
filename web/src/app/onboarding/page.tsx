import { Suspense } from "react";

import { RequireAuth } from "@/components/auth/RequireAuth";
import OnboardingScreen from "@/components/billing/OnboardingScreen";

// useSearchParams (the ?next= passthrough) requires a Suspense boundary
// under the app router's static prerender.
export default function OnboardingPage() {
  return (
    <RequireAuth>
      <Suspense fallback={null}>
        <OnboardingScreen />
      </Suspense>
    </RequireAuth>
  );
}
