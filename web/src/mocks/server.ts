/** Node-side MSW server for vitest. Import in test files:
 *
 *   import { server } from "@/mocks/server";
 *   import { mockDb } from "@/mocks/handlers";
 *   beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
 *   afterEach(() => { server.resetHandlers(); mockDb.reset(); });
 *   afterAll(() => server.close());
 *
 * "error" is strict (CI 2026-11-07): MSW's own "error" only logs and
 * rejects the request, so code that swallows the failure (a fire-and-
 * forget event) passed anyway. Here every unhandled request is also
 * recorded, and vitest.setup.ts fails the test it happened in.
 */
import { setupServer } from "msw/node";

import { handlers } from "./handlers";

export const server = setupServer(...handlers);

type Listen = typeof server.listen;
const listen: Listen = server.listen.bind(server);
server.listen = ((options?: Parameters<Listen>[0]) =>
  listen({
    ...options,
    onUnhandledRequest:
      options?.onUnhandledRequest === "error"
        ? (request, print) => {
            unhandledRequests().push(`${request.method} ${request.url}`);
            print.error();
          }
        : options?.onUnhandledRequest,
  })) as Listen;

/** What reached MSW unhandled since the last call (vitest.setup.ts). */
export function unhandledRequests(): string[] {
  const g = globalThis as { __mswUnhandled?: string[] };
  g.__mswUnhandled ??= [];
  return g.__mswUnhandled;
}
