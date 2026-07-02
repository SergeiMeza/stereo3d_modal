"use client";

/**
 * Landing / onboarding. Signed-in users still see the landing (no forced
 * redirect — it doubles as the product page); only the CTA changes: "Open
 * studio" into /projects when a session exists (or in mock mode), "Sign in
 * to start" otherwise. Client component because the CTA depends on auth
 * state; everything else is static copy in the studio's badge/border
 * vocabulary.
 */

import Link from "next/link";

import { useAuth } from "@/lib/auth";

const STEPS: { title: string; detail: string }[] = [
  { title: "Upload", detail: "Drop any video — multi-GB sources welcome." },
  {
    title: "Cut scenes",
    detail: "Review auto-detected cuts, frame-accurate.",
  },
  {
    title: "Tune depth",
    detail: "Fast depth previews with adjustable strength.",
  },
  {
    title: "Preview stereo",
    detail: "Check the 3D effect before the full render.",
  },
  {
    title: "Deliver",
    detail: "MV-HEVC for Vision Pro, SBS for VR headsets.",
  },
];

export default function Home() {
  const { user } = useAuth();
  const signedIn = user !== null;

  return (
    <section className="mx-auto w-full max-w-5xl space-y-12 px-4 py-16">
      <div className="max-w-2xl space-y-4">
        <p className="inline-flex rounded-full border border-edge bg-surface-1 px-3 py-1 text-xs text-fg-muted">
          Professional 2D→3D conversion
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Stereo3D <span className="text-primary">Studio</span>
        </h1>
        <p className="text-base text-fg-muted">
          Turn any video into immersive stereoscopic 3D — scene-aware depth,
          professional controls, pay per conversion.
        </p>
        <Link
          href={signedIn ? "/projects" : "/signin"}
          className="inline-flex rounded-lg bg-primary px-5 py-2.5 font-medium text-primary-foreground transition-colors hover:bg-primary/80"
        >
          {signedIn ? "Open studio" : "Sign in to start"}
        </Link>
      </div>

      <div>
        <h2 className="text-xs font-medium tracking-widest text-fg-muted uppercase">
          How it works
        </h2>
        <ol className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map((step, i) => (
            <li
              key={step.title}
              className="rounded-lg border border-edge bg-surface-1 p-4"
            >
              <span className="font-mono text-xs text-primary">
                {String(i + 1).padStart(2, "0")}
              </span>
              <p className="mt-2 font-medium text-fg">{step.title}</p>
              <p className="mt-1 text-xs text-fg-muted">{step.detail}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
