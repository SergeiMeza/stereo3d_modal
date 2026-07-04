"use client";

/**
 * Landing / product page. Signed-in users still see it (no forced
 * redirect); only the CTA changes: "Open studio" into /projects when a
 * session exists (or in mock mode), "Start converting" → /signin
 * otherwise. Requirements and copy rules live in web/docs/LANDING.md —
 * notably: no internal pipeline terms, no fabricated proof, no dollar
 * amounts (the quote UI is the price).
 */

import {
  BadgeCheck,
  Clapperboard,
  Crosshair,
  MessageSquare,
  ReceiptText,
  Sparkles,
  Waves,
} from "lucide-react";
import Link from "next/link";

import { FEEDBACK_EMAIL } from "@/components/FeedbackLink";
import { BrowserFrame } from "@/components/landing/BrowserFrame";
import { WorkflowTabs } from "@/components/landing/WorkflowTabs";
import { useAuth } from "@/lib/auth";

const DEVICES = [
  "Apple Vision Pro",
  "Samsung Galaxy XR",
  "Meta Quest",
  "3D TVs & players",
];

const QUALITY = [
  {
    icon: Waves,
    title: "No flicker",
    detail:
      "Depth is estimated by a video-native model that stays consistent across the whole shot — no per-frame shimmer, no swimming backgrounds.",
  },
  {
    icon: Clapperboard,
    title: "Scene-aware stereo",
    detail:
      "Depth resets exactly at your scene cuts, and each shot gets its own depth treatment under a viewing-comfort budget — bold 3D that's still easy on the eyes.",
  },
  {
    icon: Sparkles,
    title: "Clean edges",
    detail:
      "The areas a new viewpoint reveals are filled by video inpainting that understands motion — not stretched or smeared pixels around every silhouette.",
  },
  {
    icon: Crosshair,
    title: "Frame-exact control",
    detail:
      "Cuts, trims and per-scene overrides are integer frame indices, never timestamps. What you set is exactly what renders.",
  },
];

const FORMATS = [
  {
    tag: "MV-HEVC · .mov",
    title: "Apple spatial video",
    detail:
      "Native spatial video for Apple Vision Pro — it lands in Photos with the Spatial badge. Also plays on Android XR headsets like Samsung Galaxy XR.",
  },
  {
    tag: "SBS · Half-SBS",
    title: "Side-by-side",
    detail:
      "The universal VR format: Meta Quest video players, YouTube VR, 3D TVs and projectors.",
  },
  {
    tag: "TB · Half-TB",
    title: "Top-bottom",
    detail: "For displays and players that expect over-under 3D.",
  },
  {
    tag: "Red-cyan",
    title: "Anaglyph",
    detail:
      "An instant 3D check on any flat screen with a pair of paper glasses.",
  },
];

const PRICING = [
  {
    icon: BadgeCheck,
    title: "No subscription",
    detail:
      "Put a card on file and pay per job. No seats, no monthly minimum, nothing to cancel.",
  },
  {
    icon: ReceiptText,
    title: "A binding quote before every render",
    detail:
      "Every paid job shows its exact price before it starts — and that quote is what you're charged. No surprise compute bills.",
  },
  {
    icon: Sparkles,
    title: "Preview cheap, render once",
    detail:
      "Dial in depth and stereo on fast low-res previews. The production render reuses the work you already approved and discounts it from the price.",
  },
];

