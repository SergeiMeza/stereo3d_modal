"use client";

/**
 * Landing / product page body (mock 12, S3D-46). Lifelike 3D is the
 * product: the hero leads with it, four short points say what it gives
 * (natural depth, any length up to 8K, the original eye at the highest
 * sizes, Foveated Detail), then the devices, three steps, the samples to
 * download, "How it looks" (real screenshots of the web app), what happens
 * to a video, where to watch it, and one closing call to action. Classic-era
 * selling points (depth direction, per-shot scripts, frame-exact controls,
 * "VFX studio") are gone (2026-11).
 *
 * Client because the CTA depends on auth state ("Make your first 3D video"
 * goes to /projects with a session, /signin otherwise) and the prices come
 * from GET /v1/pricing — never hardcoded. The route itself (app/page.tsx)
 * is a server component so it can carry per-page metadata and JSON-LD.
 * Requirements and copy rules live in web/docs/LANDING.md — notably: no
 * internal pipeline terms (S3D-36), "Foveated Detail" is the one allowed
 * technical name (S3D-50), no fabricated proof, videos only (S3D-09).
 */

import { Eye, Focus, Layers, Maximize2, type LucideIcon } from "lucide-react";
import Link from "next/link";

import { openFeedback } from "@/components/FeedbackLink";
import { HeroLoop } from "@/components/landing/HeroLoop";
import { PipelineSteps } from "@/components/landing/PipelineSteps";
import { ProductTour } from "@/components/landing/ProductTour";
import { Samples } from "@/components/landing/Samples";
import { WorksWith } from "@/components/landing/WorksWith";
import { AppIcon } from "@/components/AppIcon";
import { methodLimitText, sentenceCase } from "@/components/steps/methods";
import { formatCentsShort } from "@/components/steps/money";
import { track } from "@/lib/analytics";
import { fromPerMinute, usePricing } from "@/lib/api/usePricing";
import { useAuth } from "@/lib/auth";
import { FORMAT_NAMES, METHOD_NAMES } from "@/lib/glossary";
import { useT } from "@/lib/i18n/I18nProvider";
import { LanguagePicker } from "@/lib/i18n/LanguagePicker";
import { rich } from "@/lib/i18n/rich";
import { EN, type Tr } from "@/lib/i18n/t";
import { SITE_NAME } from "@/lib/site";

interface Point {
  icon: LucideIcon;
  title: string;
  detail: string;
}

// Names from the glossary (S3D-37); Lifelike makes these two (S3D-08).
function formats(t: Tr = EN) {
  return [
    {
      tag: ".mov",
      title: FORMAT_NAMES.mvhevc,
      detail: t("landing.formats.mvhevcDetail"),
    },
    {
      tag: ".mp4",
      title: FORMAT_NAMES.sbs,
      detail: t("landing.formats.sbsDetail"),
    },
  ];
}

function SectionHead({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
}) {
  return (
    <>
      <p className="text-xs font-medium tracking-widest text-primary uppercase">
        {eyebrow}
      </p>
      <h2 className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
        {title}
      </h2>
      {lede ? <p className="mt-3 max-w-2xl text-fg-muted">{lede}</p> : null}
    </>
  );
}

