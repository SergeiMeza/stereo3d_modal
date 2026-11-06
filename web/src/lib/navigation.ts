/**
 * Owner bug 2026-11-07: after an upload, router.push to the new project
 * sat on "Creating project… 100%", and tapping the project's card didn't
 * open it either. When the route's server request (?_rsc=) never answers,
 * the App Router keeps that navigation pending, and every later push or
 * Link to the same address joins the same pending request (a failed
 * request, by contrast, falls back to a full load). So a navigation that
 * hasn't moved the address within NAV_FALLBACK_MS becomes a full load.
 */

export const NAV_FALLBACK_MS = 3000;

/** Indirection so tests can watch the full load (jsdom has none). */
export const browserNav = {
  assign(href: string): void {
    window.location.assign(href);
  },
};

function here(): string {
  return window.location.pathname + window.location.search;
}

/**
 * Watch a navigation just started: if the address hasn't moved within
 * NAV_FALLBACK_MS, load `href` in full. `beforeFull` runs first (e.g. to
 * drop a "leave this page?" guard). Returns a cancel function.
 */
export function watchNavigation(href: string, beforeFull?: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const from = here();
  const t = setTimeout(() => {
    if (here() !== from) return;
    beforeFull?.();
    browserNav.assign(href);
  }, NAV_FALLBACK_MS);
  return () => clearTimeout(t);
}

/** router.push with the full-load fallback. */
export function pushWithFallback(
  router: { push: (href: string) => void },
  href: string,
  beforeFull?: () => void,
): void {
  router.push(href);
  watchNavigation(href, beforeFull);
}
