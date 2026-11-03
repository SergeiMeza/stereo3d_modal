/**
 * RevenueCat Web Billing in the browser (S3D-68), through
 * @revenuecat/purchases-js, loaded only when a Pro page needs it.
 *
 * The App User ID is the Firebase uid, the one Spatial Video Studio logs
 * RevenueCat in with, so a web purchase is Pro in the app too.
 *
 * Keys are RevenueCat's public Web Billing keys (made for browsers, like
 * the Firebase web config). NEXT_PUBLIC_REVENUECAT_WEB_KEY sets it; without
 * it every build except Vercel production uses the sandbox key (test cards,
 * Stripe test mode), and production shows no plans. The plans are the
 * offering NEXT_PUBLIC_REVENUECAT_OFFERING (default "web_pro", BL-16).
 */

import type { Offering, Package, Purchases } from "@revenuecat/purchases-js";

import { plansFromPackages } from "@/lib/pro/plans";
import type { ProPlan } from "@/lib/pro/plans";

/** The Web Billing app's sandbox key (public by design). */
const SANDBOX_KEY = "rcb_sb_GBFDRgYnnSRIZacnTAsFwTyTU";

export const OFFERING_ID =
  process.env.NEXT_PUBLIC_REVENUECAT_OFFERING ?? "web_pro";

export function webBillingKey(): string | null {
  const key = process.env.NEXT_PUBLIC_REVENUECAT_WEB_KEY;
  if (key) return key;
  return process.env.NEXT_PUBLIC_VERCEL_ENV === "production" ? null : SANDBOX_KEY;
}

export function isSandbox(): boolean {
  return (webBillingKey() ?? "").startsWith("rcb_sb_");
}

let instance: Purchases | null = null;
let configuredFor: string | null = null;
let packages = new Map<string, Package>();

async function purchases(uid: string): Promise<Purchases> {
  const key = webBillingKey();
  if (!key) throw new Error("Pro isn't sold on the web yet.");
  const { Purchases } = await import("@revenuecat/purchases-js");
  if (instance === null) {
    instance = Purchases.configure({ apiKey: key, appUserId: uid });
    configuredFor = uid;
  } else if (configuredFor !== uid) {
    await instance.changeUser(uid);
    configuredFor = uid;
    packages = new Map();
  }
  return instance;
}

/** The offering's plans for uid ([] when there's no offering yet). */
export async function loadPlans(uid: string): Promise<ProPlan[]> {
  const p = await purchases(uid);
  const offerings = await p.getOfferings();
  const offering: Offering | undefined = offerings.all[OFFERING_ID];
  if (!offering) return [];
  packages = new Map(offering.availablePackages.map((x) => [x.identifier, x]));
  return plansFromPackages(offering.availablePackages);
}

export type PurchaseOutcome = "purchased" | "cancelled";

/** RevenueCat's checkout for the plan (its own sheet, card / Apple Pay /
 * Google Pay). Resolves "cancelled" when the person closes it. */
export async function purchasePlan(
  uid: string,
  planId: string,
  email: string | null,
): Promise<PurchaseOutcome> {
  const p = await purchases(uid);
  const pkg = packages.get(planId);
  if (!pkg) throw new Error("That plan isn't available. Reload and try again.");
  const { ErrorCode, PurchasesError } = await import("@revenuecat/purchases-js");
  try {
    await p.purchase({
      rcPackage: pkg,
      ...(email ? { customerEmail: email } : {}),
    });
    return "purchased";
  } catch (e) {
    if (e instanceof PurchasesError && e.errorCode === ErrorCode.UserCancelledError) {
      return "cancelled";
    }
    throw e instanceof Error ? e : new Error("The purchase didn't go through.");
  }
}

/** Where a web subscriber manages or cancels (null when bought elsewhere). */
export async function managementUrl(uid: string): Promise<string | null> {
  const p = await purchases(uid);
  return (await p.getCustomerInfo()).managementURL;
}
