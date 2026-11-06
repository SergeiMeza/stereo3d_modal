"use client";

/**
 * The welcome after sign-up (owner-approved canvas "Spatial Video Studio
 * Onboarding Tour", 2026-11-04): three steps over the Projects page.
 *
 * 1. Where will you watch? Headsets, several allowed. The answer is saved on
 *    the account (settings.headsets), preselects "Where will you watch it?"
 *    on Make 3D, and is logged as our own event "onboarding_headsets" with
 *    the plan (the gateway adds whether they later convert).
 * 2. How it works: three steps, and the price before you pay, over the
 *    site hero's 2D → 3D loop (poster only under reduced motion).
 * 3. Your first project: the upload, or the finished sample.
 *
 * Shown once per account (onboarding.welcome_done). Desktop: a centered
 * dialog; phone and headset widths: full screen, shorter copy, Skip at the
 * top. No plans or paywall here.
 *
 * App Pro (owner 2026-11-04, onboarding.variant "app_pro"): people whose Pro
 * comes from the app get "Your Pro works here too" — Pro prices on every
 * video (the share from /v1/pricing), their plan's free previews when it
 * has them, "Nothing new is billed." — with the headset question prefilled
 * from the app, then the upload or the sample. Business is named once, as a
 * muted line in the last step. Headsets prefill only from the app's
 * answer ("avp"); "other_headset" preselects nothing and says so quietly. Someone who already had the web welcome
 * gets the Pro step alone. Shown once (onboarding.app_pro_welcome_done).
 */

import { creditAmount as formatCredit } from "@/lib/pro/plans";
import Link from "next/link";
import { useState } from "react";

import { welcomePicksAtom } from "@/components/onboarding/welcomeAtoms";
import { useBusinessMention } from "@/components/plans/TalkToUs";
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";
import type { JSX } from "react";

import { LoopVideo } from "@/components/landing/LoopVideo";
import { UploadDropzone } from "@/components/projects/UploadDropzone";
import { methodLimitText, sentenceCase } from "@/components/steps/methods";
import { useLimits } from "@/lib/api/useLimits";
import type { Device } from "@/components/steps/makeControls";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Project } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { usePricing } from "@/lib/api/usePricing";
import { billingUidAtom, useBilling } from "@/lib/billing";
import { useProStatus } from "@/lib/pro/usePro";
import type { ProStatus } from "@/lib/pro/usePro";
import { useAccountSettings } from "@/lib/useAccountSettings";

import { proPct } from "@/components/plans/upsell";

/** The welcome's headset list, in the canvas's order, with the files each
 * one gets. Ids are Make 3D's device ids. */
export const WELCOME_DEVICES: readonly {
  id: Device;
  name: string;
  files: string;
}[] = [
  { id: "avp", name: "Apple Vision Pro", files: "Spatial video" },
  { id: "quest", name: "Meta Quest", files: "Side by side" },
  { id: "galaxyxr", name: "Samsung Galaxy XR", files: "Side by side" },
  { id: "pico", name: "Pico", files: "Side by side" },
  { id: "steamframe", name: "Steam Frame", files: "Side by side" },
  { id: "glasses", name: "XR glasses", files: "Side by side" },
  { id: "tv", name: "3D TV or projector", files: "Side by side (half size)" },
  { id: "unsure", name: "Not sure yet", files: "We include both" },
];

/** The plan a person is on, for the onboarding event: business | studio |
 * pro | none. */
export function planOf(
  status: ReturnType<typeof useBilling>["status"],
  pro: boolean | null | undefined,
): string {
  if (status?.plan?.active) return status.plan.plan;
  return pro ? "pro" : "none";
}

/** Which welcome: the usual three steps; app Pro's two (Pro and headsets,
 * then the first project); or app Pro's one step for someone who already
 * had the web welcome. */
export type WelcomeVariant = "default" | "app_pro" | "app_pro_short";

type Step = "headsets" | "how" | "project" | "pro";

const STEPS: Record<WelcomeVariant, readonly Step[]> = {
  default: ["headsets", "how", "project"],
  app_pro: ["headsets", "project"],
  app_pro_short: ["pro"],
};

/** headsets_from_app as Make 3D device ids (gateway 00096 sends only
 * "avp"; anything else is dropped). */
export function appHeadsets(
  ids: readonly string[] | null | undefined,
): Device[] {
  const known = new Set<string>(WELCOME_DEVICES.map((d) => d.id));
  return [...new Set((ids ?? []).filter((id) => known.has(id)))] as Device[];
}

/** The free previews GET /v1/pro reports for the person's Pro (00096);
 * null when the plan has none. */
export function proPreviews(
  fp: ProStatus["free_previews"],
): { count: number; period: string } | null {
  const count = fp?.per_period ?? fp?.allowance;
  if (typeof count !== "number" || count <= 0) return null;
  return { count, period: fp?.period ?? "month" };
}

