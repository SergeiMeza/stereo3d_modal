/**
 * Screenshot deep links in the mock only (owner 2026-11-07, the iPhone Duo
 * pass, which can't click inside Safari): ?mockOpen=<sheet> opens a sheet
 * on load. NEXT_PUBLIC_API_MOCK is inlined at build, so a production build
 * always answers null.
 */
export function mockOpen(): string | null {
  if (process.env.NEXT_PUBLIC_API_MOCK !== "1" || typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("mockOpen");
}
