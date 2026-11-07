"use client";

/**
 * Business and Studio setup (owner 2026-11-04), from /account and /pro: a
 * full page, so it works the same on a phone, a desktop and a headset
 * browser.
 *
 * 1. Plan: Business (monthly) or Studio (yearly), every number from
 *    /v1/pricing — the share off, the monthly usage, commercial use, frame
 *    rates up to the plan's max_fps, the intro switch, invoices, Express.
 *    No seat counts (no team accounts yet). Company emails also get Talk to
 *    us.
 * 2. (Owner 2026-11-04: no company step. Owner 2026-11-05: Checkout asks
 *    only the method and country; the welcome's link to Account → Business
 *    details takes the company name, address, tax ID and billing email.)
 * 3. A few questions, all skippable: team size, main use, headsets
 *    (prefilled from onboarding), saved on the account (PATCH
 *    settings.business_setup).
 * 4. Checkout: the price and the monthly/yearly terms before paying.
 *    "What happens to your Pro" — an App Store Pro gets Apple's cancel
 *    note; a web Pro gets today's charge from POST /v1/plans/preview-change
 *    and confirms with POST /v1/plans/change; everyone else pays through
 *    the plan sheet. Nothing is charged until they confirm.
 * 5. Welcome: commercial use, higher frame rates, the intro switch (on by
 *    default) and "Make your 3D video".
 *
 * Funnel events: business_setup_opened, _plan_picked {plan},
 * _details_done, _checkout_started {plan}, _purchased {plan}.
 */

import { Check } from "lucide-react";
import Link from "next/link";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { IntroSwitch } from "@/components/billing/PlanCard";
import {
  confirmPlanChangeAtom,
  planChangeAtom,
  previewPlanChangeAtom,
} from "@/components/billing/planChangeAtoms";
import { StepUpDetails } from "@/components/billing/StepUpDetails";
import { REPRICED } from "@/components/billing/planChangeCopy";
import { WELCOME_DEVICES } from "@/components/onboarding/WelcomeDialog";
import { COMPANY_LINK, PlanSheet } from "@/components/pay/PlanSheet";
import { ContactSalesForm } from "@/components/plans/ContactSalesForm";
import { isCompanyEmail, usePlanTier } from "@/components/plans/upsell";
import { planPrice } from "@/components/pricing/planCopy";
import { formatCents, formatCentsShort } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PlanChangePreview } from "@/lib/api/client";
import type { PlanDef, PublicPricing } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { usePricing } from "@/lib/api/usePricing";
import { useAuth } from "@/lib/auth";
import { useBilling } from "@/lib/billing";
import { useT } from "@/lib/i18n/I18nProvider";
import { rich } from "@/lib/i18n/rich";
import { EN, type Tr } from "@/lib/i18n/t";
import { SITE_NAME } from "@/lib/site";
import { isWebPro, notifyProChanged, useProStatus } from "@/lib/pro/usePro";
import type { ProStatus } from "@/lib/pro/usePro";
import { useAccountSettings } from "@/lib/useAccountSettings";
import { qualitySteps } from "@/components/steps/FileQuality";
import { PLAN_FILE_QUALITY } from "@/components/pricing/PlansSection";

type PlanKey = "business" | "studio";
type Step = "plan" | "questions" | "checkout" | "welcome";

/** Product and plan names stay English in every language (placeholders). */
export const PRODUCT_NAMES = {
  site: SITE_NAME,
  pro: "Pro",
  business: "Business",
  studio: "Studio",
} as const;

const STEPS: readonly Exclude<Step, "welcome">[] = ["plan", "questions", "checkout"];

/** Main use answers: the id is saved on the account; the label is a key. */
export const MAIN_USES: readonly { id: string; labelKey: string }[] = [
  { id: "client_work", labelKey: "business.setup.mainUses.clientWork" },
  { id: "own_channel", labelKey: "business.setup.mainUses.ownChannel" },
  { id: "stock_footage", labelKey: "business.setup.mainUses.stockFootage" },
  { id: "other", labelKey: "business.setup.mainUses.other" },
];

