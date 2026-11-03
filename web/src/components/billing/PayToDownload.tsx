"use client";

/**
 * S3D-35: while any payment is outstanding, every project's download
 * buttons read "Pay $X to download" — and View in 3D / play "Pay $X to
 * play", since playing the file is the same access — and lead to the
 * payment step instead of the file. UI only for now: the payment step is the Billing page until
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

/** The pay link that stands in for a download or play control. */
export function PayLink({
  cents,
  verb = "download",
  className,
}: {
  cents: number;
  verb?: "download" | "play";
  className?: string;
}): JSX.Element {
  return (
    <Link
      href={PAY_STEP_HREF}
      data-testid={verb === "play" ? "pay-to-play" : "pay-to-download"}
      className={className}
    >
      {payToDownload(cents, verb)}
    </Link>
  );
}

/** Renders `children` (the real link or player) unless a payment is
 * outstanding; then the pay link in its place, styled by `className`.
 * `verb` "play" for players; `hide` drops the player with no link (a
 * pay link for the same file is already beside it). */
export function DownloadGate({
  children,
  className,
  verb = "download",
  hide = false,
}: {
  children: ReactNode;
  className?: string;
  verb?: "download" | "play";
  hide?: boolean;
}): JSX.Element | null {
  const cents = useOutstandingCents();
  if (cents <= 0) return <>{children}</>;
  if (hide) return null;
  return <PayLink cents={cents} verb={verb} className={className} />;
}
