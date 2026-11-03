/**
 * The hero's 2D → 3D reveal (2026-11, replaces the red-cyan before/after
 * stills): one looping clip from our own diner footage. Left of a gliding
 * line the flat original; right of it the same moment seen from a gently
 * swaying viewpoint, rendered from the real 3D scene, so the depth shows on
 * any screen without glasses. Poster only under reduced motion (LoopVideo).
 */

import { LoopVideo } from "@/components/landing/LoopVideo";

export function HeroLoop() {
  return (
    <figure className="relative">
      <div className="ll-edge overflow-hidden rounded-2xl p-px">
        <div
          data-testid="hero-loop"
          className="relative aspect-video w-full overflow-hidden rounded-2xl bg-black"
        >
          <LoopVideo
            base="/landing/hero/diner-2d-3d"
            label="A diner scene: on the left the 2D video, on the right the same moment in Lifelike 3D, its viewpoint gently swaying to show the depth"
            className="absolute inset-0 h-full w-full object-cover"
          />
          <span className="pointer-events-none absolute top-3 left-3 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white">
            Your video
          </span>
          <span className="pointer-events-none absolute top-3 right-3 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white">
            Lifelike 3D
          </span>
        </div>
      </div>
      <figcaption className="mt-3 text-xs text-fg-muted">
        The right side moves the way it will look in 3D.{" "}
        <a href="#samples" className="text-primary hover:underline">
          Watch it in your headset
        </a>
      </figcaption>
    </figure>
  );
}
