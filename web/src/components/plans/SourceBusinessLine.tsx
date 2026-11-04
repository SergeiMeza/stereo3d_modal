"use client";

/**
 * High-end sources (owner 2026-11-04): guide, never gate. Once the video
 * is analysed, one quiet line under the project's source facts:
 * "Working in 8K? Business and Studio save 20–25% and include commercial
 * use. See Business" (the size word from the source, the shares from
 * /v1/pricing), or for a source above 30 fps "High frame rates come with
 * Business and Studio, which also save 20–25%." Not for Business or Studio
 * subscribers; dismissed once per project.
 */

import { X } from "lucide-react";
import Link from "next/link";
import type { JSX } from "react";

import type { Project } from "@/lib/api/types";
import { usePricing } from "@/lib/api/usePricing";

import {
  businessSaveRange,
  sourceReason,
  sourceSizeWord,
  usePaywallEvents,
  usePlanTier,
  useProjectDismissal,
  useViewEvent,
} from "./upsell";

export function SourceBusinessLine({
  project,
}: {
  project: Project;
}): JSX.Element | null {
  const tier = usePlanTier();
  const range = businessSaveRange(usePricing());
  const { dismissed, dismiss } = useProjectDismissal(project.project_id);
  const probe =
    project.analyze.state === "succeeded" ? project.probe : undefined;
  const reason = sourceReason(probe);
  const show =
    (tier === "none" || tier === "pro") &&
    !dismissed &&
    reason !== null &&
    range !== null &&
    project.sample !== true;
  const base = { variant: "source_line", ...(reason ? { reason } : {}) };
  useViewEvent("business_note", tier, show, base);
  const send = usePaywallEvents("business_note", tier, base);
  if (!show || !probe || !range) return null;
  return (
    <p
      data-testid="source-business-line"
      className="flex items-center gap-2 border-b border-edge bg-surface-1 px-4 py-1.5 text-xs text-fg-muted"
    >
      <span className="flex-1">
        {reason === "source_fps"
          ? `High frame rates come with Business and Studio, which also save ${range}.`
          : `Working in ${sourceSizeWord(probe)}? Business and Studio save ${range} and include commercial use.`}{" "}
        <Link
          href="/plans"
          onClick={() => send("click", { target: "/plans" })}
          className="text-primary hover:underline"
        >
          See Business
        </Link>
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          send("dismiss");
          dismiss();
        }}
        className="rounded p-0.5 hover:text-fg"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </p>
  );
}
