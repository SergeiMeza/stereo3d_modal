"use client";

/**
 * One look for every plan or upsell banner (owner 2026-11-05: "the
 * multiple design is weird for the inline cards"): the same surface,
 * border, padding and type, one primary action, at most one text link,
 * and the X in the same place.
 */

import { X } from "lucide-react";
import Link from "next/link";
import type { JSX, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/I18nProvider";

export const NUDGE_SURFACE = "rounded-lg border border-edge bg-surface-1 px-4 py-3 text-sm";

export function PlanNudge({
  testId,
  text,
  action,
  link,
  onDismiss,
}: {
  testId: string;
  text: ReactNode;
  /** the one primary action: a page, or a step on the spot */
  action: { label: string; href?: string; onClick?: () => void; testId?: string };
  link?: { label: string; href: string; onClick?: () => void };
  onDismiss: () => void;
}): JSX.Element {
  const t = useT();
  return (
    <div role="note" data-testid={testId} className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${NUDGE_SURFACE}`}>
      <p className="min-w-56 flex-1 text-fg">{text}</p>
      {action.href ? (
        <Button asChild size="sm">
          <Link href={action.href} data-testid={action.testId} onClick={action.onClick}>
            {action.label}
          </Link>
        </Button>
      ) : (
        <Button size="sm" data-testid={action.testId} onClick={action.onClick}>
          {action.label}
        </Button>
      )}
      {link ? (
        <Link href={link.href} onClick={link.onClick} className="text-primary hover:underline">
          {link.label}
        </Link>
      ) : null}
      <button
        type="button"
        aria-label={t("plans.nudge.dismiss")}
        data-testid={`${testId}-dismiss`}
        onClick={onDismiss}
        className="ml-auto shrink-0 rounded p-0.5 text-fg-muted hover:text-fg"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}
