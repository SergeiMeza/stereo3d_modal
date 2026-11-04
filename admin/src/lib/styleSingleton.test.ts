import { afterEach, describe, expect, it } from "vitest";

import { stylesheetSingleton } from "./styleSingleton";

class FakeSheet {
  css = "";
  replaceSync(t: string) {
    this.css = t;
  }
}

describe("CSSOM style singleton (react-style-singleton for the CSP)", () => {
  const original = globalThis.CSSStyleSheet;
  afterEach(() => {
    globalThis.CSSStyleSheet = original;
    delete (document as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
  });

  it("adopts one constructed sheet while in use and never adds a <style> element", () => {
    globalThis.CSSStyleSheet = FakeSheet as unknown as typeof CSSStyleSheet;
    Object.defineProperty(document, "adoptedStyleSheets", { value: [], writable: true, configurable: true });
    const s = stylesheetSingleton();
    s.add("body{overflow:hidden}");
    s.add("ignored while one is in use");
    expect(document.adoptedStyleSheets).toHaveLength(1);
    expect((document.adoptedStyleSheets[0] as unknown as FakeSheet).css).toBe("body{overflow:hidden}");
    expect(document.querySelector("style")).toBeNull();
    s.remove();
    expect(document.adoptedStyleSheets).toHaveLength(1);
    s.remove();
    expect(document.adoptedStyleSheets).toHaveLength(0);
  });

  it("does nothing where constructable stylesheets aren't supported", () => {
    const s = stylesheetSingleton();
    expect(() => {
      s.add("body{overflow:hidden}");
      s.remove();
    }).not.toThrow();
    expect(document.querySelector("style")).toBeNull();
  });
});
