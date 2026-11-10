/**
 * /app — the introduction the Spatial Video Studio apps (Mac, iPhone and
 * iPad, Apple Vision Pro) open in the browser (WEB-02, owner 2026-11-10;
 * ADR 0146 in the SVS repo). From 10.6.0 the apps stop converting in the
 * cloud and link here instead. App Review wants that link to introduce,
 * not sell: what the web app is, where it works, the same account, one
 * button to /. No prices, no plan links. Public and indexed; a signed-in
 * visitor sees the same page.
 *
 * The apps add utm_source/medium/campaign/content/term; nothing here takes
 * them off the address (Vercel Analytics reads them), and the button's
 * event carries utm_content and utm_term. Where it works follows
 * lib/headset: 3D in full screen in Vision Pro Safari, side by side once
 * the viewer picks it in the browser's own player, downloads everywhere.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { OpenWebAppButton } from "@/components/appIntro/OpenWebAppButton";
import { LoopVideo } from "@/components/landing/LoopVideo";
import { METHOD_NAMES } from "@/lib/glossary";
import { rich } from "@/lib/i18n/rich";
import { getServerTr } from "@/lib/i18n/server";
import { EN, type Tr } from "@/lib/i18n/t";
import { SITE_NAME } from "@/lib/site";

/** The request's translator; English in unit tests, which render this
 * page outside a request (anywhere else the error goes on to Next). */
async function requestTr(): Promise<Tr> {
  try {
    return await getServerTr();
  } catch (e) {
    if (process.env.NODE_ENV !== "test") throw e;
    return EN;
  }
}

const WHERE = ["visionPro", "sideBySide", "computer", "download"] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await requestTr();
  const title = t("appIntro.meta.title", { lifelike: METHOD_NAMES.lifelike });
  const description = t("appIntro.meta.description", {
    lifelike: METHOD_NAMES.lifelike,
    app: SITE_NAME,
  });
  return {
    title,
    description,
    alternates: { canonical: "/app" },
    openGraph: { title, description, url: "/app" },
    twitter: { title, description },
  };
}

export default async function AppIntroPage() {
  const t = await requestTr();
  const lifelike = METHOD_NAMES.lifelike;
  const b = (c: ReactNode) => <b className="font-semibold text-fg">{c}</b>;
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-14 sm:py-20">
      <div className="flex flex-col gap-3">
        <p className="text-xs font-medium tracking-widest text-primary uppercase">
          {t("appIntro.eyebrow", { site: SITE_NAME })}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          {t("appIntro.title")}
        </h1>
        <p className="text-base leading-relaxed text-fg-muted">
          {t("appIntro.lede", { lifelike })}
        </p>
      </div>
      {/* the landing hero's 2D → 3D reveal (HeroLoop's clip and labels),
          without its link to the landing's samples; the clip isn't
          mirrored in Arabic, so its labels sit on physical sides */}
      <figure>
        <div className="ll-edge overflow-hidden rounded-2xl p-px">
          <div
            data-testid="app-intro-loop"
            className="relative aspect-video w-full overflow-hidden rounded-2xl bg-black"
          >
            <LoopVideo
              base="/landing/hero/sunset-session-2d-3d"
              label={t("landing.heroLoop.label", { method: lifelike })}
              className="absolute inset-0 h-full w-full object-cover"
            />
            <span className="pointer-events-none absolute top-3 left-3 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white">
              {t("landing.heroLoop.yourVideo")}
            </span>
            <span className="pointer-events-none absolute top-3 right-3 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white">
              {lifelike}
            </span>
          </div>
        </div>
        <figcaption className="mt-3 text-xs text-fg-muted">
          {t("appIntro.beforeAfter", { lifelike })}
        </figcaption>
      </figure>
      <section aria-labelledby="app-intro-where" className="flex flex-col gap-3">
        <h2 id="app-intro-where" className="text-lg font-semibold tracking-tight">
          {t("appIntro.whereTitle")}
        </h2>
        <ul className="flex flex-col gap-3">
          {WHERE.map((key) => (
            <li
              key={key}
              className="rounded-xl border border-edge bg-card p-4 text-base leading-relaxed text-fg-muted"
            >
              {rich(t, `appIntro.where.${key}`, { b })}
            </li>
          ))}
        </ul>
      </section>
      <div className="flex flex-col gap-3">
        <p className="text-base leading-relaxed text-fg">
          {t("appIntro.account", { app: SITE_NAME })}
        </p>
        <OpenWebAppButton label={t("appIntro.cta")} />
      </div>
    </main>
  );
}
