/**
 * /reset-password?oob=… — the link in the password-reset email the gateway
 * sends to China-mode users. ResetPasswordScreen reads ?oob= via
 * useSearchParams, which Next requires behind a Suspense boundary.
 * no-referrer keeps the code out of any request the page makes.
 */

import type { Metadata } from "next";
import { Suspense } from "react";

import ResetPasswordScreen from "@/components/auth/ResetPasswordScreen";

export const metadata: Metadata = {
  title: "Choose a new password",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center py-24 text-fg-muted">
          Loading…
        </div>
      }
    >
      <ResetPasswordScreen />
    </Suspense>
  );
}
