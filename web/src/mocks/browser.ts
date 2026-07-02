/** Browser-side MSW worker — the dev-preview gateway. Enabled when
 * NEXT_PUBLIC_API_MOCK=1 (see MswProvider). */
import { setupWorker } from "msw/browser";

import { handlers } from "./handlers";

export const worker = setupWorker(...handlers);