/** "7 Dec": the credit's use-by day. */
function creditUseBy(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "Pro prices on every video, 15% off. Your plan includes 20 free previews
 * a month. Nothing new is billed." */
function ProLines({
  pct,
  previews,
  credit,
}: {
  pct: number | null;
  previews: { count: number; period: string } | null;
  /** owner 2026-11-07: the usage credit this Pro was given, when granted */
  credit?: { left_cents: number; expires_at: string } | null;
}): JSX.Element {
  const when =
    previews?.period === "pass"
      ? "with your pass"
      : previews
        ? `a ${previews.period}`
        : "";
  return (
    <>
      {pct
        ? `Pro prices on every video, ${pct}% off.`
        : "Pro prices on every video."}
      {previews
        ? ` Your plan includes ${previews.count} free previews ${when}.`
        : ""}
      {credit
        ? ` You have ${formatCredit(credit.left_cents)} of usage credit to use by ${creditUseBy(credit.expires_at)}.`
        : ""}{" "}
      Nothing new is billed.
    </>
  );
}

const HOW: readonly { title: string; body: string; short: string }[] = [
  {
    title: "Add a video",
    // "Any length, up to 4K." comes first, from the gateway's limits
    body: "We look at every scene and show you the price. Free.",
    short: "See the price for free.",
  },
  {
    title: "Watch a preview",
    body: "See a short part in 3D in your headset. Your first preview is on us.",
    short: "Your first one is on us.",
  },
  {
    title: "Make it 3D",
    body: "Pay for the whole video, then download it or play it in your headset's browser.",
    short: "Download it or play it in your headset.",
  },
];

export function WelcomeDialog({
  open,
  sample,
  onClose,
  variant = "default",
}: {
  open: boolean;
  /** the account's sample project, when it has one */
  sample: Project | null;
  onClose: () => void;
  variant?: WelcomeVariant;
}): JSX.Element {
  const gateway = useGateway();
  const billing = useBilling();
  const proStatus = useProStatus();
  const pricing = usePricing();
  const limits = useLimits();
  const { settings, update } = useAccountSettings();
  const steps = STEPS[variant];
  const total = steps.length;
  const [step, setStep] = useState(1);
  const kind = steps[Math.min(step, total) - 1];
  const appPro = variant !== "default";
  // ADR 0138: the picks live in an atom, so a remount keeps them
  const uid = useAppAtomValue(billingUidAtom);
  const picks = useAppAtomValue(welcomePicksAtom);
  const setPicks = useAppSetAtom(welcomePicksAtom);
  const picked = picks.uid === uid ? picks.picked : null;
  const setPicked = (next: Device[] | null) => setPicks({ uid, picked: next });
  const saved = (settings?.headsets ?? []) as Device[];
  // app Pro: what the app knows, when the web has nothing yet
  const fromApp =
    appPro && saved.length === 0
      ? appHeadsets(settings?.onboarding?.headsets_from_app)
      : [];
  const chosen = picked ?? (saved.length > 0 ? saved : fromApp);
  const pct = proPct(pricing);
  const previews = proPreviews(proStatus?.free_previews);
  const pc = billing.status?.pro_credit;
  const proCredit = pc?.granted && pc.left_cents > 0 ? pc : null;
  // the app knows they use another headset, not which: nothing preselected
  const otherHeadset =
    appPro &&
    saved.length === 0 &&
    settings?.onboarding?.app_viewing_device === "other_headset";

  function toggle(id: Device): void {
    setPicked(
      chosen.includes(id) ? chosen.filter((d) => d !== id) : [...chosen, id],
    );
  }

  function saveHeadsets(): void {
    // app Pro: the prefilled answer counts when they go on without a change
    const devices = picked ?? (fromApp.length > 0 ? fromApp : null);
    if (devices === null || !steps.includes("headsets")) return;
    update({ headsets: devices });
    gateway.logEvent("onboarding_headsets", {
      devices,
      plan: planOf(billing.status, proStatus?.pro),
      source: "welcome",
      variant: appPro ? "app_pro" : "default",
    });
  }

  function finish(): void {
    saveHeadsets();
    update({
      onboarding:
        variant === "app_pro_short"
          ? { app_pro_welcome_done: true }
          : appPro
            ? { welcome_done: true, app_pro_welcome_done: true }
            : { welcome_done: true },
    });
    onClose();
  }

  const next = (): void => {
    if (kind === "headsets") saveHeadsets();
    setStep((s) => Math.min(total, s + 1));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : finish())}>
      <DialogContent
        data-testid="welcome"
        showCloseButton={false}
        className="flex h-dvh max-h-dvh w-full max-w-full flex-col gap-0 overflow-y-auto rounded-none p-0 sm:h-auto sm:max-h-[92dvh] sm:max-w-[560px] sm:rounded-2xl"
      >
        {/* phone: Skip at the top, as on the canvas */}
        <div className="flex items-center justify-end px-5 pt-4 sm:hidden">
          {step < total ? (
            <button
              type="button"
              onClick={() => setStep(total)}
              className="text-sm text-fg-muted hover:text-fg"
            >
              Skip
            </button>
          ) : null}
        </div>

        {kind === "pro" ? (
          <div className="flex flex-col" data-testid="welcome-app-pro">
            <div className="flex flex-col gap-1.5 px-5 pt-4 sm:px-9 sm:pt-8">
              <p className="text-[13px] font-medium text-primary">Welcome</p>
              <DialogTitle className="text-2xl font-semibold tracking-tight sm:text-[28px]">
                Your Pro works here too
              </DialogTitle>
              <DialogDescription className="text-[15px] leading-normal text-fg-muted">
                <ProLines pct={pct} previews={previews} credit={proCredit} />
              </DialogDescription>
              <BusinessLine />
            </div>
          </div>
        ) : kind === "headsets" ? (
          <div className="flex flex-col">
            {appPro ? (
              <div
                className="flex flex-col gap-1.5 px-5 pt-4 sm:px-9 sm:pt-8"
                data-testid="welcome-app-pro"
              >
                <p className="text-[13px] font-medium text-primary">Welcome</p>
                <DialogTitle className="text-2xl font-semibold tracking-tight sm:text-[28px]">
                  Your Pro works here too
                </DialogTitle>
                <DialogDescription className="text-[15px] leading-normal text-fg-muted">
                  <ProLines pct={pct} previews={previews} credit={proCredit} />
                </DialogDescription>
                <p className="pt-2 text-[15px] text-fg">
                  Where will you watch?
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5 px-5 pt-4 sm:px-9 sm:pt-8">
                <p className="text-[13px] font-medium text-primary">Welcome</p>
                <DialogTitle className="text-2xl font-semibold tracking-tight sm:text-[28px]">
                  Your videos, in 3D.
                </DialogTitle>
                <DialogDescription className="text-[15px] leading-normal text-fg-muted">
                  <span className="hidden sm:inline">
                    Spatial Video Studio turns any 2D video into 3D you can
                    watch in your headset. First, where will you watch?
                  </span>
                  <span className="sm:hidden">Where will you watch?</span>
                </DialogDescription>
              </div>
            )}
            <div
              role="group"
              aria-label="Where will you watch?"
              className="grid grid-cols-1 gap-2.5 px-5 pt-5 sm:grid-cols-2 sm:px-9"
            >
              {WELCOME_DEVICES.map((d) => {
                const on = chosen.includes(d.id);
                return (
                  <button
                    key={d.id}
                    type="button"
                    aria-pressed={on}
                    data-testid={`welcome-device-${d.id}`}
                    onClick={() => toggle(d.id)}
                    className={`flex min-h-12 items-center gap-3 rounded-[10px] border px-3.5 py-2.5 text-left transition-colors sm:min-h-14 ${
                      on
                        ? "border-primary bg-primary/10"
                        : "border-edge bg-surface-2 hover:border-fg-muted"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`flex size-5 shrink-0 items-center justify-center rounded-[5px] border text-[13px] text-white ${
                        on ? "border-primary bg-primary" : "border-edge"
                      }`}
                    >
                      {on ? "✓" : ""}
                    </span>
                    <span className="flex flex-col items-start gap-0.5">
                      <span className="text-[15px] text-fg">{d.name}</span>
                      <span className="hidden text-xs text-fg-muted sm:block">
                        {d.files}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="px-5 pt-3 text-[13px] text-fg-muted sm:px-9">
              {appPro && picked === null && fromApp.length > 0
                ? "From your app. We use this to pick the right files for you. You can change it on any project."
                : otherHeadset && picked === null
                  ? "You told the app you use a headset. We use this to pick the right files for you."
                  : "We use this to pick the right files for you. You can change it on any project."}
            </p>
          </div>
        ) : kind === "how" ? (
          <div className="flex flex-col">
            <div
              data-testid="welcome-loop"
              className="relative aspect-[16/7] w-full overflow-hidden bg-black sm:h-[220px] sm:aspect-auto"
            >
              <LoopVideo
                base="/landing/hero/sunset-session-2d-3d"
                label="A singer in front of her band at sunset: on the left the 2D video, on the right the same moment in 3D"
                className="absolute inset-0 h-full w-full object-cover"
              />
            </div>
            <div className="flex flex-col gap-1.5 px-5 pt-4 sm:px-9 sm:pt-6">
              <p className="text-[13px] font-medium text-primary">
                How it works
              </p>
              <DialogTitle className="text-2xl font-semibold tracking-tight sm:text-[26px]">
                <span className="hidden sm:inline">
                  Three steps. You see the price before you pay.
                </span>
                <span className="sm:hidden">
                  You see the price before you pay.
                </span>
              </DialogTitle>
              <DialogDescription className="sr-only">
                How Spatial Video Studio works
              </DialogDescription>
            </div>
            <ol className="flex flex-col gap-4 px-5 pt-5 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-9">
              {HOW.map((h, i) => (
                <li key={h.title} className="flex flex-col gap-1">
                  <span className="font-mono text-xs text-primary">
                    {i + 1}
                  </span>
                  <span className="text-[15px] font-semibold text-fg">
                    {h.title}
                  </span>
                  <span className="hidden text-[13px] leading-snug text-fg-muted sm:block">
                    {i === 0
                      ? `${sentenceCase(methodLimitText("lifelike", limits, pricing))}. `
                      : ""}
                    {h.body}
                  </span>
                  <span className="text-[13px] leading-snug text-fg-muted sm:hidden">
                    {h.short}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="flex flex-col gap-1.5 px-5 pt-4 sm:px-9 sm:pt-8">
              <p className="text-[13px] font-medium text-primary">
                Your first project
              </p>
              <DialogTitle className="text-2xl font-semibold tracking-tight sm:text-[26px]">
                Start with one of your videos.
              </DialogTitle>
              <DialogDescription className="sr-only">
                Add a video or open the sample
              </DialogDescription>
            </div>
            <div className="px-5 pt-5 sm:px-9">
              <UploadDropzone />
            </div>
            {sample ? (
              <div className="flex flex-col gap-2.5 px-5 pt-5 sm:px-9">
                <span className="text-sm text-fg-muted">
                  No video to hand? Open a finished sample and look around
                  first.
                </span>
                <Link
                  href={`/projects/${sample.project_id}`}
                  onClick={finish}
                  data-testid="welcome-sample"
                  className="flex w-full items-center gap-3 rounded-lg border border-edge bg-surface-2 p-2 text-fg transition-colors hover:border-fg-muted sm:w-1/2"
                >
                  {sample.scene_thumbs?.[0]?.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={sample.scene_thumbs[0].url}
                      alt=""
                      className="h-14 w-24 shrink-0 rounded-md object-cover"
                    />
                  ) : null}
                  <span className="text-[13px]">{sample.name}</span>
                </Link>
              </div>
            ) : null}
            {appPro ? (
              <div className="px-5 pt-5 sm:px-9">
                <BusinessLine />
              </div>
            ) : null}
          </div>
        )}

        {/* phone: the buttons stay in reach at the bottom */}
        <div className="sticky bottom-0 mt-auto flex items-center justify-between gap-3 border-t border-edge bg-popover px-5 pt-4 pb-5 sm:static sm:mt-0 sm:border-t-0 sm:px-9 sm:pt-6 sm:pb-7">
          <div
            className={`flex gap-1.5 ${total === 1 ? "invisible" : ""}`}
            aria-label={`Step ${step} of ${total}`}
          >
            {steps
              .map((_, i) => i + 1)
              .map((n) => (
                <span
                  key={n}
                  aria-hidden
                  className={`block h-2 rounded-full ${n === step ? "w-[22px] bg-primary" : "w-2 bg-edge"}`}
                />
              ))}
          </div>
          <div className="flex items-center gap-2">
            {total === 1 ? null : step === 1 ? (
              <Button
                variant="ghost"
                className="hidden sm:inline-flex"
                onClick={() => setStep(total)}
              >
                Skip
              </Button>
            ) : (
              <Button
                variant="ghost"
                onClick={() => setStep((s) => Math.max(1, s - 1))}
              >
                Back
              </Button>
            )}
            {total === 1 ? (
              <Button data-testid="welcome-got-it" onClick={finish}>
                Got it
              </Button>
            ) : step < total ? (
              <Button data-testid="welcome-next" onClick={next}>
                Continue
              </Button>
            ) : (
              <Button
                data-testid="welcome-later"
                variant="outline"
                onClick={finish}
              >
                I&apos;ll do it later
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** App Pro's one mention of Business: a muted line in the last step;
 * never for Business or Studio (owner 2026-11-05: the same rule as the
 * Projects nudge, useBusinessMention). */
function BusinessLine(): JSX.Element | null {
  const show = useBusinessMention();
  if (!show) return null;
  return (
    <p data-testid="welcome-business" className="text-[13px] text-fg-muted">
      Working for clients?{" "}
      <Link
        href="/plans"
        className="underline underline-offset-2 hover:text-fg"
      >
        Business
      </Link>{" "}
      adds monthly usage, commercial use and invoices.
    </p>
  );
}
