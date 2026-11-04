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
 * 2. Company details for invoices (GET/PUT /v1/billing/company, the
 *    Billing page's own sheet): company name and billing address; a VAT ID
 *    is optional.
 * 3. A few questions, all skippable: team size, main use, headsets
 *    (prefilled from onboarding).
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
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { IntroSwitch } from "@/components/billing/PlanCard";
import { WELCOME_DEVICES } from "@/components/onboarding/WelcomeDialog";
import {
  CompanyDetailsSheet,
  companySummary,
} from "@/components/pay/CompanyDetailsSheet";
import { PlanSheet } from "@/components/pay/PlanSheet";
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
import { GatewayError } from "@/lib/api/client";
import type { PlanChangePreview } from "@/lib/api/client";
import type { CompanyDetails, PlanDef, PublicPricing } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { usePricing } from "@/lib/api/usePricing";
import { useAuth } from "@/lib/auth";
import { useBilling } from "@/lib/billing";
import { notifyProChanged, useProStatus } from "@/lib/pro/usePro";
import type { ProStatus } from "@/lib/pro/usePro";
import { useAccountSettings } from "@/lib/useAccountSettings";

type PlanKey = "business" | "studio";
type Step = "plan" | "details" | "questions" | "checkout" | "welcome";

const STEPS: readonly { id: Exclude<Step, "welcome">; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "details", label: "Company" },
  { id: "questions", label: "About you" },
  { id: "checkout", label: "Pay" },
];

export const MAIN_USES: readonly { id: string; label: string }[] = [
  { id: "client_work", label: "Client work" },
  { id: "own_channel", label: "My own channel" },
  { id: "stock_footage", label: "Stock footage" },
  { id: "other", label: "Something else" },
];

/** What a plan includes, from /v1/pricing only. */
export function planIncludes(
  key: PlanKey,
  def: PlanDef,
  pricing: PublicPricing | null,
): string[] {
  const pct = pricing?.tiers?.classic_pct?.[key];
  const maxFps = def.max_fps ?? pricing?.fps?.max_fps_with_plan;
  return [
    ...(typeof pct === "number" && pct > 0
      ? [`${Math.round(pct * 100)}% off every video`]
      : []),
    `${formatCentsShort(def.credit_cents)} of usage every month`,
    "Commercial use of your videos",
    ...(maxFps && maxFps > 30 ? [`Frame rates up to ${maxFps} fps`] : []),
    "Turn the Spatial Video Studio intro on or off",
    "Invoices with your company details",
    ...(def.express_included ? ["Express included"] : []),
  ];
}

/** "$299 a month" / "$11,988 a year". */
function priceLine(def: PlanDef): string {
  const p = planPrice(def);
  return `${formatCentsShort(p.cents)} ${p.per}`;
}

/** "Billed monthly, renews every month until you cancel." */
function termsLine(def: PlanDef): string {
  return planPrice(def).yearly
    ? `Billed once a year. ${formatCentsShort(def.credit_cents)} of usage arrives every month. Renews every year until you cancel.`
    : `Billed monthly. Renews every month until you cancel.`;
}

const APP_STORE_SOURCES = new Set(["app_store", "mac_app_store"]);
const WEB_PRO_SOURCES = new Set(["rc_billing", "stripe"]);

/** Which "What happens to your Pro" applies. */
export function proCase(pro: ProStatus | null): "app_store" | "web" | null {
  if (!pro?.pro) return null;
  if (pro.source && APP_STORE_SOURCES.has(pro.source)) return "app_store";
  if (pro.source && WEB_PRO_SOURCES.has(pro.source)) return "web";
  return null;
}

export const APP_STORE_PRO_NOTE =
  "Your Pro is billed by Apple. Business includes everything Pro does, so cancel Pro in your iPhone's Settings → [your name] → Subscriptions to avoid paying for both.";

