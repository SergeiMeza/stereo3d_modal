import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { postSignInEvent } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

describe("sign-in events for passkey adoption (ADR 0136)", () => {
  it("posts sign_in with the method after a sign-in", async () => {
    await postSignInEvent("google", async () => "token");
    expect(mockDb.events.at(-1)).toMatchObject({ name: "sign_in", props: { method: "google" } });
  });

  it("never throws, signed out or offline", async () => {
    await expect(
      postSignInEvent("email_code", async () => {
        throw new Error("signed out");
      }),
    ).resolves.toBeUndefined();
  });
});
