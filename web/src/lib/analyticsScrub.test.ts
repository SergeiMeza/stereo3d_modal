/**
 * REV-15: a pay link's token pays someone's debt, so analytics never see
 * it: Vercel Analytics gets /pay/[token] (no query) and Clarity doesn't
 * record a pay link's page. /pay/return stays as it is.
 */
import { describe, expect, it } from "vitest";

import { scrubEvent } from "@/components/VercelAnalyticsScrubbed";

import { isPayTokenPath, scrubUrl } from "./analytics";

describe("pay links in analytics (REV-15)", () => {
  it("a pay link reads /pay/[token], query and all", () => {
    expect(scrubUrl("https://studio.example/pay/pr_9f8e7d6c5b4a")).toBe("https://studio.example/pay/[token]");
    expect(scrubUrl("https://studio.example/pay/pr_9f8e7d6c5b4a?done=1&redirect_status=succeeded")).toBe(
      "https://studio.example/pay/[token]",
    );
    expect(scrubUrl("/pay/pr_9f8e7d6c5b4a#x")).toBe("/pay/[token]");
  });

  it("other pages, and the return page, are left alone", () => {
    expect(scrubUrl("https://studio.example/pay/return?c=c123")).toBe("https://studio.example/pay/return?c=c123");
    expect(scrubUrl("https://studio.example/projects/p1")).toBe("https://studio.example/projects/p1");
    expect(scrubUrl("https://studio.example/pay/returned")).toBe("https://studio.example/pay/[token]");
  });

  it("Vercel's beforeSend gets the scrubbed URL", () => {
    const e = scrubEvent({ type: "pageview", url: "https://studio.example/pay/pr_9f8e7d6c5b4a?done=1" });
    expect(e.url).toBe("https://studio.example/pay/[token]");
    expect(e.type).toBe("pageview");
  });

  it("Clarity skips a pay link's page", () => {
    expect(isPayTokenPath("/pay/pr_9f8e7d6c5b4a")).toBe(true);
    expect(isPayTokenPath("/pay/return")).toBe(false);
    expect(isPayTokenPath("/account/billing")).toBe(false);
  });
});