/** What a plan includes, from /v1/pricing only. */
export function planIncludes(
  key: PlanKey,
  def: PlanDef,
  pricing: PublicPricing | null,
  t: Tr = EN,
): string[] {
  const pct = pricing?.tiers?.classic_pct?.[key];
  const maxFps = def.max_fps ?? pricing?.fps?.max_fps_with_plan;
  return [
    ...(typeof pct === "number" && pct > 0
      ? [t("business.setup.includes.pctOff", { pct: Math.round(pct * 100) })]
      : []),
    t("business.setup.includes.usage", { amount: formatCentsShort(def.credit_cents, t) }),
    t("business.setup.includes.commercial"),
    ...(maxFps && maxFps > 30 ? [t("business.setup.includes.frameRates", { fps: maxFps })] : []),
    t("business.setup.includes.intro", { site: SITE_NAME }),
    t("business.setup.includes.invoices"),
    ...(def.express_included ? [t("business.setup.includes.express")] : []),
    ...(qualitySteps(pricing).length > 2 ? [PLAN_FILE_QUALITY] : []),
  ];
}

/** "$299 a month" / "$11,988 a year". */
function priceLine(def: PlanDef, t: Tr = EN): string {
  const p = planPrice(def);
  const price = formatCentsShort(p.cents, t);
  return p.yearly
    ? t("business.setup.price.year", { price })
    : t("business.setup.price.month", { price });
}

/** "Billed monthly, renews every month until you cancel." */
function termsLine(def: PlanDef, t: Tr = EN): string {
  return planPrice(def).yearly
    ? t("business.setup.terms.yearly", { amount: formatCentsShort(def.credit_cents, t) })
    : t("business.setup.terms.monthly");
}

const APP_STORE_SOURCES = new Set(["app_store", "mac_app_store"]);

/** Which "What happens to your Pro" applies. */
export function proCase(pro: ProStatus | null): "app_store" | "web" | null {
  if (!pro?.pro) return null;
  if (pro.source && APP_STORE_SOURCES.has(pro.source)) return "app_store";
  // web Pro (our own plan); Pro included with Business/Studio or simulated: no note
  if (isWebPro(pro)) return "web";
  return null;
}

/** The App Store Pro note in English (tests read it). */
export const APP_STORE_PRO_NOTE = EN("business.setup.appStoreProNote", PRODUCT_NAMES);

const SCOPE = "business-setup";