export function LandingContent() {
  const t = useT();
  const { user } = useAuth();
  const signedIn = user !== null;
  const pricing = usePricing();
  const perMinute = pricing ? fromPerMinute(pricing) : null;
  // S3D-05: the limits are Lifelike's, from /v1/pricing ("Any length, up to 8K")
  const lifelikeLimits = sentenceCase(methodLimitText("lifelike", null, pricing, t));
  const ctaHref = signedIn ? "/projects" : "/signin";

  const points: Point[] = [
    {
      icon: Layers,
      title: t("landing.points.depthTitle"),
      detail: t("landing.points.depthDetail"),
    },
    {
      icon: Maximize2,
      title: lifelikeLimits,
      detail: t("landing.points.lengthDetail"),
    },
    {
      icon: Eye,
      title: t("landing.points.originalTitle"),
      detail: t("landing.points.originalDetail"),
    },
    {
      icon: Focus,
      title: "Foveated Detail",
      detail: t("landing.points.foveatedDetail"),
    },
  ];

  return (
    <div className="w-full">
      {/* Hero (mock 12, S3D-46): leads with Lifelike 3D */}
      <section className="relative mx-auto grid w-full max-w-6xl items-center gap-10 px-4 pt-14 pb-12 sm:pt-20 lg:grid-cols-[1fr_1.15fr] lg:gap-14">
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 end-0 h-[420px] w-[620px] max-w-full rounded-full bg-[radial-gradient(closest-side,rgb(79_140_255/0.18),rgb(167_139_250/0.08)_60%,transparent)] blur-md"
        />
        <div className="relative">
          <p className="flex flex-wrap items-center gap-2.5">
            <span className="ll-tag-new">{t("landing.hero.new")}</span>
            <span data-testid="hero-eyebrow" className="ll-eyebrow !text-xs">
              {t("landing.hero.eyebrow", { site: SITE_NAME, method: METHOD_NAMES.lifelike })}
            </span>
          </p>
          <h1 className="mt-4 text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl lg:text-[56px]">
            {rich(t, "landing.hero.title", {
              accent: (c) => (
                <span className="bg-gradient-to-r from-fg via-[#b9c8ff] to-[#a7f3ea] bg-clip-text text-transparent">
                  {c}
                </span>
              ),
            })}
          </h1>
          <p className="mt-5 max-w-md text-base leading-relaxed text-fg-muted sm:text-lg">
            {t("landing.hero.lede")}
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-4">
            <Link
              href={ctaHref}
              onClick={() => track("lp_cta_hero_click", { signed_in: signedIn })}
              className="rounded-lg bg-primary px-6 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary/80"
            >
              {t("landing.hero.cta")}
            </Link>
            {perMinute !== null ? (
              <span data-testid="hero-from-price" className="text-fg-muted">
                {rich(
                  t,
                  "landing.hero.fromPrice",
                  { b: (c) => <b className="text-xl font-semibold text-fg">{c}</b> },
                  { price: formatCentsShort(perMinute, t), fps: pricing?.fps.base ?? 24 },
                )}
              </span>
            ) : null}
          </div>
          <p data-testid="hero-limits" className="mt-4 text-xs text-fg-muted">
            {rich(
              t,
              "landing.hero.limits",
              {
                link: (c) => (
                  <Link
                    href="/pricing"
                    onClick={() => track("lp_pricing_click")}
                    className="text-primary hover:underline"
                  >
                    {c}
                  </Link>
                ),
              },
              { limits: lifelikeLimits },
            )}
          </p>
        </div>
        <HeroLoop />
      </section>

      {/* What Lifelike gives you */}
      <section
        data-testid="lifelike-points"
        className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-3 px-4 sm:gap-4 lg:grid-cols-4"
      >
        {points.map((p) => (
          <div key={p.title} className="rounded-xl border border-edge bg-card p-4 sm:p-5">
            <p.icon aria-hidden className="size-5 text-[#9db8ff]" />
            <p className="mt-3 font-semibold text-fg">{p.title}</p>
            <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
              {p.detail}
            </p>
          </div>
        ))}
      </section>

      <WorksWith />

      {/* Three steps */}
      <section className="mx-auto mt-14 grid w-full max-w-6xl gap-6 px-4 sm:grid-cols-3">
        {[
          {
            t: t("landing.steps.uploadTitle"),
            s: t("landing.steps.uploadDetail", { limits: lifelikeLimits }),
          },
          {
            t: t("landing.steps.previewTitle"),
            s: t("landing.steps.previewDetail"),
          },
          { t: t("landing.steps.makeTitle"), s: t("landing.steps.makeDetail") },
        ].map((st, i) => (
          <div key={st.t} className="flex items-start gap-3.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-edge text-xs text-fg-muted">
              {i + 1}
            </span>
            <div>
              <p className="font-medium text-fg">{st.t}</p>
              <p data-testid={`hero-step-${i + 1}`} className="mt-1 text-sm text-fg-muted">
                {st.s}
              </p>
            </div>
          </div>
        ))}
      </section>

      <Samples />

      {/* How it looks: real screenshots of the web app */}
      <section
        id="how-it-looks"
        className="mx-auto w-full max-w-6xl scroll-mt-16 px-4 py-16"
      >
        <SectionHead
          eyebrow={t("landing.sections.howItLooksEyebrow")}
          title={t("landing.sections.howItLooksTitle")}
        />
        <div className="mt-10">
          <ProductTour />
        </div>
      </section>

      {/* What happens to your video */}
      <section className="border-y border-edge bg-card/50">
        <div className="mx-auto w-full max-w-6xl px-4 py-16">
          <SectionHead
            eyebrow={t("landing.sections.stepByStepEyebrow")}
            title={t("landing.sections.stepByStepTitle")}
          />
          <div className="mt-10">
            <PipelineSteps />
          </div>
        </div>
      </section>

      {/* Where to watch */}
      <section id="formats" className="mx-auto w-full max-w-6xl px-4 py-16">
        <SectionHead
          eyebrow={t("landing.sections.watchEyebrow")}
          title={t("landing.sections.watchTitle")}
          lede={t("landing.sections.watchLede")}
        />
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {formats(t).map((format) => (
            <div
              key={format.title}
              className="rounded-lg border border-edge bg-card p-5"
            >
              <p className="font-mono text-[11px] tracking-wide text-primary uppercase">
                {format.tag}
              </p>
              <p className="mt-2 font-medium text-fg">{format.title}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
                {format.detail}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Final CTA (mock 12) */}
      <section className="mx-auto w-full max-w-6xl px-4 py-20 text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-balance">
          {t("landing.final.title")}
        </h2>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <Link
            href={ctaHref}
            onClick={() => track("lp_cta_bottom_click", { signed_in: signedIn })}
            className="rounded-lg bg-primary px-6 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary/80"
          >
            {t("landing.final.cta")}
          </Link>
        </div>
        <p data-testid="teams-line" className="mt-5 text-sm text-fg-muted">
          {rich(
            t,
            "landing.final.teams",
            {
              link: (c) => (
                <Link
                  href="/pricing"
                  onClick={() => track("lp_teams_click")}
                  className="text-primary hover:underline"
                >
                  {c}
                </Link>
              ),
            },
            { business: "Business", studio: "Studio" },
          )}
        </p>
        <p className="mt-8 text-xs text-fg-muted">
          {rich(t, "landing.final.feedback", {
            button: (c) => (
              <button
                type="button"
                onClick={() => {
                  track("lp_feedback_click");
                  openFeedback();
                }}
                className="text-primary hover:underline"
              >
                {c}
              </button>
            ),
          })}
        </p>
      </section>

      {/* Footer */}
      <footer className="border-t border-edge">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-8 text-xs text-fg-muted">
          <p className="flex items-center gap-2">
            <AppIcon className="size-5" />
            <span>
              {rich(t, "landing.footer.byline", {
                brand: () => (
                  <>
                    Spatial Video <span className="text-primary">Studio</span>
                  </>
                ),
              })}
            </span>
          </p>
          <div className="flex items-center gap-4">
            <Link href="/privacy" className="transition-colors hover:text-fg">
              {t("landing.footer.privacy")}
            </Link>
            <Link href="/terms" className="transition-colors hover:text-fg">
              {t("landing.footer.terms")}
            </Link>
            <button type="button" onClick={openFeedback} className="transition-colors hover:text-fg">
              {t("landing.footer.feedback")}
            </button>
            <LanguagePicker />
          </div>
          <p>{t("landing.footer.copyright", { year: String(new Date().getFullYear()) })}</p>
        </div>
      </footer>
    </div>
  );
}
