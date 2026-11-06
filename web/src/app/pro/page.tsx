/**
 * /pro — Spatial Video Studio Pro on the web (S3D-68). Signed in only: the
 * purchase belongs to the account. ProScreen reads ?next= (useSearchParams),
 * so it sits behind Suspense.
 */

import type { Metadata } from "next";
import { Suspense } from "react";

import { RequireAuth } from "@/components/auth/RequireAuth";
import { ProScreen } from "@/components/pro/ProScreen";

export const metadata: Metadata = {
  title: "Pro",
  description:
    "Spatial Video Studio Pro: lower prices on every 3D video on the web, usage credit when you join, free previews, and Pro in the app on iPhone, iPad, Mac and Vision Pro.",
  alternates: { canonical: "/pro" },
};

export default function ProPage() {
  return (
    <RequireAuth>
      <Suspense fallback={null}>
        <ProScreen />
      </Suspense>
    </RequireAuth>
  );
}
