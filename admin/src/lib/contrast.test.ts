import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/** WCAG 2 contrast for the console's tokens (index.css :root). */

function tokens(): Record<string, string> {
  const css = readFileSync(path.join(process.cwd(), "src/index.css"), "utf8");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  const out: Record<string, string> = {};
  for (const m of root.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2];
  return out;
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const t = tokens();

describe("token contrast (WCAG AA)", () => {
  const AA = 4.5;
  const surfaces = ["background", "card", "secondary", "popover"];

  it.each(["foreground", "foreground-2", "muted-foreground", "link", "destructive-foreground", "warning-foreground", "success-foreground", "info-foreground"])(
    "%s text is readable on every surface",
    (fg) => {
      for (const bg of surfaces) expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(AA);
    },
  );

  it.each([
    ["primary-foreground", "primary"],
    ["destructive-foreground", "destructive-bg"],
    ["warning-foreground", "warning-bg"],
    ["neutral-foreground", "neutral-bg"],
    ["info-foreground", "info-bg"],
    ["success-foreground", "success-bg"],
    ["violet-foreground", "violet-bg"],
  ])("%s on %s", (fg, bg) => {
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(AA);
  });

  it("the focus ring and attention dots stand out from the card (3:1, non-text)", () => {
    for (const c of ["ring", "destructive", "warning", "info"]) expect(contrast(t[c], t.card), c).toBeGreaterThanOrEqual(3);
  });
});
