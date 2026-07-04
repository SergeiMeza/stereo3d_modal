/**
 * Faux-browser chrome around landing screenshots: dark card, three window
 * dots. Two display modes: pass `dims` (the asset's intrinsic size) to
 * show the full screenshot at its natural aspect — used by the workflow
 * tabs so nothing is cut off — or omit it for a fixed-aspect top crop
 * (the hero, where a cinematic ratio matters more than completeness).
 * Pure presentation.
 */

import Image from "next/image";

export function BrowserFrame({
  src,
  alt,
  priority = false,
  aspect = "aspect-[16/10]",
  sizes = "(max-width: 1024px) 100vw, 960px",
  dims,
}: {
  src: string;
  alt: string;
  priority?: boolean;
  aspect?: string;
  sizes?: string;
  /** Intrinsic asset size; when set, the full image renders uncropped. */
  dims?: { width: number; height: number };
}) {
  return (
    <figure className="overflow-hidden rounded-xl border border-edge bg-card shadow-2xl shadow-black/40">
      <div className="flex items-center gap-1.5 border-b border-edge px-3.5 py-2.5">
        <span className="size-2.5 rounded-full bg-secondary" />
        <span className="size-2.5 rounded-full bg-secondary" />
        <span className="size-2.5 rounded-full bg-secondary" />
      </div>
      {dims ? (
        <Image
          src={src}
          alt={alt}
          width={dims.width}
          height={dims.height}
          priority={priority}
          sizes={sizes}
          className="h-auto w-full"
        />
      ) : (
        <div className={`relative ${aspect}`}>
          <Image
            src={src}
            alt={alt}
            fill
            priority={priority}
            sizes={sizes}
            className="object-cover object-top"
          />
        </div>
      )}
    </figure>
  );
}