export default function Home() {
  const { user } = useAuth();
  const signedIn = user !== null;

  return (
    <div className="w-full">
      {/* Hero */}
      <section className="relative mx-auto w-full max-w-6xl px-4 pt-16 pb-12 sm:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          <p className="inline-flex items-center gap-2 rounded-full border border-edge bg-card px-3 py-1 text-xs text-fg-muted">
            2D → 3D conversion studio
            <span className="rounded-full border border-primary/40 px-1.5 py-px text-[10px] font-medium tracking-wide text-primary uppercase">
              Beta
            </span>
          </p>
          <h1 className="mt-5 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            VFX-studio 3D,{" "}
            <span className="text-primary">without the VFX studio</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-fg-muted sm:text-lg">
            Upload a video, direct the depth scene by scene, and deliver true
            stereoscopic 3D to every headset — at a fraction of what a VFX
            house charges.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={signedIn ? "/projects" : "/signin"}
              className="rounded-lg bg-primary px-6 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary/80"
            >
              {signedIn ? "Open studio" : "Start converting"}
            </Link>
            <a
              href="#workflow"
              className="rounded-lg border border-edge bg-card px-6 py-3 font-medium text-fg transition-colors hover:border-primary/40"
            >
              See how it works
            </a>
          </div>
          <p className="mt-8 font-mono text-[11px] tracking-wide text-fg-muted uppercase">
            {DEVICES.join("  ·  ")}
          </p>
        </div>

        <div className="relative mx-auto mt-14 max-w-5xl">
          <div
            aria-hidden
            className="absolute -inset-x-8 -top-10 h-64 rounded-full bg-primary/10 blur-3xl"
          />
          <div className="relative">
            <BrowserFrame
              src="/landing/stereo-tab.webp"
              alt="Stereo3D Studio's Stereo page: source footage beside its live depth map, with per-scene 3D classification and overrides"
              priority
              aspect="aspect-[16/9]"
              sizes="(max-width: 1024px) 100vw, 1024px"
            />
          </div>
        </div>
      </section>

      {/* Workflow */}
      <section
        id="workflow"
        className="mx-auto w-full max-w-6xl scroll-mt-16 px-4 py-16"
      >
        <h2 className="text-xs font-medium tracking-widest text-primary uppercase">
          How it works
        </h2>
        <p className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight text-balance">
          Your video, directed by you
        </p>
        <p className="mt-3 max-w-2xl text-fg-muted">
          A real studio workflow — five focused rooms, from first frame to
          final file. These are live screenshots, not mockups.
        </p>
        <div className="mt-8">
          <WorkflowTabs />
        </div>
      </section>

      {/* Quality */}
      <section className="border-y border-edge bg-card/50">
        <div className="mx-auto w-full max-w-6xl px-4 py-16">
          <h2 className="text-xs font-medium tracking-widest text-primary uppercase">
            Quality
          </h2>
          <p className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight text-balance">
            Why it looks like a studio did it
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {QUALITY.map((item) => (
              <div
                key={item.title}
                className="rounded-lg border border-edge bg-card p-5"
              >
                <item.icon aria-hidden className="size-5 text-primary" />
                <p className="mt-3 font-medium text-fg">{item.title}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
                  {item.detail}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Formats × devices */}
      <section id="formats" className="mx-auto w-full max-w-6xl px-4 py-16">
        <h2 className="text-xs font-medium tracking-widest text-primary uppercase">
          Delivery
        </h2>
        <p className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight text-balance">
          Deliver to every headset
        </p>
        <p className="mt-3 max-w-2xl text-fg-muted">
          One conversion, every format your audience needs — with the source
          audio carried through.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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

      {/* Pricing */}
      <section className="border-y border-edge bg-card/50">
        <div
          id="pricing"
          className="mx-auto w-full max-w-6xl scroll-mt-16 px-4 py-16"
        >
          <h2 className="text-xs font-medium tracking-widest text-primary uppercase">
            Pricing
          </h2>
          <p className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight text-balance">
            Pay for renders, not seats
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {PRICING.map((item) => (
              <div
                key={item.title}
                className="rounded-lg border border-edge bg-card p-5"
              >
                <item.icon aria-hidden className="size-5 text-primary" />
                <p className="mt-3 font-medium text-fg">{item.title}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
                  {item.detail}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Beta + CTA */}
      <section className="mx-auto w-full max-w-6xl px-4 py-16">
        <div className="rounded-xl border border-edge bg-card p-8 text-center sm:p-12">
          <h2 className="text-2xl font-semibold tracking-tight text-balance">
            In beta — help us shape it
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-fg-muted">
            During the beta, sources can be up to 5 minutes long and below 4K
            resolution. Something missing, broken, or worth building? Tell us —
            we read everything.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={signedIn ? "/projects" : "/signin"}
              className="rounded-lg bg-primary px-6 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary/80"
            >
              {signedIn ? "Open studio" : "Start converting"}
            </Link>
            <a
              href={`mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent("Stereo3D Studio feedback")}`}
              className="flex items-center gap-2 rounded-lg border border-edge bg-background px-6 py-3 font-medium text-fg transition-colors hover:border-primary/40"
            >
              <MessageSquare aria-hidden className="size-4" />
              Send feedback
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-edge">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-8 text-xs text-fg-muted">
          <p>
            Stereo3D <span className="text-primary">Studio</span> · a Spatial
            AI Labs Ltd product
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
