"use client";

/**
 * "Get started" on Projects (owner-approved canvas, 2026-11-04): five
 * steps with progress and Hide. Done states come from the account: the
 * headset answer (settings.headsets) and the gateway's onboarding.steps
 * (first video, first preview, first 3D, watched); Hide is saved on the
 * account (onboarding.checklist_hidden). The list disappears once all
 * five are done.
 */

import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import type { AccountSettings } from "@/lib/api/types";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";
import { useAccountSettings } from "@/lib/useAccountSettings";

import { WELCOME_DEVICES, welcomeDeviceName } from "./WelcomeDialog";

interface Step {
  id: string;
  title: string;
  body: string;
  done: boolean;
  /** what a done step shows (the picked headsets) */
  doneText?: string;
}

export function checklistSteps(s: AccountSettings, t: Tr = EN): Step[] {
  const steps = s.onboarding?.steps ?? {};
  const names = (s.headsets ?? [])
    .map((id) => WELCOME_DEVICES.find((d) => d.id === id))
    .filter((d): d is (typeof WELCOME_DEVICES)[number] => !!d)
    .map((d) => welcomeDeviceName(d.id, t));
  return [
    {
      id: "headset",
      title: t("onboarding.getStarted.steps.headset.title"),
      body: t("onboarding.getStarted.steps.headset.body"),
      done: names.length > 0,
      doneText: names.join(t("onboarding.getStarted.listSeparator")),
    },
    {
      id: "first_video",
      title: t("onboarding.getStarted.steps.firstVideo.title"),
      body: t("onboarding.getStarted.steps.firstVideo.body"),
      done: steps.first_video === true,
    },
    {
      id: "first_preview",
      title: t("onboarding.getStarted.steps.firstPreview.title"),
      body: t("onboarding.getStarted.steps.firstPreview.body"),
      done: steps.first_preview === true,
    },
    {
      id: "first_3d",
      title: t("onboarding.getStarted.steps.first3d.title"),
      body: t("onboarding.getStarted.steps.first3d.body"),
      done: steps.first_3d === true,
    },
    {
      id: "watched",
      title: t("onboarding.getStarted.steps.watched.title"),
      body: t("onboarding.getStarted.steps.watched.body"),
      done: steps.watched === true,
    },
  ];
}

export function GetStarted({ onPickHeadset }: { onPickHeadset: () => void }): JSX.Element | null {
  const t = useT();
  const { settings, update } = useAccountSettings();
  if (!settings || settings.onboarding?.checklist_hidden) return null;
  const steps = checklistSteps(settings, t);
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  const nextId = steps.find((s) => !s.done)?.id;
  return (
    <section
      data-testid="get-started"
      aria-labelledby="get-started-title"
      className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-1 p-4 sm:p-5"
    >
      <div className="flex items-center gap-3">
        <h2 id="get-started-title" className="text-sm font-semibold text-fg">
          {t("onboarding.getStarted.title")}
        </h2>
        <span data-testid="get-started-progress" className="text-xs text-fg-muted">
          {t("onboarding.getStarted.progress", { done, total: steps.length })}
        </span>
        <span aria-hidden className="h-1 max-w-40 flex-1 overflow-hidden rounded-full bg-surface-2">
          <span className="block h-full rounded-full bg-primary" style={{ width: `${(done / steps.length) * 100}%` }} />
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="ms-auto"
          onClick={() => update({ onboarding: { checklist_hidden: true } })}
        >
          {t("onboarding.getStarted.hide")}
        </Button>
      </div>
      <ol className="grid gap-2 sm:grid-cols-5">
        {steps.map((s, i) => {
          const isNext = s.id === nextId;
          return (
            <li
              key={s.id}
              data-testid={`get-started-${s.id}`}
              data-done={s.done}
              className={`flex flex-col gap-1 rounded-lg border p-3 ${
                isNext ? "border-primary/60 bg-primary/5" : "border-edge bg-surface-2"
              }`}
            >
              <span className={`text-[11px] font-medium ${s.done ? "text-emerald-400" : isNext ? "text-primary" : "text-fg-muted"}`}>
                {s.done ? t("onboarding.getStarted.done") : isNext ? t("onboarding.getStarted.next") : i + 1}
              </span>
              <span className="text-sm font-medium text-fg">{s.title}</span>
              <span className="text-xs text-fg-muted">{s.done && s.doneText ? s.doneText : s.body}</span>
              {isNext && s.id === "headset" ? (
                <button type="button" onClick={onPickHeadset} className="mt-1 w-fit text-xs text-primary hover:underline">
                  {t("onboarding.getStarted.pickNow")}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
