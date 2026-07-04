/**
 * Faux-browser chrome around landing screenshots: dark card, three window
 * dots, and a fixed aspect crop (the app screenshots are full-page and
 * tall — the top region holds the interesting UI). Pure presentation.
 */

import Image from "next/image";

export function BrowserFrame({
  src,
  alt,
  priority = false,
  aspect = "aspect-[16/10]",
  sizes = "(max-width: 1024px) 100vw, 960px",
}: {
  src: string;
  alt: string;
  priority?: boolean;
  aspect?: string;
  sizes?: string;
}) {
  return (
    <figure className="overflow-hidden rounded-xl border border-edge bg-card shadow-2xl shadow-black/40">
      <div className="flex items-center gap-1.5 border-b border-edge px-3.5 py-2.5">
        <span className="size-2.5 rounded-full bg-secondary" />
        <span className="size-2.5 rounded-full bg-secondary" />
        <span className="size-2.5 rounded-full bg-secondary" />
      </div>
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
    </figure>
  );
}
