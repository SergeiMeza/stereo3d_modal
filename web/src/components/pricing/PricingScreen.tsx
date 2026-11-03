"use client";

/**
 * /pricing — public, concise, reference-only (S3D-18, S3D-45): Lifelike
 * 3D only (S3D-01: new projects are Lifelike), "from $X a minute", one
 * compact table with the size per eye for the qualities the gateway
 * enables, the
 * preview's "from" price, one charging line and a "How pricing works"
 * popover. Every number comes from GET /v1/pricing.
 */

import Link from "next/link";
import type { JSX } from "react";

import { methodLimitText, sentenceCase } from "@/components/steps/methods";
import { formatCents, formatCentsShort } from "@/components/steps/money";
import { Badge } from "@/components/ui/badge";
import { InfoPopover } from "@/components/ui/info-popover";
import type { Method, Preset, PublicPricing } from "@/lib/api/types";
import { usePricing } from "@/lib/api/usePricing";
import { useAuth } from "@/lib/auth";
import { CHARGED_AFTER } from "@/lib/billingCopy";
import { QUALITY_SHORT_SIDE, qualityName } from "@/lib/glossary";

/** Per-eye size of a quality for a 16:9 video. */
function size169(p: Preset): string {
  const h = QUALITY_SHORT_SIDE[p];
  const w = Math.round((h * 16) / 9 / 2) * 2;
  return `${w}×${h} per eye`;
}


function MethodPrices({
  pricing,
  method,
}: {
  pricing: PublicPricing;
  method: Method;
}): JSX.Element | null {
  const m = pricing.methods[method];
  if (!m) return null;
  const rows = m.presets.filter(
    (p) => typeof m.production_cents_per_minute[p] === "number",
  );
  const from = Math.min(...rows.map((p) => m.production_cents_per_minute[p]!));
  return (
    <section
      data-testid={`pricing-${method}`}
      className="flex flex-col rounded-xl border border-edge bg-card p-6"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">
          {method === "lifelike" ? "Lifelike 3D" : "Classic 3D"}
        </h2>
        {method === "lifelike" ? (
          <span className="ll-tag-new">New</span>
        ) : (
          <Badge variant="outline" className="text-fg-muted">
            Older method
          </Badge>
        )}
      </div>
      <p className="mt-2 text-2xl font-semibold">
        from {formatCentsShort(from)}{" "}
        <span className="text-sm font-normal text-fg-muted">a minute</span>
      </p>
      <table className="mt-3 w-full text-sm">
        <tbody>
          {rows.map((p) => (
            <tr key={p} className="border-t border-edge">
              <td className="py-2">
                {qualityName(p)}
                <span className="ml-2 font-mono text-[11px] text-fg-muted">
                  {size169(p)}
                </span>
              </td>
              <td className="py-2 text-right font-mono">
                {formatCents(m.production_cents_per_minute[p]!)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-fg-muted">
        {sentenceCase(methodLimitText(method, null, pricing))} · previews from{" "}
        {formatCentsShort(pricing.preview_minimum_cents ?? pricing.minimum_cents)}
      </p>
    </section>
  );
}

export function PricingScreen(): JSX.Element {
  const pricing = usePricing();
  const { user } = useAuth();
  const pct = pricing ? Math.round(pricing.discount.pct * 100) : null;
  return (
    <section className="mx-auto w-full max-w-4xl px-4 py-10">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Prices</h1>
        <p className="mt-2 text-fg-muted">Pay per video. No subscription.</p>
      </div>
      {pricing === null ? (
        <p className="mt-10 text-center text-fg-muted">Loading prices…</p>
      ) : (
        <>
          {/* S3D-01: new projects are Lifelike; Classic's prices live on
              its existing projects' own pages */}
          <div className="mx-auto mt-8 max-w-md">
            <MethodPrices pricing={pricing} method="lifelike" />
          </div>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-2 text-center">
            <p data-testid="pricing-charge-line" className="text-fg-muted">
              {CHARGED_AFTER} Runs over{" "}
              {formatCentsShort(pricing.precharge_threshold_cents)} are charged
              when they start and refunded if they fail.
            </p>
            <InfoPopover label="How pricing works">
              <span>
                <b>Per minute of video at {pricing.fps.base} fps.</b> 30 fps
                costs 25% more, 60 fps {pricing.fps.max_factor} times as much.
                Make only part of a video and pay only for that part.
              </span>
              <span>
                <b>{pct}% off</b> any run over{" "}
                {formatCentsShort(pricing.discount.threshold_cents)}.{" "}
                <b>Minimum charge</b>{" "}
                {formatCentsShort(pricing.preview_minimum_cents ?? pricing.minimum_cents)} per
                preview, {formatCentsShort(pricing.minimum_cents)} for other runs.
              </span>
              <span>
                <b>Over {formatCentsShort(pricing.precharge_threshold_cents)}:</b>{" "}
                charged when it starts. Cancel while it waits in line, or in
                its first minute, for a full refund. Refunded in full if it
                fails.
              </span>
              <span>
                <b>
                  {formatCentsShort(pricing.precharge_threshold_cents)} or less:
                </b>{" "}
                charged after it&apos;s done. Failed or cancelled runs are not
                charged.
              </span>
              <span>US dollars, excluding tax. Every file type is included.</span>
            </InfoPopover>
          </div>
        </>
      )}
      <div className="mt-8 flex justify-center">
        <Link
          href={user ? "/projects" : "/signin"}
          className="rounded-lg bg-primary px-6 py-3 font-medium text-primary-foreground hover:bg-primary/80"
        >
          Start a project
        </Link>
      </div>
    </section>
  );
}
