import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { stripRadixSelectStyle, stripSonnerStyleInjection } from "./cspStrictDeps";

const require = createRequire(import.meta.url);

/** The installed dist file, as the production build sees it. */
function dist(pkg: string, from?: string): string {
  const entry = from ? require.resolve(pkg, { paths: [path.dirname(from)] }) : require.resolve(pkg);
  return readFileSync(path.join(path.dirname(entry), "index.mjs"), "utf8");
}

describe("CSP-strict dependencies (style-src 'self')", () => {
  it("sonner's runtime <style> injection becomes a no-op", () => {
    const out = stripSonnerStyleInjection(dist("sonner"));
    expect(out).toContain("function __insertCSS(code) { return;");
  });

  it("Radix Select's viewport <style> is dropped", () => {
    const radix = require.resolve("radix-ui");
    const out = stripRadixSelectStyle(dist("@radix-ui/react-select", radix));
    expect(out).not.toContain("dangerouslySetInnerHTML");
    expect(out).toContain("data-radix-select-viewport"); // the attribute the CSS rule targets stays
  });

  it("fails loudly when the code it expects is gone", () => {
    expect(() => stripSonnerStyleInjection("export {}")).toThrow(/sonner/);
    expect(() => stripRadixSelectStyle("export {}")).toThrow(/Radix Select/);
  });

  it("index.css carries the rules the stripped code used to inject", () => {
    const css = readFileSync(path.join(process.cwd(), "src/index.css"), "utf8");
    expect(css).toContain('@import "sonner/dist/styles.css"');
    expect(css).toMatch(/\[data-radix-select-viewport\]::-webkit-scrollbar/);
  });

  it("the scroll lock's style singleton is aliased to the CSSOM version", () => {
    const cfg = readFileSync(path.join(process.cwd(), "vite.config.ts"), "utf8");
    expect(cfg).toMatch(/react-style-singleton.*styleSingleton\.ts/s);
  });
});
