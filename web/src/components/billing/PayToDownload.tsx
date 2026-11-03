"use client";

/**
 * S3D-35: while any payment is outstanding, every project's download
 * buttons read "Pay $X to download" and lead to the payment step instead
 * of the file. UI only for now: the payment step is the Billing page until
 * the pay sheet ships (billing work is on hold), then PAY_STEP_HREF goes.
 */

import Link from "next/link";
import type { JSX, ReactNode } from "react";

import { useBilling } from "@/lib/billing";
import { outstandingCents, payToDownload } from "@/lib/billingCopy";

export const PAY_STEP_HREF = "/account/billing";

/** Cents the account owes; 0 = downloads are open. */
export function useOutstandingCents(): number {
  const { status } = useBilling();
  return outstandingCents(status);
}

/** Renders `children` (the real download link) unless a payment is
 * outstanding; then the pay link in its place, styled by `className`. */
export function DownloadGate({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  const cents = useOutstandingCents();
  if (cents <= 0) return <>{children}</>;
  return (
    <Link href={PAY_STEP_HREF} data-testid="pay-to-download" className={className}>
      {payToDownload(cents)}
    </Link>
  );
}
