/**
 * /devices/<slug> — one short static page per headset or pair of glasses
 * (S3D-51): which file to choose, how to open it, one button. Built at
 * build time from lib/devices; unknown slugs are 404s.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DevicePrice } from "@/components/landing/DevicePrice";
import { DEVICE_PAGES, devicePage } from "@/lib/devices";
import { FirstTimeHint } from "@/components/onboarding/FirstTimeHint";
import { getServerTr } from "@/lib/i18n/server";
import { EN, type Tr } from "@/lib/i18n/t";
import { SITE_NAME } from "@/lib/site";

export const dynamicParams = false;

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

export function generateStaticParams(): { slug: string }[] {
  return DEVICE_PAGES.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const d = devicePage((await params).slug, await requestTr());
  if (!d) return {};
  return {
    title: d.title,
    description: d.description,
    alternates: { canonical: `/devices/${d.slug}` },
    openGraph: { title: d.title, description: d.description, url: `/devices/${d.slug}` },
  };
}

export default async function DevicePageRoute({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const t = await requestTr();
  const d = devicePage((await params).slug, t);
  if (!d) notFound();
  const others = DEVICE_PAGES.filter((o) => o.slug !== d.slug);
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-14 sm:py-20">
      <nav aria-label={t("common.devicePage.breadcrumbLabel")} className="text-xs text-fg-muted">
        <Link href="/" className="hover:text-fg">
          {SITE_NAME}
        </Link>{" "}
        / {t("common.devicePage.breadcrumbDevices")} / <span className="text-fg">{d.name}</span>
      </nav>
      <FirstTimeHint id="devices" />
      <div className="flex flex-col gap-3">
        <p className="text-xs font-medium tracking-widest text-primary uppercase">
          {d.upcoming
            ? t("common.devicePage.readyFor", { name: d.name })
            : t("common.devicePage.worksWith", { name: d.name })}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          {d.title}
        </h1>
      </div>
      <ol className="flex flex-col gap-3">
        {d.lines.map((line, i) => (
          <li key={line} className="flex items-start gap-3 text-fg">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-edge text-xs text-fg-muted">
              {i + 1}
            </span>
            <span className="leading-relaxed">{line}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/projects"
            className="inline-block rounded-lg bg-primary px-6 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary/80"
          >
            {t("common.devicePage.cta")}
          </Link>
          <DevicePrice />
        </div>
        {d.fileNote ? <p className="text-xs text-fg-muted">{d.fileNote}</p> : null}
      </div>
      <nav aria-label={t("common.devicePage.othersLabel")} className="border-t border-edge pt-6 text-sm text-fg-muted">
        <span className="mr-2">{t("common.devicePage.others")}</span>
        {others.map((o, i) => (
          <span key={o.slug}>
            {i > 0 ? " · " : ""}
            <Link href={`/devices/${o.slug}`} className="hover:text-fg">
              {o.name}
            </Link>
          </span>
        ))}
      </nav>
    </main>
  );
}
