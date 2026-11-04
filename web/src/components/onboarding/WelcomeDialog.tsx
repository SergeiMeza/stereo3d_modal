"use client";

/**
 * The welcome after sign-up (owner-approved canvas "Spatial Video Studio
 * Onboarding Tour", 2026-11-04): three steps over the Projects page.
 *
 * 1. Where will you watch? Headsets, several allowed. The answer is saved on
 *    the account (settings.headsets), preselects "Where will you watch it?"
 *    on Make 3D, and is logged as our own event "onboarding_headsets" with
 *    the plan (the gateway adds whether they later convert).
 * 2. How it works: three steps, you only pay at the end.
 * 3. Your first project: the upload, or the finished sample.
 *
 * Shown once per account (onboarding.welcome_done). Desktop: a centered
 * dialog; phone and headset widths: full screen, shorter copy, Skip at the
 * top. No plans or paywall here.
 */

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import type { JSX } from "react";

import { UploadDropzone } from "@/components/projects/UploadDropzone";
import type { Device } from "@/components/steps/makeControls";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { Project } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useBilling } from "@/lib/billing";
import { useProStatus } from "@/lib/pro/usePro";
import { useAccountSettings } from "@/lib/useAccountSettings";

/** The welcome's headset list, in the canvas's order, with the files each
 * one gets. Ids are Make 3D's device ids. */
export const WELCOME_DEVICES: readonly { id: Device; name: string; files: string }[] = [
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
export function planOf(status: ReturnType<typeof useBilling>["status"], pro: boolean | null | undefined): string {
  if (status?.plan?.active) return status.plan.plan;
  return pro ? "pro" : "none";
}

const HOW: readonly { title: string; body: string; short: string }[] = [
  {
    title: "Add a video",
    body: "Any length, up to 8K. We look at every scene and show you the price. Free.",
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
}: {
  open: boolean;
  /** the account's sample project, when it has one */
  sample: Project | null;
  onClose: () => void;
}): JSX.Element {
  const gateway = useGateway();
  const billing = useBilling();
  const proStatus = useProStatus();
  const { settings, update } = useAccountSettings();
  const [step, setStep] = useState(1);
  const [picked, setPicked] = useState<Device[] | null>(null);
  const chosen = picked ?? ((settings?.headsets ?? []) as Device[]);

  function toggle(id: Device): void {
    setPicked(chosen.includes(id) ? chosen.filter((d) => d !== id) : [...chosen, id]);
  }

  function saveHeadsets(): void {
    if (picked === null) return;
    update({ headsets: picked });
    gateway.logEvent("onboarding_headsets", {
      devices: picked,
      plan: planOf(billing.status, proStatus?.pro),
      source: "welcome",
    });
  }

  function finish(): void {
    saveHeadsets();
    update({ onboarding: { welcome_done: true } });
    onClose();
  }

  const next = (): void => {
    if (step === 1) saveHeadsets();
    setStep((s) => Math.min(3, s + 1));
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
          {step < 3 ? (
            <button type="button" onClick={() => setStep(3)} className="text-sm text-fg-muted hover:text-fg">
              Skip
            </button>
          ) : null}
        </div>

        {step === 1 ? (
          <div className="flex flex-col">
            <div className="flex flex-col gap-1.5 px-5 pt-4 sm:px-9 sm:pt-8">
              <p className="text-[13px] font-medium text-primary">Welcome</p>
              <DialogTitle className="text-2xl font-semibold tracking-tight sm:text-[28px]">
                Your videos, in 3D.
              </DialogTitle>
              <DialogDescription className="text-[15px] leading-normal text-fg-muted">
                <span className="hidden sm:inline">
                  Spatial Video Studio turns any 2D video into 3D you can watch in your headset.
                  First, where will you watch?
                </span>
                <span className="sm:hidden">Where will you watch?</span>
              </DialogDescription>
            </div>
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
                      on ? "border-primary bg-primary/10" : "border-edge bg-surface-2 hover:border-fg-muted"
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
                      <span className="hidden text-xs text-fg-muted sm:block">{d.files}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="px-5 pt-3 text-[13px] text-fg-muted sm:px-9">
              We use this to pick the right files for you. You can change it on any project.
            </p>
          </div>
        ) : step === 2 ? (
          <div className="flex flex-col">
            <Image
              src="/landing/hero/sunset-session-2d-3d.jpg"
              alt="A singer in front of her band at sunset: the left half in 2D, the right half in 3D"
              width={1120}
              height={440}
              className="hidden h-[220px] w-full object-cover sm:block"
            />
            <div className="flex flex-col gap-1.5 px-5 pt-4 sm:px-9 sm:pt-6">
              <p className="text-[13px] font-medium text-primary">How it works</p>
              <DialogTitle className="text-2xl font-semibold tracking-tight sm:text-[26px]">
                <span className="hidden sm:inline">Three steps, and you only pay at the end.</span>
                <span className="sm:hidden">You only pay at the end.</span>
              </DialogTitle>
              <DialogDescription className="sr-only">How Spatial Video Studio works</DialogDescription>
            </div>
            <ol className="flex flex-col gap-4 px-5 pt-5 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-9">
              {HOW.map((h, i) => (
                <li key={h.title} className="flex flex-col gap-1">
                  <span className="font-mono text-xs text-primary">{i + 1}</span>
                  <span className="text-[15px] font-semibold text-fg">{h.title}</span>
                  <span className="hidden text-[13px] leading-snug text-fg-muted sm:block">{h.body}</span>
                  <span className="text-[13px] leading-snug text-fg-muted sm:hidden">{h.short}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="flex flex-col gap-1.5 px-5 pt-4 sm:px-9 sm:pt-8">
              <p className="text-[13px] font-medium text-primary">Your first project</p>
              <DialogTitle className="text-2xl font-semibold tracking-tight sm:text-[26px]">
                Start with one of your videos.
              </DialogTitle>
              <DialogDescription className="sr-only">Add a video or open the sample</DialogDescription>
            </div>
            <div className="px-5 pt-5 sm:px-9">
              <UploadDropzone />
            </div>
            {sample ? (
              <div className="flex flex-col gap-2.5 px-5 pt-5 sm:px-9">
                <span className="text-sm text-fg-muted">
                  No video to hand? Open a finished sample and look around first.
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
          </div>
        )}

        {/* phone: the buttons stay in reach at the bottom */}
        <div className="sticky bottom-0 mt-auto flex items-center justify-between gap-3 border-t border-edge bg-popover px-5 pt-4 pb-5 sm:static sm:mt-0 sm:border-t-0 sm:px-9 sm:pt-6 sm:pb-7">
          <div className="flex gap-1.5" aria-label={`Step ${step} of 3`}>
            {[1, 2, 3].map((n) => (
              <span
                key={n}
                aria-hidden
                className={`block h-2 rounded-full ${n === step ? "w-[22px] bg-primary" : "w-2 bg-edge"}`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {step === 1 ? (
              <Button variant="ghost" className="hidden sm:inline-flex" onClick={() => setStep(3)}>
                Skip
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setStep((s) => Math.max(1, s - 1))}>
                Back
              </Button>
            )}
            {step < 3 ? (
              <Button data-testid="welcome-next" onClick={next}>
                Continue
              </Button>
            ) : (
              <Button data-testid="welcome-later" variant="outline" onClick={finish}>
                I&apos;ll do it later
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
