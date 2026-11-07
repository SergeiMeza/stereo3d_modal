"use client";

/**
 * "Works with" (S3D-51): an animated row of device names with simple
 * outline icons (CSS only, globals.css .works-*). The device links are in
 * an sr-only list for search engines and screen readers; the scrolling
 * track, drawn twice for a seamless loop, is aria-hidden.
 */

import Link from "next/link";
import type { JSX } from "react";

import { DEVICE_PAGES, WORKS_WITH, type DeviceIcon } from "@/lib/devices";
import { useT } from "@/lib/i18n/I18nProvider";

const ICONS: Record<DeviceIcon, JSX.Element> = {
  visor: (
    <path d="M3 10.5C3 8 5 7 12 7s9 1 9 3.5v2c0 2.8-1.8 4.5-4.2 4.5-2.1 0-3-1.6-4.8-1.6S9.3 17 7.2 17C4.8 17 3 15.3 3 12.5v-2Z" />
  ),
  galaxy: (
    <>
      <path d="M3 9.5h18v5.5a2 2 0 0 1-2 2h-3.5l-2-2h-3l-2 2H5a2 2 0 0 1-2-2V9.5Z" />
      <path d="M5 9.5 7 7h10l2 2.5" />
    </>
  ),
  quest: (
    <>
      <rect x="3" y="7" width="18" height="10" rx="4" />
      <circle cx="8" cy="12" r="1.5" />
      <circle cx="16" cy="12" r="1.5" />
    </>
  ),
  pico: (
    <>
      <rect x="3" y="7" width="18" height="10" rx="3" />
      <path d="M8 17v2h8v-2" />
    </>
  ),
  frame: (
    <>
      <rect x="3" y="8" width="18" height="9" rx="2" />
      <path d="M3 12h18" />
    </>
  ),
  glasses: (
    <>
      <circle cx="7" cy="13" r="3.5" />
      <circle cx="17" cy="13" r="3.5" />
      <path d="M10.5 13c.5-1 2.5-1 3 0M3.5 12 2 8M20.5 12 22 8" />
    </>
  ),
  tv: (
    <>
      <rect x="3" y="5" width="18" height="12" rx="1.5" />
      <path d="M8 20h8" />
    </>
  ),
};

function Item({ label, icon, soon }: { label: string; icon: DeviceIcon; soon?: boolean }) {
  return (
    <span
      className={`flex items-center gap-2.5 whitespace-nowrap ${
        soon ? "text-[13px] text-fg-muted" : "text-[15px] text-fg/80"
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-6 fill-none stroke-fg-muted"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {ICONS[icon]}
      </svg>
      {label}
    </span>
  );
}

export function WorksWith(): JSX.Element {
  const t = useT();
  return (
    <section
      aria-labelledby="works-with-title"
      data-testid="works-with"
      className="mx-auto mt-14 w-full max-w-6xl px-4"
    >
      <p
        id="works-with-title"
        className="mb-4 text-center text-xs tracking-wider text-fg-muted uppercase"
      >
        {t("landing.worksWith.title")}
      </p>
      <ul className="sr-only" data-testid="works-with-links">
        {DEVICE_PAGES.map((d) => (
          <li key={d.slug}>
            <Link href={`/devices/${d.slug}`}>
              {d.upcoming ? t("landing.worksWith.upcoming", { name: d.name, upcoming: d.upcoming }) : d.name}
            </Link>
          </li>
        ))}
        <li>{t("landing.worksWith.tvs")}</li>
      </ul>
      <div className="works-marquee" aria-hidden="true" data-testid="works-with-track">
        <div className="works-track">
          {[false, true].map((dup) => (
            <div key={String(dup)} className="works-set" data-dup={dup ? "" : undefined}>
              {WORKS_WITH.map((w) => (
                <Item key={w.label} label={w.label} icon={w.icon} soon={w.soon} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