export function BusinessSetup(): JSX.Element {
  const gateway = useGateway();
  const pricing = usePricing();
  const tier = usePlanTier();
  const pro = useProStatus();
  const billing = useBilling();
  const { user } = useAuth();
  const { settings, update } = useAccountSettings();
  const [step, setStep] = useState<Step>("plan");
  const [plan, setPlan] = useState<PlanKey>("business");
  const [talk, setTalk] = useState<"closed" | "form" | "sent">("closed");
  const [company, setCompany] = useState<CompanyDetails | null>(null);
  const [editingCompany, setEditingCompany] = useState(false);
  const [teamSize, setTeamSize] = useState("");
  const [mainUse, setMainUse] = useState<string | null>(null);
  const [headsets, setHeadsets] = useState<string[] | null>(null);
  const [paying, setPaying] = useState(false);
  const [preview, setPreview] = useState<PlanChangePreview | null | "error">(
    null,
  );
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opened = useRef(false);

  const log = (name: string, props: Record<string, unknown> = {}) =>
    gateway.logEvent(name, props);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    gateway.logEvent("business_setup_opened", {});
  }, [gateway]);

  useEffect(() => {
    let live = true;
    gateway.getCompany().then(
      (c) => live && setCompany(c),
      () => live && setCompany({ tax_ids: [] }),
    );
    return () => {
      live = false;
    };
  }, [gateway]);

  const theCase = proCase(pro);
  const defs = pricing?.plans;
  const def = defs?.[plan];

  // a web Pro: today's price for the change, before anything is charged
  useEffect(() => {
    if (step !== "checkout" || theCase !== "web") return;
    let live = true;
    gateway.previewPlanChange(plan).then(
      (p) => live && setPreview(p),
      () => live && setPreview("error"),
    );
    return () => {
      live = false;
    };
  }, [gateway, step, theCase, plan]);

  if (tier === "business" || tier === "studio") {
    if (step !== "welcome") {
      return (
        <Page>
          <h1 className="text-xl font-semibold tracking-tight">
            You have {tier === "business" ? "Business" : "Studio"}
          </h1>
          <p className="text-fg-muted">
            Your plan is on{" "}
            <Link
              href="/account/billing"
              className="text-primary hover:underline"
            >
              Billing
            </Link>
            .
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

  const companyReady = !!company?.name?.trim() && !!company.address?.country;
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
    setConfirming(true);
    setError(null);
    try {
      await gateway.changePlan(plan);
      purchased();
    } catch (e) {
      setError(
        e instanceof GatewayError && e.message
          ? e.message
          : "Couldn't change your plan. Nothing was charged.",
      );
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Page>
      {step !== "welcome" ? (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-[13px] font-medium text-primary">
              Business and Studio
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">
              Set up Spatial Video Studio for work
            </h1>
          </div>
          <ol aria-label="Steps" className="flex flex-wrap gap-2 text-xs">
            {STEPS.map((s, i) => {
              const at = STEPS.findIndex((x) => x.id === step);
              return (
                <li
                  key={s.id}
                  aria-current={s.id === step ? "step" : undefined}
                  className={`rounded-full border px-3 py-1 ${
                    s.id === step
                      ? "border-primary text-fg"
                      : i < at
                        ? "border-edge text-fg"
                        : "border-edge text-fg-muted"
                  }`}
                >
                  {i + 1}. {s.label}
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
            aria-label="Plan"
            className="grid gap-3 sm:grid-cols-2"
          >
            {(["business", "studio"] as const).map((k) => {
              const d = defs[k]!;
              const on = plan === k;
              return (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={on}
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
                    </span>
                    <span className="text-sm text-fg">{priceLine(d)}</span>
                  </span>
                  <span className="text-xs text-fg-muted">
                    {planPrice(d).yearly ? "Yearly plan" : "Monthly plan"}
                  </span>
                  <ul className="flex flex-col gap-1.5 text-sm text-fg">
                    {planIncludes(k, d, pricing).map((line) => (
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
              Questions first?{" "}
              <button
                type="button"
                data-testid="setup-talk"
                onClick={() => setTalk("form")}
                className="text-primary hover:underline"
              >
                Talk to us
              </button>
            </p>
          ) : null}
          <Footer>
            <Button asChild variant="ghost">
              <Link href="/account">Not now</Link>
            </Button>
            <Button
              data-testid="setup-next"
              onClick={() => {
                log("business_setup_plan_picked", { plan });
                setStep("details");
              }}
            >
              Continue with {def.name}
            </Button>
          </Footer>
        </section>
      ) : step === "details" ? (
        <section className="flex flex-col gap-4" data-testid="setup-details">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-fg">
              Company details for your invoices
            </h2>
            <p className="text-sm text-fg-muted">
              Company name and billing address. A VAT ID is optional.
            </p>
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-edge bg-surface-1 p-4">
            <p
              className="flex-1 text-sm text-fg"
              data-testid="setup-company-summary"
            >
              {company === null
                ? "Loading…"
                : (companySummary(company) ?? "No company details yet.")}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={company === null}
              onClick={() => setEditingCompany(true)}
            >
              {companySummary(company) ? "Edit" : "Add details"}
            </Button>
          </div>
          {editingCompany && company ? (
            <CompanyDetailsSheet
              initial={company}
              onClose={(saved) => {
                setEditingCompany(false);
                if (saved) setCompany(saved);
              }}
            />
          ) : null}
          <Footer>
            <Button variant="ghost" onClick={() => setStep("plan")}>
              Back
            </Button>
            <Button
              data-testid="setup-next"
              disabled={!companyReady}
              onClick={() => setStep("questions")}
            >
              Continue
            </Button>
          </Footer>
        </section>
      ) : step === "questions" ? (
        <section className="flex flex-col gap-4" data-testid="setup-questions">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-fg">A few questions</h2>
            <p className="text-sm text-fg-muted">
              All optional. They help us make the product better for work.
            </p>
          </div>
          <label className="flex max-w-xs flex-col gap-1 text-xs text-fg-muted">
            Team size
            <input
              data-testid="setup-team-size"
              value={teamSize}
              maxLength={60}
              onChange={(e) => setTeamSize(e.target.value)}
              placeholder="e.g. 4"
              className="h-10 rounded-lg border border-edge bg-surface-2 px-3 text-sm text-fg"
            />
          </label>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs text-fg-muted">Main use</legend>
            <div
              role="radiogroup"
              aria-label="Main use"
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
                  {u.label}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs text-fg-muted">Headsets</legend>
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
            <Button variant="ghost" onClick={() => setStep("details")}>
              Back
            </Button>
            <Button
              variant="outline"
              data-testid="setup-skip"
              onClick={() => {
                log("business_setup_details_done", { skipped: true });
                setStep("checkout");
              }}
            >
              Skip
            </Button>
            <Button
              data-testid="setup-next"
              onClick={() => {
                if (headsets !== null) update({ headsets });
                log("business_setup_details_done", {
                  ...(teamSize.trim() ? { team_size: teamSize.trim() } : {}),
                  ...(mainUse ? { main_use: mainUse } : {}),
                  ...(chosenHeadsets.length > 0
                    ? { headsets: chosenHeadsets }
                    : {}),
                });
                setStep("checkout");
              }}
            >
              Continue
            </Button>
          </Footer>
        </section>
      ) : step === "checkout" ? (
        <section className="flex flex-col gap-4" data-testid="setup-checkout">
          <div className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-1 p-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-lg font-semibold text-fg">{def.name}</span>
              <span className="text-lg text-fg">{priceLine(def)}</span>
            </div>
            <p className="text-sm text-fg-muted" data-testid="setup-terms">
              {termsLine(def)} Prices in USD, excl. tax. Nothing is charged
              until you confirm.
            </p>
            {companySummary(company) ? (
              <p className="text-xs text-fg-muted">
                Invoices to {companySummary(company)}
              </p>
            ) : null}
          </div>

          {theCase !== null ? (
            <div
              className="flex flex-col gap-2 rounded-xl border border-edge p-4"
              data-testid="setup-pro-slot"
            >
              <p className="text-sm font-medium text-fg">
                What happens to your Pro
              </p>
              {theCase === "app_store" ? (
                <>
                  <p className="text-sm text-fg-muted">{APP_STORE_PRO_NOTE}</p>
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
                        Manage App Store subscription
                      </a>
                    </Button>
                  ) : null}
                </>
              ) : preview === null ? (
                <p className="text-sm text-fg-muted">
                  Working out today&apos;s price…
                </p>
              ) : preview === "error" ? (
                <p className="text-sm text-fg-muted">
                  We&apos;ll take care of your web Pro. Details before you pay.
                </p>
              ) : (
                <p className="text-sm text-fg" data-testid="setup-preview">
                  Today: {formatCents(preview.today_cents)} (new plan{" "}
                  {formatCents(preview.new_plan_cents)} −{" "}
                  {formatCents(preview.unused_credit_cents)} for your unused Pro
                  days). Renews on{" "}
                  {new Date(preview.renews_at).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                  .
                </p>
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
              Back
            </Button>
            {theCase === "web" ? (
              <Button
                data-testid="setup-confirm"
                disabled={preview === null || preview === "error" || confirming}
                onClick={() => {
                  log("business_setup_checkout_started", { plan });
                  void confirmChange();
                }}
              >
                {confirming
                  ? "Changing…"
                  : preview && preview !== "error"
                    ? `Confirm and pay ${formatCents(preview.today_cents)}`
                    : "Confirm"}
              </Button>
            ) : (
              <Button
                data-testid="setup-pay"
                onClick={() => {
                  log("business_setup_checkout_started", { plan });
                  setPaying(true);
                }}
              >
                Continue to payment
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
          <p className="text-[13px] font-medium text-primary">Welcome</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {def.name} is on
          </h1>
          <ul className="flex flex-col gap-2 text-sm text-fg">
            <li className="flex items-start gap-2">
              <Check
                className="mt-0.5 size-4 shrink-0 text-primary"
                aria-hidden
              />
              Commercial use: your 3D videos can go to clients, ads and paid
              channels.
            </li>
            {(def.max_fps ?? pricing?.fps?.max_fps_with_plan ?? 0) > 30 ? (
              <li className="flex items-start gap-2">
                <Check
                  className="mt-0.5 size-4 shrink-0 text-primary"
                  aria-hidden
                />
                Higher frame rates: up to{" "}
                {def.max_fps ?? pricing?.fps?.max_fps_with_plan} fps when your
                video has them.
              </li>
            ) : null}
            <li className="flex items-start gap-2">
              <Check
                className="mt-0.5 size-4 shrink-0 text-primary"
                aria-hidden
              />
              {formatCentsShort(def.credit_cents)} of usage every month, then{" "}
              {def.name} prices.
            </li>
          </ul>
          <div className="rounded-xl border border-edge bg-surface-1 p-4">
            <IntroSwitch />
          </div>
          <Footer>
            <Button asChild size="lg" data-testid="setup-make">
              <Link href="/projects">Make your 3D video</Link>
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
            <DialogTitle>Talk to us</DialogTitle>
            <DialogDescription>
              A person replies by email, usually within a working day.
            </DialogDescription>
          </DialogHeader>
          {talk === "sent" ? (
            <p className="text-sm text-fg">
              Thanks. We&apos;ll reply to {user?.email ?? "your account email"}.
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
