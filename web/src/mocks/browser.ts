/** Browser-side MSW worker — the dev-preview gateway. Enabled when
 * NEXT_PUBLIC_API_MOCK=1 (see MswProvider). */
import { setupWorker } from "msw/browser";

import { handlers, mockDb } from "./handlers";

// A fresh browser session starts WITHOUT a billing profile, exactly like a
// brand-new account against the real gateway — so local dev exercises the
// ensure-at-sign-in / before-project-create flow instead of hiding it (the
// missing-profile bug shipped to staging because the mock auto-passed it).
mockDb.billingProfile = false;

export const worker = setupWorker(...handlers);
