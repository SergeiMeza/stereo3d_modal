/** Node-side MSW server for vitest. Import in test files:
 *
 *   import { server } from "@/mocks/server";
 *   import { mockDb } from "@/mocks/handlers";
 *   beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
 *   afterEach(() => { server.resetHandlers(); mockDb.reset(); });
 *   afterAll(() => server.close());
 */
import { setupServer } from "msw/node";

import { handlers } from "./handlers";

export const server = setupServer(...handlers);
