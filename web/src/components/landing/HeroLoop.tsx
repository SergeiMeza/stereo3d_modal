/**
 * The hero's 2D → 3D reveal (2026-11, replaces the red-cyan before/after
 * stills): one looping clip from licensed footage (Sunset session, 2026-11). Left of a gliding
 * line the flat original; right of it the same moment seen from a gently
 * swaying viewpoint, rendered from the real 3D scene, so the depth shows on
 * any screen without glasses. Poster only under reduced motion (LoopVideo).
 */

"use client";

import { LoopVideo } from "@/components/landing/LoopVideo";
import { METHOD_NAMES } from "@/lib/glossary";
import { useT } from "@/lib/i18n/I18nProvider";
import { rich } from "@/lib/i18n/rich";

export function HeroLoop() {
  const t = useT();
  return (
    <figure className="relative">
      <div className="ll-edge overflow-hidden rounded-2xl p-px">
        <div
          data-testid="hero-loop"
          className="relative aspect-video w-full overflow-hidden rounded-2xl bg-black"
        >
          <LoopVideo
            base="/landing/hero/sunset-session-2d-3d"
            label={t("landing.heroLoop.label", { method: METHOD_NAMES.lifelike })}
            className="absolute inset-0 h-full w-full object-cover"
          />
          <span className="pointer-events-none absolute top-3 left-3 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white">
            {t("landing.heroLoop.yourVideo")}
          </span>
          <span className="pointer-events-none absolute top-3 right-3 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white">
            {METHOD_NAMES.lifelike}
          </span>
        </div>
      </div>
      <figcaption className="mt-3 text-xs text-fg-muted">
        {rich(t, "landing.heroLoop.caption", {
          link: (c) => (
            <a href="#samples" className="text-primary hover:underline">
              {c}
            </a>
          ),
        })}
      </figcaption>
    </figure>
  );
}
