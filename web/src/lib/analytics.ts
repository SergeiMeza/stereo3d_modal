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

import { currentRegion } from "@/lib/region";

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

// ----------------------------------------------------------------- start

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
  started = true;
  clarityPromise = import("@microsoft/clarity").then(
    ({ default: Clarity }) => {
      Clarity.init(CLARITY_PROJECT_ID);
      if (opts.consented) {
        Clarity.consentV2({
          ad_Storage: "denied",
          analytics_Storage: "granted",
        });
      }
      return Clarity;
    },
  );
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
