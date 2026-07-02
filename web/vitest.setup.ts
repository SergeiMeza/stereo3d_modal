/**
 * jsdom polyfills for Radix primitives (shadcn/ui): ResizeObserver (Slider),
 * Element.scrollIntoView (menus/dialogs), and window.matchMedia (vaul —
 * ui/drawer). No-ops / static results — layout observation is irrelevant
 * in jsdom.
 */

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

window.matchMedia ??= ((query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList) as typeof window.matchMedia;