export function BusinessSetup(): JSX.Element {
  const t = useT();
  const gateway = useGateway();
  const pricing = usePricing();
  const tier = usePlanTier();
  const pro = useProStatus();
  const billing = useBilling();
  const { user } = useAuth();
  const { settings, update } = useAccountSettings();
  const [step, setStep] = useState<Step>("plan");
  const [picked, setPlan] = useState<PlanKey>("business");
  const plan: PlanKey = tier === "business" ? "studio" : picked;
  const [talk, setTalk] = useState<"closed" | "form" | "sent">("closed");
  const [teamSize, setTeamSize] = useState("");
  const [mainUse, setMainUse] = useState<string | null>(null);
  const [headsets, setHeadsets] = useState<string[] | null>(null);
  const [paying, setPaying] = useState(false);
  // ADR 0138: the preview and the confirm live in the plan change atom
  const change = useAtomValue(planChangeAtom(SCOPE));
  const previewChange = useSetAtom(previewPlanChangeAtom);
  const confirmPlan = useSetAtom(confirmPlanChangeAtom);
  const confirming = change.busy;
  const error = change.repriced ? REPRICED : change.error;
  const opened = useRef(false);

  const log = (name: string, props: Record<string, unknown> = {}) =>
    gateway.logEvent(name, props);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    gateway.logEvent("business_setup_opened", {});
  }, [gateway]);

  // owner 2026-11-04: Business → Studio is a step-up at once
  const fromBusiness = tier === "business";
  const theCase: "app_store" | "web" | "business" | null = fromBusiness
    ? "business"
    : proCase(pro);
  const defs = pricing?.plans;
  const def = defs?.[plan];

  // a web Pro: today's price for the change, before anything is charged
  const wantsPreview = step === "checkout" && (theCase === "web" || theCase === "business");
  useEffect(() => {
    if (wantsPreview) void previewChange({ scope: SCOPE, client: gateway, to: plan });
  }, [wantsPreview, previewChange, gateway, plan]);
  const preview: PlanChangePreview | null | "error" =
    change.to !== plan ? null : change.previewFailed ? "error" : change.preview;

  if (tier === "studio") {
    if (step !== "welcome") {
      return (
        <Page>
          <h1 className="text-xl font-semibold tracking-tight">
            {t("business.setup.studio.title", PRODUCT_NAMES)}
          </h1>
          <p className="text-fg-muted">
            {rich(t, "business.setup.studio.onBilling", {
              link: (c) => (
                <Link
                  href="/account/billing"
                  className="text-primary hover:underline"
                >
                  {c}
                </Link>
              ),
            })}
          </p>
        </Page>
      );
    }
  }

  if (!defs?.business || !defs?.studio || !def) {
    return (
      <Page>
        <div
          className="h-64 animate-pulse rounded-xl bg-surface-1"
          data-testid="setup-loading"
        />
      </Page>
    );
  }

  const chosenHeadsets = headsets ?? settings?.headsets ?? [];

  function purchased(): void {
    log("business_setup_purchased", { plan });
    // attribution: the gateway reads the Pro state again right after
    void gateway.refreshPro().catch(() => {});
    notifyProChanged();
    void billing.refresh();
    setStep("welcome");
  }

  async function confirmChange(): Promise<void> {
    if (!preview || preview === "error") return;
    // a quote that ran out comes back repriced: the new amount shows, and
    // they confirm again
    if ((await confirmPlan({ scope: SCOPE, client: gateway })) === "done") purchased();
  }

  return (
    <Page>
      {step !== "welcome" ? (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-[13px] font-medium text-primary">
              {t("business.setup.eyebrow", PRODUCT_NAMES)}
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("business.setup.title", PRODUCT_NAMES)}
            </h1>
          </div>
          <ol aria-label={t("business.setup.steps.aria")} className="flex flex-wrap gap-2 text-xs">
            {STEPS.map((s, i) => {
              const at = STEPS.findIndex((x) => x === step);
              return (
                <li
                  key={s}
                  aria-current={s === step ? "step" : undefined}
                  className={`rounded-full border px-3 py-1 ${
                    s === step
                      ? "border-primary text-fg"
                      : i < at
                        ? "border-edge text-fg"
                        : "border-edge text-fg-muted"
                  }`}
                >
                  {t("business.setup.steps.item", { n: i + 1, label: stepLabel(s, t) })}
                </li>
              );
            })}
          </ol>
        </>
      ) : null}

      {step === "plan" ? (
        <section className="flex flex-col gap-4" data-testid="setup-plan">
          <div
            role="radiogroup"
            aria-label={t("business.setup.planAria")}
            className="grid gap-3 sm:grid-cols-2"
          >
            {(["business", "studio"] as const).map((k) => {
              const d = defs[k]!;
              const on = plan === k;
              // a Business holder moves up to Studio only
              const current = fromBusiness && k === "business";
              return (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={current}
                  data-testid={`setup-plan-${k}`}
                  onClick={() => setPlan(k)}
                  className={`flex flex-col gap-3 rounded-xl border p-4 text-left ${
                    on
                      ? "border-primary bg-primary/10"
                      : "border-edge bg-surface-1 hover:border-fg-muted"
                  }`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-lg font-semibold text-fg">
                      {d.name}
                      {current ? (
                        <span className="ml-2 text-xs font-normal text-fg-muted">
                          {t("business.setup.yourPlan")}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-sm text-fg">{priceLine(d, t)}</span>
                  </span>
                  <span className="text-xs text-fg-muted">
                    {planPrice(d).yearly ? t("business.setup.yearlyPlan") : t("business.setup.monthlyPlan")}
                  </span>
                  <ul className="flex flex-col gap-1.5 text-sm text-fg">
                    {planIncludes(k, d, pricing, t).map((line) => (
                      <li key={line} className="flex items-start gap-2">
                        <Check
                          className="mt-0.5 size-4 shrink-0 text-primary"
                          aria-hidden
                        />
                        {line}
                      </li>
                    ))}
                  </ul>
                </button>
              );
            })}
          </div>
          {isCompanyEmail(user?.email) ? (
            <p className="text-sm text-fg-muted">
              {t("business.setup.questionsFirst")}{" "}
              <button
                type="button"
                data-testid="setup-talk"
                onClick={() => setTalk("form")}
                className="text-primary hover:underline"
              >
                {t("business.setup.talkToUs")}
              </button>
            </p>
          ) : null}
          <Footer>
            <Button asChild variant="ghost">
              <Link href="/account">{t("business.setup.notNow")}</Link>
            </Button>
            <Button
              data-testid="setup-next"
              onClick={() => {
                log("business_setup_plan_picked", { plan });
                setStep("questions");
              }}
            >
              {t("business.setup.continueWith", { plan: def.name })}
            </Button>
          </Footer>
        </section>
      ) : step === "questions" ? (
        <section className="flex flex-col gap-4" data-testid="setup-questions">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-fg">{t("business.setup.questions.title")}</h2>
            <p className="text-sm text-fg-muted">
              {t("business.setup.questions.hint")}
            </p>
          </div>
          <label className="flex max-w-xs flex-col gap-1 text-xs text-fg-muted">
            {t("business.setup.questions.teamSize")}
            <input
              data-testid="setup-team-size"
              value={teamSize}
              maxLength={60}
              onChange={(e) => setTeamSize(e.target.value)}
              placeholder={t("business.setup.questions.teamSizePlaceholder")}
              className="h-10 rounded-lg border border-edge bg-surface-2 px-3 text-sm text-fg"
            />
          </label>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs text-fg-muted">{t("business.setup.questions.mainUse")}</legend>
            <div
              role="radiogroup"
              aria-label={t("business.setup.questions.mainUse")}
              className="flex flex-wrap gap-2"
            >
              {MAIN_USES.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  role="radio"
                  aria-checked={mainUse === u.id}
                  onClick={() => setMainUse(mainUse === u.id ? null : u.id)}
                  className={`min-h-10 rounded-full border px-4 text-sm ${
                    mainUse === u.id
                      ? "border-primary bg-primary/10 text-fg"
                      : "border-edge text-fg-muted hover:text-fg"
                  }`}
                >
                  {t(u.labelKey)}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs text-fg-muted">{t("business.setup.questions.headsets")}</legend>
            <div className="flex flex-wrap gap-2">
              {WELCOME_DEVICES.map((d) => {
                const on = chosenHeadsets.includes(d.id);
                return (
                  <button
                    key={d.id}
                    type="button"
                    aria-pressed={on}
                    data-testid={`setup-headset-${d.id}`}
                    onClick={() =>
                      setHeadsets(
                        on
                          ? chosenHeadsets.filter((x) => x !== d.id)
                          : [...chosenHeadsets, d.id],
                      )
                    }
                    className={`min-h-10 rounded-full border px-4 text-sm ${
                      on
                        ? "border-primary bg-primary/10 text-fg"
                        : "border-edge text-fg-muted hover:text-fg"
                    }`}
                  >
                    {d.name}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <Footer>
            <Button variant="ghost" onClick={() => setStep("plan")}>
              {t("business.setup.back")}
            </Button>
            <Button
              variant="outline"
              data-testid="setup-skip"
              onClick={() => {
                log("business_setup_details_done");
                setStep("checkout");
              }}
            >
              {t("business.setup.skip")}
            </Button>
            <Button
              data-testid="setup-next"
              onClick={() => {
                const answers = {
                  ...(teamSize.trim() ? { team_size: teamSize.trim() } : {}),
                  ...(mainUse ? { main_use: mainUse } : {}),
                  ...(chosenHeadsets.length > 0
                    ? { headsets: chosenHeadsets }
                    : {}),
                };
                // the answers live on the account; the funnel event has none
                update({
                  ...(headsets !== null ? { headsets } : {}),
                  ...(Object.keys(answers).length > 0
                    ? { business_setup: answers }
                    : {}),
                });
                log("business_setup_details_done");
                setStep("checkout");
              }}
            >
              {t("business.setup.continue")}
            </Button>
          </Footer>
        </section>
      ) : step === "checkout" ? (
        <section className="flex flex-col gap-4" data-testid="setup-checkout">
          <div className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-1 p-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-lg font-semibold text-fg">{def.name}</span>
              <span className="text-lg text-fg">{priceLine(def, t)}</span>
            </div>
            <p className="text-sm text-fg-muted" data-testid="setup-terms">
              {t("business.setup.checkout.termsTail", { terms: termsLine(def, t) })}
            </p>
            <p className="text-xs text-fg-muted">
              {t("business.setup.checkout.asksOnly")}
            </p>
          </div>

          {theCase !== null ? (
            <div
              className="flex flex-col gap-2 rounded-xl border border-edge p-4"
              data-testid="setup-pro-slot"
            >
              <p className="text-sm font-medium text-fg">
                {theCase === "business"
                  ? t("business.setup.checkout.whatHappensBusiness", PRODUCT_NAMES)
                  : t("business.setup.checkout.whatHappensPro", PRODUCT_NAMES)}
              </p>
              {theCase === "app_store" ? (
                <>
                  <p className="text-sm text-fg-muted">{t("business.setup.appStoreProNote", PRODUCT_NAMES)}</p>
                  {pro?.management_url ? (
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      className="w-fit"
                    >
                      <a
                        href={pro.management_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("business.setup.checkout.manageAppStore")}
                      </a>
                    </Button>
                  ) : null}
                </>
              ) : preview === null ? (
                <p className="text-sm text-fg-muted">
                  {t("business.setup.checkout.workingOut")}
                </p>
              ) : preview === "error" ? (
                <p className="text-sm text-fg-muted">
                  {t("business.setup.checkout.previewFailed")}
                </p>
              ) : (
                <StepUpDetails
                  testId="setup-preview"
                  preview={preview}
                  from={
                    theCase === "business"
                      ? (defs.business?.name ?? "Business")
                      : "Pro"
                  }
                  to={def.name}
                  handoverCreditCents={
                    theCase === "business" ? def.credit_cents : null
                  }
                />
              )}
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Footer>
            <Button variant="ghost" onClick={() => setStep("questions")}>
              {t("business.setup.back")}
            </Button>
            {theCase === "web" || theCase === "business" ? (
              <Button
                data-testid="setup-confirm"
                disabled={preview === null || preview === "error" || confirming}
                onClick={() => {
                  log("business_setup_checkout_started", { plan });
                  void confirmChange();
                }}
              >
                {confirming
                  ? t("business.setup.checkout.changing")
                  : preview && preview !== "error"
                    ? t("business.setup.checkout.confirmAndPay", { amount: formatCents(preview.today_cents, t) })
                    : t("business.setup.checkout.confirm")}
              </Button>
            ) : (
              <Button
                data-testid="setup-pay"
                onClick={() => {
                  log("business_setup_checkout_started", { plan });
                  setPaying(true);
                }}
              >
                {t("business.setup.checkout.continueToPayment")}
              </Button>
            )}
          </Footer>
          {paying ? (
            <PlanSheet
              plan={plan}
              def={def}
              onClose={(started) => {
                setPaying(false);
                if (started) purchased();
              }}
            />
          ) : null}
        </section>
      ) : (
        <section className="flex flex-col gap-4" data-testid="setup-welcome">
          <p className="text-[13px] font-medium text-primary">{t("business.setup.welcome.eyebrow")}</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("business.setup.welcome.title", { plan: def.name })}
          </h1>
          <ul className="flex flex-col gap-2 text-sm text-fg">
            <li className="flex items-start gap-2">
              <Check
                className="mt-0.5 size-4 shrink-0 text-primary"
                aria-hidden
              />
              {t("business.setup.welcome.commercial")}
            </li>
            {(def.max_fps ?? pricing?.fps?.max_fps_with_plan ?? 0) > 30 ? (
              <li className="flex items-start gap-2">
                <Check
                  className="mt-0.5 size-4 shrink-0 text-primary"
                  aria-hidden
                />
                {t("business.setup.welcome.frameRates", {
                  fps: def.max_fps ?? pricing?.fps?.max_fps_with_plan,
                })}
              </li>
            ) : null}
            <li className="flex items-start gap-2">
              <Check
                className="mt-0.5 size-4 shrink-0 text-primary"
                aria-hidden
              />
              {t("business.setup.welcome.usage", {
                amount: formatCentsShort(def.credit_cents, t),
                plan: def.name,
              })}
            </li>
          </ul>
          <div className="rounded-xl border border-edge bg-surface-1 p-4">
            <IntroSwitch />
          </div>
          {/* owner 2026-11-04: optional, never blocking */}
          <p className="text-sm text-fg-muted">
            <Link
              href="/account/business-details"
              data-testid="setup-company-link"
              className="text-primary hover:underline"
            >
              {COMPANY_LINK}
            </Link>
          </p>
          <Footer>
            <Button asChild size="lg" data-testid="setup-make">
              <Link href="/projects">{t("business.setup.welcome.make")}</Link>
            </Button>
          </Footer>
        </section>
      )}

      <Dialog
        open={talk !== "closed"}
        onOpenChange={(o) => !o && setTalk("closed")}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("business.setup.talk.title")}</DialogTitle>
            <DialogDescription>
              {t("business.setup.talk.description")}
            </DialogDescription>
          </DialogHeader>
          {talk === "sent" ? (
            <p className="text-sm text-fg">
              {t("business.setup.talk.sent", {
                email: user?.email ?? t("business.setup.talk.accountEmail"),
              })}
            </p>
          ) : (
            <ContactSalesForm
              onSent={() => setTalk("sent")}
              onCancel={() => setTalk("closed")}
            />
          )}
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function stepLabel(s: Exclude<Step, "welcome">, t: Tr): string {
  return s === "plan"
    ? t("business.setup.steps.plan")
    : s === "questions"
      ? t("business.setup.steps.questions")
      : t("business.setup.steps.checkout");
}

function Page({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
      {children}
    </div>
  );
}

function Footer({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-edge pt-4">
      {children}
    </div>
  );
}
