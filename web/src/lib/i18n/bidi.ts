/**
 * Right-to-left pages (owner 2026-11-07): numbers and Latin runs that
 * carry their own order — "0:01 – 0:06", "1920×1080", "$12.00", "24 fps",
 * "Vision Pro .mov" — keep it inside an Arabic sentence. Elements set in mono or tabular figures are
 * isolated by CSS (globals.css); text built from parts (Run details,
 * Source details) goes through ltrRuns(), which wraps each such run in
 * Unicode isolates (LRI … PDI). Left-to-right languages get the text as is.
 */

import { dirOf } from "./locales";
import type { Tr } from "./t";

const LRI = "⁦";
const PDI = "⁩";

// one left-to-right run inside right-to-left text: Latin words, numbers
// and what joins them ("Vision Pro .mov", "0:01 – 0:06", "1920×1080",
// "$12.00", "+30%", "24 fps"); a middle dot or comma ends it
const RUN = /(?:\.(?=[A-Za-z0-9]))?[A-Za-z0-9$+−][A-Za-z0-9 .:×/%+−–$-]*[A-Za-z0-9%]|[A-Za-z0-9]/g;

export function ltrRuns(text: string, t: Pick<Tr, "locale">): string {
  if (dirOf(t.locale) !== "rtl") return text;
  // amounts formatted for the language arrive isolated already
  return text
    .split(/(\u2066[^\u2069]*\u2069)/u)
    .map((part) => (part.startsWith(LRI) ? part : part.replace(RUN, (m) => `${LRI}${m}${PDI}`)))
    .join("");
}
