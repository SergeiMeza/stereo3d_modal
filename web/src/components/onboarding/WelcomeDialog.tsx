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
 * Shown once per account (onboarding.welcome_done, saved when it's
 * finished or closed; closing the tab mid-way shows it again). Desktop: a
 * centered dialog; phone and headset widths: full screen, shorter copy.
 * No Skip (owner 2026-11-07). No plans or paywall here.
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
import { SITE_NAME } from "@/lib/site";
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
import { useT } from "@/lib/i18n/I18nProvider";
import { rich } from "@/lib/i18n/rich";
import { EN, type Tr } from "@/lib/i18n/t";

import { proPct } from "@/components/plans/upsell";

/** The welcome's headset list, in the canvas's order, with the files each
 * one gets. Ids are Make 3D's device ids. name/files are the English
 * copy; on screen they read through welcomeDeviceName/welcomeDeviceFiles
 * (onboarding.devices.<id> in messages/en.json). */
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

/** The product name, kept English in every language. */
const PRO = "Pro";

/** A welcome device's name in the viewer's language. */
export function welcomeDeviceName(id: Device, t: Tr = EN): string {
  return t(`onboarding.devices.${id}.name`);
}

/** The files a welcome device gets, in the viewer's language. */
export function welcomeDeviceFiles(id: Device, t: Tr = EN): string {
  return t(`onboarding.devices.${id}.files`);
}

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

/** "7 Dec": the credit's use-by day (English keeps the day first). */
function creditUseBy(iso: string, t: Tr): string {
  return new Date(iso).toLocaleDateString(t.locale === "en" ? "en-GB" : t.intl, { day: "numeric", month: "short" });
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
  const t = useT();
  const parts = [
    pct
      ? t("onboarding.welcome.pro.pricesPct", { pct, pro: PRO })
      : t("onboarding.welcome.pro.prices", { pro: PRO }),
    previews
      ? t("onboarding.welcome.pro.previews", { count: previews.count, period: previews.period })
      : null,
    credit
      ? t("onboarding.welcome.pro.credit", {
          amount: formatCredit(credit.left_cents),
          date: creditUseBy(credit.expires_at, t),
        })
      : null,
    t("onboarding.welcome.pro.nothingBilled"),
  ];
  return <>{parts.filter((p) => p !== null).join(" ")}</>;
}

/** The mock's deep link to a welcome step (?welcomeStep=N, the iPhone Duo
 * screenshots): 1 outside the mock. */
function mockWelcomeStep(total: number): number {
  if (process.env.NEXT_PUBLIC_API_MOCK !== "1" || typeof window === "undefined") return 1;
  const n = Number(new URLSearchParams(window.location.search).get("welcomeStep"));
  return Number.isInteger(n) && n >= 1 && n <= total ? n : 1;
}

