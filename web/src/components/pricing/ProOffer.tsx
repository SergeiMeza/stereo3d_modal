"use client";

/**
 * S3D-67: Pro members save on full runs. A member's quote carries one
 * compact "Pro −20%" line (QuoteView, from the quote's `pro_discount`);
 * for everyone else a single quiet link, "Pro members save 20%", opens this
 * small sheet: what Pro is and Get Pro. The share comes from GET
 * /v1/pricing `pro_discount` and shows only on the step it applies to
 * (previews are never discounted); without it nothing shows.
 */

import Link from "next/link";
import { useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Step } from "@/lib/api/types";
import { usePricing } from "@/lib/api/usePricing";
import { useProOffer } from "@/lib/pro/usePro";

/** The Pro page (built by the sign-in/Pro work); the sheet's one action. */
export const PRO_PAGE_HREF = "/pro";

/** A share (0.2) as a whole percent: 20. */
export function proPercent(pct: number): number {
  return Math.round(pct * 100);
}

/** "Pro members save 20%". */
export function proSaveLine(pct: number): string {
  return `Pro members save ${proPercent(pct)}%`;
}

/** The quiet link under a non-member's price for `step`, with its sheet. */
export function ProSaveLink({ step }: { step: Step }): JSX.Element | null {
  const pro = usePricing()?.pro_discount;
  const [open, setOpen] = useState(false);
  if (!pro || pro.pct <= 0 || pro.applies_to !== step) return null;
  return (
    <>
      <button
        type="button"
        data-testid="pro-save-link"
        onClick={() => setOpen(true)}
        className="-mt-1 mb-1.5 ml-auto w-fit text-xs text-fg-muted underline decoration-dotted underline-offset-4 transition-colors hover:text-fg"
      >
        {proSaveLine(pro.pct)}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="pro-sheet" className="gap-5 sm:max-w-xs">
          <DialogHeader className="gap-1.5">
            <span className="ll-eyebrow">Pro</span>
            <DialogTitle className="text-xl leading-tight">
              {proPercent(pro.pct)}% off every 3D video
            </DialogTitle>
            <DialogDescription>
              One membership for the web and the Spatial Video Studio apps.
            </DialogDescription>
            {open ? <ProPriceLine /> : null}
          </DialogHeader>
          <Button asChild size="lg" className="w-full">
            <Link href={PRO_PAGE_HREF} data-testid="pro-sheet-get">
              Get Pro
            </Link>
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The Pro price in one line (the Pro page's anchor plan); nothing until
 * the plans load. Mounted only while the sheet is open. */
function ProPriceLine(): JSX.Element | null {
  const offer = useProOffer();
  if (!offer) return null;
  return (
    <p data-testid="pro-sheet-price" className="text-sm text-fg tabular-nums">
      {offer.line}
    </p>
  );
}
