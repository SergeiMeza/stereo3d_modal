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

import {
  billingHistoryAtom,
  companyAtom,
  EMPTY_COMPANY,
  EMPTY_HISTORY,
  EMPTY_INVOICES,
  invoicesAtom,
} from "@/components/billing/billingHistoryAtoms";
import { resetPlanChangesForTests } from "@/components/billing/planChangeAtoms";
import { EMPTY_PASSKEYS, passkeyListAtom } from "@/components/auth/passkeyAtoms";
import { EMPTY_WELCOME_PICKS, welcomePicksAtom } from "@/components/onboarding/welcomeAtoms";
import { balanceDialogAtom, settleOpenAtom } from "@/components/pay/payAtoms";
import { EMPTY_PROJECT_LIST, projectListAtom } from "@/components/projects/projectsAtoms";
import { resetStepCheckoutState } from "@/components/steps/checkoutStore";
import { resetConversionsForTests } from "@/components/steps/conversionAtoms";
import { resetRunFilesForTests } from "@/components/steps/runFilesAtoms";
import { fpsPickAtom, resetMake3dForTests } from "@/components/steps/make3dAtoms";
import { resetPricesForTests } from "@/components/steps/priceAtoms";
import { resetLimitsCache } from "@/lib/api/useLimits";
import { resetAuthForTests } from "@/lib/auth";
import { resetReauthForTests } from "@/lib/reauth";
import {
  CLOSED_SHEET,
  EMPTY_REFUND_OPTIONS,
  EMPTY_SUPPORT_REQUESTS,
  refundOptionsAtom,
  refundSheetAtom,
  supportRequestsAtom,
} from "@/components/refunds/refundAtoms";
import { EMPTY_IDENTITIES, identitiesAtom } from "@/components/auth/identityState";
import { EMPTY_EMAILS, emailsAtom } from "@/components/auth/emailAtoms";
import { EMPTY_RESTORE_MOVE, restoreMoveAtom } from "@/components/billing/restoreMoveAtoms";
import { EMPTY_PLAN_MOVES, planMovesAtom } from "@/components/billing/planMoveAtoms";
import { yourPricesOpenAtom } from "@/components/billing/yourPricesAtoms";
import { checkoutEmailAtom } from "@/components/pay/payAtoms";
import { resetAccountSettingsCache } from "@/lib/useAccountSettings";
import { resetBillingForTests } from "@/lib/billing";
import { resetProForTests } from "@/lib/pro/usePro";
import { resetPaymentMethodsForTests } from "@/lib/api/usePaymentMethods";
import { resetPricingCache } from "@/lib/api/usePricing";
import {
  compactPlayerAtom,
  compactTimelineAtom,
  mutedAtom,
  playbackSpeedAtom,
  stripHoverFrameAtom,
  timelineZoomIndexAtom,
} from "@/lib/viewerPrefs";

afterEach(() => {
  const store = getDefaultStore();
  store.set(playbackSpeedAtom, 1);
  store.set(mutedAtom, true);
  store.set(timelineZoomIndexAtom, null);
  store.set(compactPlayerAtom, false);
  store.set(compactTimelineAtom, false);
  store.set(stripHoverFrameAtom, null);
  store.set(settleOpenAtom, false);
  store.set(billingHistoryAtom, EMPTY_HISTORY);
  store.set(invoicesAtom, EMPTY_INVOICES);
  store.set(companyAtom, EMPTY_COMPANY);
  store.set(projectListAtom, EMPTY_PROJECT_LIST);
  store.set(passkeyListAtom, EMPTY_PASSKEYS);
  store.set(balanceDialogAtom, null);
  // The per-(project, step) checkout state is likewise module-scoped and
  // would leak an in-flight tracker into the next test.
  resetStepCheckoutState();
  // ADR 0138: the Make 3D picks, the cached side prices and the rate picks
  resetMake3dForTests();
  resetConversionsForTests();
  resetRunFilesForTests();
  resetPricesForTests();
  for (const k of [...fpsPickAtom.getParams()]) fpsPickAtom.remove(k);
  // ... and what they keep across reloads
  for (const k of Object.keys(window.localStorage)) {
    if (k.startsWith("svs:")) window.localStorage.removeItem(k);
  }
  resetLimitsCache();
  resetPricingCache();
  resetBillingForTests();
  resetProForTests();
  resetPlanChangesForTests();
  resetAuthForTests();
  resetReauthForTests();
  resetAccountSettingsCache();
  resetPaymentMethodsForTests();
  store.set(welcomePicksAtom, EMPTY_WELCOME_PICKS);
  store.set(refundOptionsAtom, EMPTY_REFUND_OPTIONS);
  store.set(supportRequestsAtom, EMPTY_SUPPORT_REQUESTS);
  store.set(refundSheetAtom, CLOSED_SHEET);
  store.set(identitiesAtom, EMPTY_IDENTITIES);
  store.set(emailsAtom, EMPTY_EMAILS);
  store.set(restoreMoveAtom, EMPTY_RESTORE_MOVE);
  store.set(planMovesAtom, EMPTY_PLAN_MOVES);
  store.set(yourPricesOpenAtom, true);
  store.set(checkoutEmailAtom, null);
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
