"use client";

import Link from "next/link";
import type { JSX } from "react";

import { usePricing } from "@/lib/api/usePricing";
import { FirstTimeHint } from "@/components/onboarding/FirstTimeHint";

import { PlansSection } from "./PlansSection";

/** /plans: the two plan cards and a way back to the per-minute prices. */
export function PlansScreen(): JSX.Element {
  const pricing = usePricing();
  return (
    <section className="mx-auto w-full max-w-3xl px-4 py-10">
      <FirstTimeHint id="plans" className="mb-6" />
      {pricing === null ? (
        <p className="mt-10 text-center text-fg-muted">Loading plans…</p>
      ) : pricing.plans ? (
        <PlansSection pricing={pricing} />
      ) : (
        <p className="mt-10 text-center text-fg-muted">Plans aren&apos;t available yet.</p>
      )}
      <p className="mt-8 text-center text-sm">
        <Link href="/pricing" className="text-primary hover:underline">
          Prices per minute
        </Link>
      </p>
    </section>
  );
}
