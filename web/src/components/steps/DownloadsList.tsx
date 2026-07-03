import type { JSX } from "react";

/**
 * Output name → signed URL list (from GET /v1/conversions/{id}/downloads).
 * Browser-viewable outputs get an inline player in addition to the link:
 * the stereo previews (anaglyph/half_sbs/sbs). The raw `depth` output
 * stays a plain link (16-bit, not browser-decodable).
 */

const INLINE_PLAYABLE: ReadonlySet<string> = new Set([
  "anaglyph",
  "half_sbs",
  "sbs",
]);

const DEPTH_ARTIFACTS: ReadonlySet<string> = new Set(["depth", "depth_vis"]);

/**
 * Scope a run's downloads to what its step actually sells. Every job also
 * writes the depth artifacts next to its formats, so unfiltered lists
 * offered a depth run's throwaway anaglyph, a stereo run's depth map, and
 * everywhere the 8-bit depth_vis — which exists ONLY so browsers can play
 * a depth preview (the real map is 16-bit) and reads like a depth map to
 * users. Rules: depth page → the depth map alone; stereo page → the
 * stereo formats alone; production / legacy / the cross-step History
 * table (step undefined) → everything; depth_vis → never downloadable.
 */
export function stepDownloads(
  step: string | null | undefined,
  downloads: Record<string, string>,
): Record<string, string> {
  const keep = (name: string): boolean => {
    if (name === "depth_vis") return false;
    if (step === "depth_preview") return name === "depth";
    if (step === "stereo_preview") return !DEPTH_ARTIFACTS.has(name);
    return true;
  };
  return Object.fromEntries(
    Object.entries(downloads).filter(([name]) => keep(name)),
  );
}

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
