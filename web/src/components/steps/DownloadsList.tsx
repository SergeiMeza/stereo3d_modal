import type { JSX } from "react";

/**
 * Output name → signed URL list (from GET /v1/conversions/{id}/downloads).
 * Browser-viewable outputs get an inline player in addition to the link:
 * the stereo previews (anaglyph/half_sbs/sbs) and depth_vis, the 8-bit
 * depth visualization video. The raw `depth` output stays a plain link
 * (16-bit, not browser-decodable).
 */

const INLINE_PLAYABLE: ReadonlySet<string> = new Set([
  "anaglyph",
  "half_sbs",
  "sbs",
  "depth_vis",
]);

export function DownloadsList({
  downloads,
}: {
  downloads: Record<string, string>;
}): JSX.Element {
  const entries = Object.entries(downloads).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return (
    <ul className="flex flex-col gap-3">
      {entries.map(([name, url]) => (
        <li key={name} className="flex flex-col gap-2">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="w-fit text-sm text-primary underline underline-offset-2 hover:text-primary/80"
          >
            {name}
          </a>
          {INLINE_PLAYABLE.has(name) ? (
            <video
              src={url}
              controls
              preload="metadata"
              data-testid={`preview-${name}`}
              className="w-full max-w-xl rounded-md border border-edge bg-black"
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
