/**
 * jsdom polyfills for Radix primitives (shadcn/ui): ResizeObserver (Slider),
 * Element.scrollIntoView (menus/dialogs), and window.matchMedia (vaul —
 * ui/drawer). No-ops / static results — layout observation is irrelevant
 * in jsdom.
 *
 * Also resets the shared jotai viewer prefs between tests: components use
 * jotai's DEFAULT store (module-scoped), so without a reset one test's
 * zoom/speed/mute would leak into the next within the same file.
 */

import { getDefaultStore } from "jotai";
import { afterEach } from "vitest";

import { billingHistoryAtom, EMPTY_HISTORY } from "@/components/billing/billingHistoryAtoms";
import { resetPlanChangesForTests } from "@/components/billing/planChangeAtoms";
import { balanceDialogAtom, settleOpenAtom } from "@/components/pay/payAtoms";
import { resetStepCheckoutState } from "@/components/steps/checkoutStore";
import { resetConversionsForTests } from "@/components/steps/conversionAtoms";
import { fpsPickAtom, resetMake3dForTests } from "@/components/steps/make3dAtoms";
import { resetPricesForTests } from "@/components/steps/priceAtoms";
import { resetLimitsCache } from "@/lib/api/useLimits";
import { resetAuthForTests } from "@/lib/auth";
import { resetAccountSettingsCache } from "@/lib/useAccountSettings";
import { resetBillingForTests } from "@/lib/billing";
import { resetPaymentMethodsForTests } from "@/lib/api/usePaymentMethods";
import { resetPricingCache } from "@/lib/api/usePricing";
import {
  compactPlayerAtom,
  compactTimelineAtom,
  mutedAtom,
  playbackSpeedAtom,
  timelineZoomIndexAtom,
} from "@/lib/viewerPrefs";

afterEach(() => {
  const store = getDefaultStore();
  store.set(playbackSpeedAtom, 1);
  store.set(mutedAtom, true);
  store.set(timelineZoomIndexAtom, null);
  store.set(compactPlayerAtom, false);
  store.set(compactTimelineAtom, false);
  store.set(settleOpenAtom, false);
  store.set(billingHistoryAtom, EMPTY_HISTORY);
  store.set(balanceDialogAtom, null);
  // The per-(project, step) checkout state is likewise module-scoped and
  // would leak an in-flight tracker into the next test.
  resetStepCheckoutState();
  // ADR 0138: the Make 3D picks, the cached side prices and the rate picks
  resetMake3dForTests();
  resetConversionsForTests();
  resetPricesForTests();
  for (const k of [...fpsPickAtom.getParams()]) fpsPickAtom.remove(k);
  // ... and what they keep across reloads
  for (const k of Object.keys(window.localStorage)) {
    if (k.startsWith("svs:")) window.localStorage.removeItem(k);
  }
  resetLimitsCache();
  resetPricingCache();
  resetBillingForTests();
  resetPlanChangesForTests();
  resetAuthForTests();
  resetAccountSettingsCache();
  resetPaymentMethodsForTests();
});

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

window.matchMedia ??= ((query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList) as typeof window.matchMedia;
