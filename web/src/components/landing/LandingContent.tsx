"use client";

/**
 * Landing / product page body (mock 12, S3D-46): the hero leads with
 * Lifelike 3D, our newest 3D technology, then three benefits, the devices,
 * three steps, the studio tour, and one closing "See prices". Client
 * because the CTA depends on auth state ("Make your first 3D video" goes
 * to /projects with a session, /signin otherwise) and the "from $X a
 * minute" / preview prices come from GET /v1/pricing — never hardcoded. The route itself (app/page.tsx) is
 * a server component so it can carry per-page metadata and JSON-LD.
 * Requirements and copy rules live in web/docs/LANDING.md — notably: no
 * internal pipeline terms (S3D-36: no model names, depth maps, warping or
 * inpainting), no fabricated proof, videos only (S3D-09). Prices live on
 * /pricing (S3D-18), linked from here.
 */

import { Clock, Layers, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import Link from "next/link";

import { FEEDBACK_EMAIL } from "@/components/FeedbackLink";
import { PipelineSteps } from "@/components/landing/PipelineSteps";
import { WorkflowTabs } from "@/components/landing/WorkflowTabs";
import { Logo } from "@/components/Logo";
import { track } from "@/lib/analytics";
import { useAuth } from "@/lib/auth";
import { formatCents, formatCentsShort } from "@/components/steps/money";
import { fromPerMinute, usePricing } from "@/lib/api/usePricing";
import { FORMAT_NAMES } from "@/lib/glossary";

const DEVICES = ["Apple Vision Pro", "Meta Quest", "Pico", "3D TVs"];

const BENEFITS = [
  {
    icon: Layers,
    title: "Natural depth",
    detail: "Every moment rebuilt as a real 3D scene.",
  },
  {
    icon: Sparkles,
    title: "Clean edges",
    detail: "Clean outlines, even around fast motion.",
  },
  {
    icon: Clock,
    title: "Ready in minutes",
    detail: "Minutes, not hours, for most videos.",
  },
];

// Names from the glossary (S3D-37); top-bottom isn't sold (S3D-08).
const FORMATS = [
  {
    tag: ".mov",
    title: FORMAT_NAMES.mvhevc,
    detail:
      "Native spatial video for Apple Vision Pro — it lands in Photos with the Spatial badge. Also plays on Android XR headsets like Samsung Galaxy XR.",
  },
  {
    tag: ".mp4",
    title: `${FORMAT_NAMES.sbs} · ${FORMAT_NAMES.half_sbs}`,
    detail:
      "The universal VR format: Meta Quest and Pico video players, YouTube VR, 3D TVs and projectors.",
  },
  {
    tag: "Classic 3D",
    title: FORMAT_NAMES.anaglyph,
    detail:
      "An instant 3D check on any flat screen with a pair of paper glasses.",
  },
];

/** true when the viewer asked for less motion: the hero clip then waits
 * for a click instead of looping. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

export function LandingContent() {
  const { user } = useAuth();
  const signedIn = user !== null;
  const pricing = usePricing();
  const perMinute = pricing ? fromPerMinute(pricing) : null;
  const reducedMotion = usePrefersReducedMotion();

  return (
    <div className="w-full">
      {/* Hero (mock 12, S3D-46): leads with Lifelike 3D */}
      <section className="relative mx-auto grid w-full max-w-6xl items-center gap-10 px-4 pt-14 pb-12 sm:pt-20 lg:grid-cols-[1fr_1.15fr] lg:gap-14">
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 right-0 h-[420px] w-[620px] max-w-full rounded-full bg-[radial-gradient(closest-side,rgb(79_140_255/0.18),rgb(167_139_250/0.08)_60%,transparent)] blur-md"
        />
        <div className="relative">
          <p className="flex flex-wrap items-center gap-2.5">
            <span className="ll-tag-new">New</span>
            <span data-testid="hero-eyebrow" className="ll-eyebrow !text-xs">
              Lifelike 3D · our newest 3D technology
            </span>
          </p>
          <h1 className="mt-4 text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl lg:text-[56px]">
            Turn any video into{" "}
            <span className="bg-gradient-to-r from-fg via-[#b9c8ff] to-[#a7f3ea] bg-clip-text text-transparent">
              lifelike 3D
            </span>
          </h1>
          <p className="mt-5 max-w-md text-base leading-relaxed text-fg-muted sm:text-lg">
            Our newest 3D technology rebuilds every moment as a real 3D scene.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-4">
            <Link
              href={signedIn ? "/projects" : "/signin"}
              onClick={() => track("lp_cta_hero_click", { signed_in: signedIn })}
              className="rounded-lg bg-primary px-6 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary/80"
            >
              Make your first 3D video
            </Link>
            {perMinute !== null ? (
              <span data-testid="hero-from-price" className="text-fg-muted">
                from{" "}
                <b className="text-xl font-semibold text-fg">
                  {formatCentsShort(perMinute)}
                </b>{" "}
                a minute
              </span>
            ) : null}
          </div>
          <p className="mt-4 text-xs text-fg-muted">
            Any length, up to 4K.{" "}
            <Link
              href="/pricing"
              onClick={() => track("lp_pricing_click")}
              className="text-primary hover:underline"
            >
              See prices
            </Link>
          </p>
        </div>
        <figure className="relative">
          <div className="ll-edge overflow-hidden rounded-2xl p-px">
            <video
              autoPlay={!reducedMotion}
              controls={reducedMotion}
              loop
              muted
              playsInline
              preload="metadata"
              aria-label="A video made 3D, shown in red-cyan"
              src="/landing/steps/stereo.mp4"
              className="aspect-video w-full rounded-2xl bg-black object-cover"
            />
          </div>
          <figcaption className="mt-3 text-xs text-fg-muted">
            Red-cyan glasses show the depth.
          </figcaption>
        </figure>
      </section>

      {/* Benefits */}
      <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 sm:grid-cols-3">
        {BENEFITS.map((b) => (
          <div key={b.title} className="rounded-xl border border-edge bg-card p-5">
            <b.icon aria-hidden className="size-5 text-[#9db8ff]" />
            <p className="mt-3 font-semibold text-fg">{b.title}</p>
            <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
              {b.detail}
            </p>
          </div>
        ))}
      </section>

      {/* Devices */}
      <section
        aria-label="Watch on"
        className="mx-auto mt-12 flex w-full max-w-6xl flex-wrap items-center justify-center gap-x-9 gap-y-3 px-4 text-sm text-fg-muted"
      >
        <span className="text-xs tracking-wider uppercase">Watch on</span>
        {DEVICES.map((d) => (
          <span key={d} className="text-fg-muted">
            {d}
          </span>
        ))}
      </section>

      {/* Three steps */}
      <section className="mx-auto mt-14 grid w-full max-w-6xl gap-6 px-4 sm:grid-cols-3">
        {[
          { t: "Upload a video", s: "Any length, up to 4K." },
          {
            t: "Preview a moment",
            s:
              pricing !== null
                ? `A few seconds in 3D, from ${formatCents(pricing.minimum_cents)}.`
                : "A few seconds in 3D.",
          },
          { t: "Make it 3D", s: "Download for your headset." },
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

      {/* Workflow */}
      <section
        id="workflow"
        className="mx-auto w-full max-w-6xl scroll-mt-16 px-4 py-16"
      >
        <p className="text-xs font-medium tracking-widest text-primary uppercase">
          How it works
        </p>
        <h2 className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight text-balance">
          Your video, directed by you
        </h2>
        <p className="mt-3 max-w-2xl text-fg-muted">
          From first frame to final file. These are live screenshots, not
          mockups.
        </p>
        <div className="mt-8">
          <WorkflowTabs />
        </div>
      </section>

      {/* Pipeline */}
      <section className="border-y border-edge bg-card/50">
        <div className="mx-auto w-full max-w-6xl px-4 py-16">
          <p className="text-xs font-medium tracking-widest text-primary uppercase">
            Step by step
          </p>
          <h2 className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight text-balance">
            What happens to your video
          </h2>
          <p className="mt-3 max-w-2xl text-fg-muted">
            What a 3D conversion house does, done for you — shown here on real
            footage.
          </p>
          <div className="mt-10">
            <PipelineSteps />
          </div>
        </div>
      </section>

      {/* Formats × devices */}
      <section id="formats" className="mx-auto w-full max-w-6xl px-4 py-16">
        <p className="text-xs font-medium tracking-widest text-primary uppercase">
          Delivery
        </p>
        <h2 className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight text-balance">
          Deliver to every headset
        </h2>
        <p className="mt-3 max-w-2xl text-fg-muted">
          One conversion, every format your audience needs — with the source
          audio carried through.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {FORMATS.map((format) => (
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
          See your own video in 3D
        </h2>
        <p className="mt-2 text-fg-muted">Pay per video. No subscription.</p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/pricing"
            onClick={() => track("lp_cta_bottom_click", { signed_in: signedIn })}
            className="rounded-lg border border-edge bg-card px-6 py-3 font-medium text-fg transition-colors hover:border-primary/40"
          >
            See prices
          </Link>
        </div>
        <p className="mt-8 text-xs text-fg-muted">
          In beta. Something missing or broken?{" "}
          <a
            href={`mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent("Stereo3D Studio feedback")}`}
            onClick={() => track("lp_feedback_click")}
            className="text-primary hover:underline"
          >
            Tell us
          </a>
          .
        </p>
      </section>

      {/* Footer */}
      <footer className="border-t border-edge">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-8 text-xs text-fg-muted">
          <p className="flex items-center gap-2">
            <Logo className="size-4 text-fg" />
            <span>
              Stereo3D <span className="text-primary">Studio</span> · a
              Spatial AI Labs Ltd product
            </span>
          </p>
          <div className="flex items-center gap-4">
            <Link href="/privacy" className="transition-colors hover:text-fg">
              Privacy Policy
            </Link>
            <Link href="/terms" className="transition-colors hover:text-fg">
              Terms of Use
            </Link>
            <a
              href={`mailto:${FEEDBACK_EMAIL}`}
              className="transition-colors hover:text-fg"
            >
              {FEEDBACK_EMAIL}
            </a>
          </div>
          <p>© {new Date().getFullYear()} Spatial AI Labs Ltd</p>
        </div>
      </footer>
    </div>
  );
}
