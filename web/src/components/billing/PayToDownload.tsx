"use client";

/**
 * S3D-35: while any payment is outstanding, every project's download
 * buttons read "Pay $X to download" — and View in 3D / play "Pay $X to
 * play", since playing the file is the same access — and lead to the
 * payment step instead of the file: the settle sheet (P2, spec v6 P9).
 */

import { LockIcon, PlayIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { useSettle } from "@/components/pay/SettleSheet";
import { useBilling } from "@/lib/billing";
import { outstandingCents, payToDownload } from "@/lib/billingCopy";

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
  const { openSettle } = useSettle();
  const Icon = verb === "play" ? PlayIcon : LockIcon;
  // one look everywhere (mock P9); only the caller's margins carry over
  const margins = (className ?? "")
    .split(/\s+/)
    .filter((c) => /^-?m[lrxytb]?-/.test(c))
    .join(" ");
  return (
    <button
      type="button"
      onClick={() => openSettle()}
      data-testid={verb === "play" ? "pay-to-play" : "pay-to-download"}
      className={`inline-flex items-center gap-1.5 rounded-md border border-red-400/40 bg-red-400/10 px-2.5 py-1 text-xs font-medium whitespace-nowrap text-red-200 tabular-nums transition-colors hover:bg-red-400/20 ${margins}`}
    >
      <Icon className="size-3.5" aria-hidden />
      {payToDownload(cents, verb)}
    </button>
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
