import { describe, expect, it } from "vitest";

import ResetPasswordRedirect from "./page";

describe("/reset-password", () => {
  it("redirects permanently to /signin, dropping the mail's query", () => {
    let thrown: unknown;
    try {
      ResetPasswordRedirect();
    } catch (e) {
      thrown = e;
    }
    const digest = String((thrown as { digest?: string }).digest);
    // NEXT_REDIRECT;<type>;<url>;<status>;
    const [kind, , url, status] = digest.split(";");
    expect(kind).toBe("NEXT_REDIRECT");
    expect(url).toBe("/signin");
    expect(status).toBe("308");
  });
});
