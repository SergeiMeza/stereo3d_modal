/**
 * /devices/<slug> — one short static page per headset or pair of glasses
 * (S3D-51): which file to choose, how to open it, one button. Built at
 * build time from lib/devices; unknown slugs are 404s.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DEVICE_PAGES, devicePage } from "@/lib/devices";

export const dynamicParams = false;

export function generateStaticParams(): { slug: string }[] {
  return DEVICE_PAGES.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const d = devicePage((await params).slug);
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
  const d = devicePage((await params).slug);
  if (!d) notFound();
  const others = DEVICE_PAGES.filter((o) => o.slug !== d.slug);
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-14 sm:py-20">
      <div className="flex flex-col gap-3">
        <p className="text-xs font-medium tracking-widest text-primary uppercase">
          {d.upcoming ? `Ready for ${d.name}` : `Works with ${d.name}`}
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
      <div>
        <Link
          href="/projects"
          className="inline-block rounded-lg bg-primary px-6 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary/80"
        >
          Make your video 3D
        </Link>
      </div>
      <nav aria-label="Other devices" className="border-t border-edge pt-6 text-sm text-fg-muted">
        <span className="mr-2">Also:</span>
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