/** The three steps; copy at onboarding.welcome.how.steps.<id>. */
const HOW: readonly ("add" | "preview" | "make")[] = ["add", "preview", "make"];

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
  const t = useT();
  const gateway = useGateway();
  const billing = useBilling();
  const proStatus = useProStatus();
  const pricing = usePricing();
  const limits = useLimits();
  const { settings, update } = useAccountSettings();
  const steps = STEPS[variant];
  const total = steps.length;
  // the mock's screenshot deep link (?welcomeStep=2): never in a real build
  const [step, setStep] = useState(() => mockWelcomeStep(total));
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
        // owner 2026-11-07 (foldable): never taller or wider than the screen
        // you can see; the body scrolls, the footer stays (sheet-fit)
        className="sheet-fit flex w-full max-w-full min-w-0 flex-col gap-0 overflow-hidden rounded-none p-0 sm:max-w-[560px] sm:rounded-2xl"
      >
        <div
          data-testid="welcome-body"
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain break-words"
        >
        {/* owner 2026-11-07: no Skip; every new account goes through the
            welcome (closing the tab mid-way shows it again) */}
        <div className="pt-4 sm:hidden short:pt-2" />

        {kind === "pro" ? (
          <div className="flex flex-col" data-testid="welcome-app-pro">
            <div className="flex flex-col gap-1.5 px-5 pt-4 sm:px-9 sm:pt-8 short:gap-1 short:pt-3 sm:short:pt-5">
              <p className="text-[13px] font-medium text-primary">{t("onboarding.welcome.eyebrow")}</p>
              <DialogTitle className="text-2xl font-semibold tracking-tight sm:text-[28px] short:text-xl sm:short:text-2xl">
                {t("onboarding.welcome.pro.title", { pro: PRO })}
              </DialogTitle>
              <DialogDescription className="text-[15px] leading-normal text-fg-muted short:text-sm">
                <ProLines pct={pct} previews={previews} credit={proCredit} />
              </DialogDescription>
              <BusinessLine />
            </div>
          </div>
        ) : kind === "headsets" ? (
          <div className="flex flex-col">
            {appPro ? (
              <div
                className="flex flex-col gap-1.5 px-5 pt-4 sm:px-9 sm:pt-8 short:gap-1 short:pt-3 sm:short:pt-5"
                data-testid="welcome-app-pro"
              >
                <p className="text-[13px] font-medium text-primary">{t("onboarding.welcome.eyebrow")}</p>
                <DialogTitle className="text-2xl font-semibold tracking-tight sm:text-[28px] short:text-xl sm:short:text-2xl">
                  {t("onboarding.welcome.pro.title", { pro: PRO })}
                </DialogTitle>
                <DialogDescription className="text-[15px] leading-normal text-fg-muted short:text-sm">
                  <ProLines pct={pct} previews={previews} credit={proCredit} />
                </DialogDescription>
                <p className="pt-2 text-[15px] text-fg">
                  {t("onboarding.welcome.headsets.question")}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5 px-5 pt-4 sm:px-9 sm:pt-8 short:gap-1 short:pt-3 sm:short:pt-5">
                <p className="text-[13px] font-medium text-primary">{t("onboarding.welcome.eyebrow")}</p>
                <DialogTitle className="text-2xl font-semibold tracking-tight sm:text-[28px] short:text-xl sm:short:text-2xl">
                  {t("onboarding.welcome.headsets.title")}
                </DialogTitle>
                <DialogDescription className="text-[15px] leading-normal text-fg-muted short:text-sm">
                  <span className="hidden sm:inline">
                    {t("onboarding.welcome.headsets.intro", { site: SITE_NAME })}
                  </span>
                  <span className="sm:hidden">{t("onboarding.welcome.headsets.question")}</span>
                </DialogDescription>
              </div>
            )}
            <div
              role="group"
              aria-label={t("onboarding.welcome.headsets.question")}
              // two columns wherever two cards of 11rem fit (folded
              // phones, foldables, the dialog), one on narrow phones
              className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-2 px-5 pt-4 sm:gap-2.5 sm:px-9 sm:pt-5 short:gap-1.5 short:pt-3"
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
                    className={`flex min-h-11 min-w-0 items-center gap-2.5 rounded-[10px] border px-3 py-2 text-start transition-colors sm:min-h-14 sm:gap-3 sm:px-3.5 sm:py-2.5 short:min-h-10 short:py-1.5 sm:short:min-h-11 ${
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
                    <span className="flex min-w-0 flex-col items-start">
                      <span className="text-sm leading-snug text-fg sm:text-[15px] short:text-sm">{welcomeDeviceName(d.id, t)}</span>
                      <span className="text-[11px] leading-snug text-fg-muted sm:text-xs short:text-[11px]">
                        {welcomeDeviceFiles(d.id, t)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="px-5 pt-3 pb-4 text-[13px] text-fg-muted sm:px-9 short:pt-2 short:pb-3 short:text-xs">
              {appPro && picked === null && fromApp.length > 0
                ? t("onboarding.welcome.headsets.fromApp")
                : otherHeadset && picked === null
                  ? t("onboarding.welcome.headsets.otherHeadset")
                  : t("onboarding.welcome.headsets.note")}
            </p>
          </div>
        ) : kind === "how" ? (
          <div className="flex flex-col">
            <div
              data-testid="welcome-loop"
              className="relative aspect-[16/7] w-full shrink-0 overflow-hidden bg-black sm:h-[220px] sm:aspect-auto short:aspect-[16/5] sm:short:h-[150px] cramped:aspect-auto cramped:h-[22svh] sm:cramped:h-[22svh]"
            >
              <LoopVideo
                base="/landing/hero/sunset-session-2d-3d"
                label={t("onboarding.welcome.how.loopLabel")}
                className="absolute inset-0 h-full w-full object-cover"
              />
            </div>
            <div className="flex flex-col gap-1.5 px-5 pt-4 sm:px-9 sm:pt-6">
              <p className="text-[13px] font-medium text-primary">
                {t("onboarding.welcome.how.eyebrow")}
              </p>
              <DialogTitle className="text-2xl font-semibold tracking-tight sm:text-[26px] short:text-xl sm:short:text-2xl">
                <span className="hidden sm:inline">
                  {t("onboarding.welcome.how.title")}
                </span>
                <span className="sm:hidden">
                  {t("onboarding.welcome.how.titleShort")}
                </span>
              </DialogTitle>
              <DialogDescription className="sr-only">
                {t("onboarding.welcome.how.description", { site: SITE_NAME })}
              </DialogDescription>
            </div>
            <ol className="flex flex-col gap-4 px-5 pt-5 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-9 short:gap-3 short:pt-3">
              {HOW.map((h, i) => (
                <li key={h} className="flex flex-col gap-1">
                  <span className="font-mono text-xs text-primary">
                    {i + 1}
                  </span>
                  <span className="text-[15px] font-semibold text-fg">
                    {t(`onboarding.welcome.how.steps.${h}.title`)}
                  </span>
                  <span className="hidden text-[13px] leading-snug text-fg-muted sm:block">
                    {i === 0
                      ? `${sentenceCase(methodLimitText("lifelike", limits, pricing, t))}. `
                      : ""}
                    {t(`onboarding.welcome.how.steps.${h}.body`)}
                  </span>
                  <span className="text-[13px] leading-snug text-fg-muted sm:hidden">
                    {t(`onboarding.welcome.how.steps.${h}.short`)}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="flex flex-col gap-1.5 px-5 pt-4 sm:px-9 sm:pt-8 short:gap-1 short:pt-3 sm:short:pt-5">
              <p className="text-[13px] font-medium text-primary">
                {t("onboarding.welcome.project.eyebrow")}
              </p>
              <DialogTitle className="text-2xl font-semibold tracking-tight sm:text-[26px] short:text-xl sm:short:text-2xl">
                {t("onboarding.welcome.project.title")}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {t("onboarding.welcome.project.description")}
              </DialogDescription>
            </div>
            <div className="px-5 pt-5 sm:px-9">
              <UploadDropzone />
            </div>
            {sample ? (
              <div className="flex flex-col gap-2.5 px-5 pt-5 sm:px-9">
                <span className="text-sm text-fg-muted">
                  {t("onboarding.welcome.project.sample")}
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

          {/* a fade at the bottom while more is below (it sticks to the
              body's bottom edge; at the end it sits over empty space) */}
          <div aria-hidden data-testid="welcome-scroll-cue" className="pointer-events-none sticky bottom-0 h-6 bg-gradient-to-t from-popover to-transparent" />
        </div>
        {/* the buttons stay in view at the bottom, whatever the body's length */}
        <div
          data-testid="welcome-footer"
          className="flex shrink-0 items-center justify-between gap-3 border-t border-edge bg-popover px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-9 sm:pt-4 sm:pb-5 short:pt-2.5 short:pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        >
          <div
            className={`flex gap-1.5 ${total === 1 ? "invisible" : ""}`}
            aria-label={t("onboarding.welcome.stepOf", { step, total })}
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
            {total === 1 || step === 1 ? null : (
              <Button
                variant="ghost"
                onClick={() => setStep((s) => Math.max(1, s - 1))}
              >
                {t("onboarding.welcome.back")}
              </Button>
            )}
            {total === 1 ? (
              <Button data-testid="welcome-got-it" onClick={finish}>
                {t("onboarding.welcome.gotIt")}
              </Button>
            ) : step < total ? (
              <Button data-testid="welcome-next" onClick={next}>
                {t("onboarding.welcome.continue")}
              </Button>
            ) : (
              <Button
                data-testid="welcome-later"
                variant="outline"
                onClick={finish}
              >
                {t("onboarding.welcome.later")}
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
  const t = useT();
  const show = useBusinessMention();
  if (!show) return null;
  return (
    <p data-testid="welcome-business" className="text-[13px] text-fg-muted">
      {rich(
        t,
        "onboarding.welcome.business",
        {
          link: (c) => (
            <Link
              href="/plans"
              className="underline underline-offset-2 hover:text-fg"
            >
              {c}
            </Link>
          ),
        },
        { plan: "Business" },
      )}
    </p>
  );
}
