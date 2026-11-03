import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  codeDigits,
  EmailCodeError,
  isAppleRelayEmail,
  startEmailCode,
  verifyEmailCode,
} from "@/lib/emailCode";
import { server } from "@/mocks/server";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("codeDigits", () => {
  it("keeps six digits from whatever was pasted", () => {
    expect(codeDigits("123 456")).toBe("123456");
    expect(codeDigits("123-456")).toBe("123456");
    expect(codeDigits("Your code: 042817.")).toBe("042817");
    expect(codeDigits("12345678")).toBe("123456");
    expect(codeDigits("abc")).toBe("");
  });
});

describe("isAppleRelayEmail", () => {
  it("spots Hide My Email addresses", () => {
    expect(isAppleRelayEmail("x1y2@privaterelay.appleid.com")).toBe(true);
    expect(isAppleRelayEmail("X@PrivateRelay.AppleID.com")).toBe(true);
    expect(isAppleRelayEmail("me@icloud.com")).toBe(false);
    expect(isAppleRelayEmail(null)).toBe(false);
  });
});

describe("start and verify", () => {
  it("posts the trimmed email and reads resend_after", async () => {
    let body: unknown;
    server.use(
      http.post(`${GATEWAY}/v1/auth/email/start`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ok: true, resend_after: 30 });
      }),
    );
    expect(await startEmailCode("  a@example.com ")).toEqual({ resendAfter: 30 });
    expect(body).toEqual({ email: "a@example.com" });
  });

  it("carries retry_after and attempts_left from the refusal", async () => {
    server.use(
      http.post(`${GATEWAY}/v1/auth/email/start`, () =>
        HttpResponse.json(
          { success: false, error: "resend_too_soon", message: "wait", details: { retry_after: 12 } },
          { status: 429 },
        ),
      ),
      http.post(`${GATEWAY}/v1/auth/email/verify`, () =>
        HttpResponse.json(
          { success: false, error: "code_invalid", message: "no", details: { attempts_left: 2 } },
          { status: 400 },
        ),
      ),
    );
    const e1 = await startEmailCode("a@example.com").catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(EmailCodeError);
    expect((e1 as EmailCodeError).code).toBe("resend_too_soon");
    expect((e1 as EmailCodeError).retryAfter).toBe(12);
    const e2 = await verifyEmailCode("a@example.com", "000000", false).catch((e: unknown) => e);
    expect((e2 as EmailCodeError).code).toBe("code_invalid");
    expect((e2 as EmailCodeError).attemptsLeft).toBe(2);
  });

  it("asks for a session in China mode", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${GATEWAY}/v1/auth/email/verify`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ uid: "u1", id_token: "id", refresh_token: "rt", expires_in: 3600, is_new_user: false });
      }),
    );
    const a = await verifyEmailCode("a@example.com", "123456", true);
    expect(body).toEqual({ email: "a@example.com", code: "123456", session: true });
    expect(a.id_token).toBe("id");
  });
});
