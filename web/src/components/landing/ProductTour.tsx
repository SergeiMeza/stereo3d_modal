"use client";

/**
 * "How it looks" (2026-11): screenshots of the real web app — the projects
 * list, Make 3D with the quality options up to 8K, a run in progress and
 * the files per headset — captured in mock-gateway mode with the licensed
 * sample clips. From 640 px up: a tab strip and one large 2240×1400 shot
 * (big enough to read). On phones: every phone capture (780×1400) in a
 * horizontal snap row. Hidden images are lazy, so each viewport downloads
 * only its own. Re-shoot recipe: web/docs/LANDING.md, "Assets".
 */

import Image from "next/image";
import { useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";
import { SITE_NAME } from "@/lib/site";

interface Shot {
  id: string;
  label: string;
  detail: string;
  alt: string;
}

function shots(t: Tr = EN): Shot[] {
  return [
    {
      id: "projects",
      label: t("landing.tour.projectsLabel"),
      detail: t("landing.tour.projectsDetail"),
      alt: t("landing.tour.projectsAlt", { site: SITE_NAME }),
    },
    {
      id: "make-3d",
      label: t("landing.tour.make3dLabel"),
      detail: t("landing.tour.make3dDetail"),
      alt: t("landing.tour.make3dAlt"),
    },
    {
      id: "tracker",
      label: t("landing.tour.trackerLabel"),
      detail: t("landing.tour.trackerDetail"),
      alt: t("landing.tour.trackerAlt"),
    },
    {
      id: "files",
      label: t("landing.tour.filesLabel"),
      detail: t("landing.tour.filesDetail"),
      alt: t("landing.tour.filesAlt"),
    },
  ];
}

const FRAME =
  "overflow-hidden border border-edge bg-card shadow-2xl shadow-black/50";

export function ProductTour() {
  const t = useT();
  const list = shots(t);
  const [activeId, setActiveId] = useState(list[1].id);
  const active = list.find((s) => s.id === activeId) ?? list[0];

  return (
    <div data-testid="product-tour">
      {/* 640 px and up: tabs over one large shot */}
      <div className="hidden sm:block">
        <Tabs value={active.id} onValueChange={setActiveId} className="gap-0">
          <TabsList
            aria-label={t("landing.tour.ariaLabel")}
            className="flex h-auto flex-wrap gap-2 border-0 bg-transparent p-0"
          >
            {list.map((shot) => (
              <TabsTrigger
                key={shot.id}
                value={shot.id}
                className="rounded-md border border-edge bg-card px-3.5 py-2 text-sm text-fg-muted transition-colors hover:border-primary/40 hover:text-fg data-[state=active]:border-primary/60 data-[state=active]:bg-secondary data-[state=active]:text-fg data-[state=active]:shadow-none"
              >
                {shot.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={active.id} className="mt-5">
            <p className="text-fg-muted">{active.detail}</p>
            <div className={`mt-5 rounded-xl ${FRAME}`}>
              <Image
                key={active.id}
                src={`/landing/ui/${active.id}.webp`}
                alt={active.alt}
                width={2240}
                height={1400}
                sizes="(max-width: 1152px) 100vw, 1120px"
                className="block h-auto w-full"
              />
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* phones: every phone shot in a snap row */}
      <ul className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:hidden">
        {list.map((shot) => (
          <li
            key={shot.id}
            data-testid={`tour-${shot.id}`}
            className="w-[72%] max-w-[300px] shrink-0 snap-center"
          >
            <figure>
              <div className={`rounded-[22px] ${FRAME}`}>
                <Image
                  src={`/landing/ui/${shot.id}-phone.webp`}
                  alt={shot.alt}
                  width={780}
                  height={1400}
                  sizes="72vw"
                  className="block h-auto w-full"
                />
              </div>
              <figcaption className="mt-3">
                <p className="font-medium text-fg">{shot.label}</p>
                <p className="mt-1 text-sm text-fg-muted">{shot.detail}</p>
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </div>
  );
}
