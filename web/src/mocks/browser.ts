/** Browser-side MSW worker — the dev-preview gateway. Enabled when
 * NEXT_PUBLIC_API_MOCK=1 (see MswProvider). */
import { setupWorker } from "msw/browser";

import { handlers, mockDb } from "./handlers";

// A fresh browser session starts WITHOUT a saved card, exactly like a
// brand-new account against the real gateway — so local dev exercises the
// onboarding gate end-to-end instead of hiding it (the missing-profile bug
// shipped to staging because the old mock auto-passed the billing check).
mockDb.billing.hasPaymentMethod = false;
mockDb.billing.card = undefined;

// S3D-67: the dev preview prices as a non-member (the "Pro members save"
// link shows); window.__mockDb lets a screenshot script flip it
mockDb.pro = false;
(globalThis as { __mockDb?: typeof mockDb }).__mockDb = mockDb;

export const worker = setupWorker(...handlers);
