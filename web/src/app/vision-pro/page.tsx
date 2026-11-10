/**
 * /vision-pro — the web app introduced for Apple Vision Pro (owner
 * 2026-11-10), where the Spatial Video Studio headset app links instead of
 * /app. The visitor already wears the headset, so the page names no other
 * one and lets the samples speak: Vision Pro Safari plays spatial video in
 * 3D in full screen, so each sample opens there (components/visionPro).
 * Like /app it introduces and sells nothing: no prices, no plan links,
 * one button straight into the app: /projects when signed in, /signin
 * otherwise (owner 2026-11-11: not the landing page). Public and indexed.
 *
 * The app adds utm_source/medium/campaign/content/term; the button's event
 * carries utm_content and utm_term, as on /app.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { OpenWebAppButton } from "@/components/appIntro/OpenWebAppButton";
import { NotVisionProNote } from "@/components/visionPro/NotVisionProNote";
import { SpatialSample } from "@/components/visionPro/SpatialSample";
import { METHOD_NAMES } from "@/lib/glossary";
import { rich } from "@/lib/i18n/rich";
import { getServerTr } from "@/lib/i18n/server";
import { EN, type Tr } from "@/lib/i18n/t";
import { samples } from "@/lib/samples";
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

/** The landscape samples, calmest first: these open full screen in 3D. */
export const VISION_PRO_SAMPLES = [
  "river-stones",
  "rooftop-party",
  "sunset-session",
  "studio-take",
  "fencing-hall",
  "inside-the-wave",
] as const;

const STEPS = ["signIn", "add", "watch"] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await requestTr();
  const title = t("visionPro.meta.title", { lifelike: METHOD_NAMES.lifelike });
  const description = t("visionPro.meta.description", {
    lifelike: METHOD_NAMES.lifelike,
    app: SITE_NAME,
  });
  return {
    title,
    description,
    alternates: { canonical: "/vision-pro" },
    openGraph: { title, description, url: "/vision-pro" },
    twitter: { title, description },
  };
}

export default async function VisionProPage() {
  const t = await requestTr();
  const lifelike = METHOD_NAMES.lifelike;
  const b = (c: ReactNode) => <b className="font-semibold text-fg">{c}</b>;
  const all = samples(t);
  const shown = VISION_PRO_SAMPLES.map((slug) =>
    all.find((s) => s.slug === slug),
  ).filter((s): s is NonNullable<typeof s> => s !== undefined);
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-4 py-14 sm:py-20">
      <div className="flex max-w-2xl flex-col gap-3">
        <p className="text-xs font-medium tracking-widest text-primary uppercase">
          {t("visionPro.eyebrow", { site: SITE_NAME })}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          {t("visionPro.title")}
        </h1>
        <p className="text-base leading-relaxed text-fg-muted">
          {t("visionPro.lede", { lifelike })}
        </p>
      </div>
      <section
        aria-labelledby="vision-pro-samples"
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1">
          <h2
            id="vision-pro-samples"
            className="text-lg font-semibold tracking-tight"
          >
            {t("visionPro.samplesTitle")}
          </h2>
          <p className="text-sm text-fg-muted">
            {t("visionPro.samplesHint", { lifelike })}
          </p>
        </div>
        <NotVisionProNote text={t("visionPro.notVisionPro")} />
        <ul className="grid gap-6 sm:grid-cols-2">
          {shown.map((s) => (
            <SpatialSample
              key={s.slug}
              slug={s.slug}
              title={s.title}
              poster={s.poster}
              src={s.downloads.find((d) => d.kind === "spatial")?.href ?? ""}
              watchLabel={t("visionPro.watch")}
            />
          ))}
        </ul>
      </section>
      <section
        aria-labelledby="vision-pro-steps"
        className="flex max-w-2xl flex-col gap-3"
      >
        <h2
          id="vision-pro-steps"
          className="text-lg font-semibold tracking-tight"
        >
          {t("visionPro.stepsTitle")}
        </h2>
        <ol className="flex flex-col gap-3">
          {STEPS.map((key) => (
            <li
              key={key}
              className="rounded-xl border border-edge bg-card p-4 text-base leading-relaxed text-fg-muted"
            >
              {rich(
                t,
                `visionPro.steps.${key}`,
                { b },
                { app: SITE_NAME, lifelike },
              )}
            </li>
          ))}
        </ol>
      </section>
      <div className="flex max-w-2xl flex-col gap-3">
        <OpenWebAppButton label={t("visionPro.cta")} start />
      </div>
    </main>
  );
}
