"use client";

/**
 * Product analytics core — Microsoft Clarity behind one gate and one
 * consent model (Google/Firebase Analytics removed, owner 2026-11-04). Components call track() /
 * upgradeSession() unconditionally; this module decides whether anything
 * actually leaves the browser.
 *
 * - Enabled only in a real production deployment: never dev, tests, the
 *   mock-gateway build, or Vercel previews. In development every call
 *   logs to the console instead, so instrumentation is verifiable.
 * - UK/EEA visitors must opt in before Clarity loads (the Analytics
 *   component asks /api/geo and shows the consent banner); everyone else
 *   starts silently. Until startAnalytics() runs, track() drops events —
 *   no consent, no tracking.
 * - Clarity events carry only a name (no properties). Clarity's upgrade API promotes engaged sessions
 *   (upload, card saved, paid conversion) in recording priority.
 * - The SDK loads lazily and failures are swallowed: ad blockers commonly
 *   reject analytics scripts and must never break the product.
 * - China mode (lib/region.ts) never starts it.
 * - Outside the UK/EEA a stored "denied" (the Privacy page's switch) keeps
 *   it off.
 */

import { currentRegion, prepareGatewayRoute } from "@/lib/region";

export const CLARITY_PROJECT_ID =
  process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID ?? "xhpg7k1meg";

export const ANALYTICS_ENABLED =
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PUBLIC_API_MOCK !== "1" &&
  // Vercel sets this on every deployment; only "production" is the live site.
  (process.env.NEXT_PUBLIC_VERCEL_ENV ?? "production") === "production";

// ------------------------------------------------------- consent storage

const CONSENT_KEY = "s3d-analytics-consent";

export type ConsentChoice = "granted" | "denied";

export function storedConsent(): ConsentChoice | null {
  try {
    const v = window.localStorage.getItem(CONSENT_KEY);
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    return null;
  }
}

export function storeConsent(choice: ConsentChoice): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    // storage blocked — the banner will simply ask again next visit
  }
}

/** The privacy page's "change your mind" hook: forget the stored choice so
 * the consent banner asks again on the next page load. */
export function clearStoredConsent(): void {
  try {
    window.localStorage.removeItem(CONSENT_KEY);
  } catch {
    // nothing to forget
  }
}

// --------------------------------------------------------- pay links

/** REV-15: a pay link (/pay/{token}) carries a token that pays a debt;
 * /pay/return is a page of its own. */
const PAY_TOKEN = /\/pay\/(?!return(?=[/?#]|$))[^/?#]+/;

/** True on a pay link's page. */
export function isPayTokenPath(pathname: string): boolean {
  return PAY_TOKEN.test(pathname);
}

/** A URL as analytics may see it: a pay link reads /pay/[token], with no
 * query (done, redirect_status and Stripe's ids). */
export function scrubUrl(url: string): string {
  const m = PAY_TOKEN.exec(url);
  if (!m) return url;
  return url.slice(0, m.index) + "/pay/[token]";
}

// ----------------------------------------------------------------- start

/** Longest wait for a dialog to close before recording starts anyway. */
const QUIET_MAX_MS = 120_000;

function dialogOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

/** Resolves when no dialog is open (checked every second, at most two
 * minutes) and the browser is idle. */
export function whenQuiet(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  const until = Date.now() + QUIET_MAX_MS;
  return new Promise<void>((resolve) => {
    const idle = () => {
      const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) ric(() => resolve(), { timeout: 3000 });
      else setTimeout(resolve, 1000);
    };
    const check = () => {
      if (!dialogOpen() || Date.now() > until) idle();
      else setTimeout(check, 1000);
    };
    // let the first screens (and a welcome) mount before looking
    setTimeout(check, 1500);
  });
}

type ClarityClient = (typeof import("@microsoft/clarity"))["default"];

let started = false;
// All Clarity calls chain off this promise, so they can never run before
// init and are silently dropped when analytics never started.
let clarityPromise: Promise<ClarityClient> | null = null;

/** Load and initialize Clarity. `consented` is true when the user
 * explicitly opted in (UK/EEA banner); Clarity then gets its consentV2
 * signal — analytics granted, ads denied (we run no ads). Elsewhere the
 * API isn't called and Clarity's regional defaults apply. */
export function startAnalytics(opts: { consented: boolean }): void {
  if (!ANALYTICS_ENABLED || started || currentRegion() === "cn") return;
  // REV-15: no session recording on a pay link's page (the token pays)
  if (typeof window !== "undefined" && isPayTokenPath(window.location.pathname)) return;
  started = true;
  // owner bug 2026-11-05: session recording starts once the page is quiet
  // (no dialog open, the browser idle), never under a first-run welcome
  // whose taps iOS Safari was dropping
  // BL-34: a browser whose route moves to the cn. host is in China mode
  // too, and China mode loads no analytics; the route settles first
  clarityPromise = prepareGatewayRoute()
    .then(whenQuiet)
    .then(() => {
      if (currentRegion() === "cn") throw new Error("analytics: China mode");
      return import("@microsoft/clarity");
    })
    .then(({ default: Clarity }) => {
      Clarity.init(CLARITY_PROJECT_ID);
      if (opts.consented) {
        Clarity.consentV2({
          ad_Storage: "denied",
          analytics_Storage: "granted",
        });
      }
      return Clarity;
    });
  clarityPromise.catch(() => {});
}

// ---------------------------------------------------------------- events

export type EventParams = Record<string, string | number | boolean>;

const devLog = (message: string, params?: EventParams): void => {
  if (process.env.NODE_ENV === "development") {
    console.debug(`[analytics] ${message}`, params ?? "");
  }
};

/** Record a product event in Clarity (its events carry no properties —
 * use tagSession for filterable dimensions; params show in dev logs). Safe to call anywhere, any time: a no-op until
 * startAnalytics() has run. */
export function track(name: string, params?: EventParams): void {
  devLog(`event ${name}`, params);
  if (!started) return;
  clarityPromise?.then((c) => c.event(name)).catch(() => {});
}

/** Clarity's upgrade API: prioritize this session for recording over the
 * daily sampling cap. Call at engagement moments worth replaying (video
 * uploaded, card saved, paid conversion started). */
export function upgradeSession(reason: string): void {
  devLog(`upgrade ${reason}`);
  clarityPromise?.then((c) => c.upgrade(reason)).catch(() => {});
}

/** Clarity custom tag — a filterable session dimension (Clarity events
 * can't carry params, tags fill that gap). */
export function tagSession(key: string, value: string | string[]): void {
  devLog(`tag ${key}=${String(value)}`);
  clarityPromise?.then((c) => c.setTag(key, value)).catch(() => {});
}
