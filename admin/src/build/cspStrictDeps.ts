import type { Plugin } from "vite";

/**
 * Keeps the console's CSP strict (`style-src 'self'`, no 'unsafe-inline';
 * src/lib/csp.ts) with the shadcn/Radix stack. Inline `style` attributes set
 * by React go through CSSOM and are allowed; `<style>` elements with text
 * are not. Two dependencies add one at runtime, so the production build
 * removes them and the same rules come from our own stylesheet instead:
 *
 * - sonner injects its whole stylesheet on import (`__insertCSS`): the call
 *   becomes a no-op and `sonner/dist/styles.css` is bundled by index.css.
 * - Radix Select renders a `<style>` that hides the viewport's scrollbar:
 *   it is dropped and index.css carries the rule.
 *
 * react-remove-scroll's `<style>` (the scroll lock) is handled by the
 * react-style-singleton alias (src/lib/styleSingleton.ts).
 *
 * If a dependency update changes the code, the build fails here rather than
 * shipping a page that trips the CSP.
 */

const SONNER = /[\\/]sonner[\\/]dist[\\/]index\.m?js$/;
const RADIX_SELECT = /[\\/]@radix-ui[\\/]react-select[\\/]dist[\\/]index\.m?js$/;

export function stripSonnerStyleInjection(code: string): string {
  const out = code.replace(/function __insertCSS\(code\) \{/, "function __insertCSS(code) { return;");
  if (out === code) {
    throw new Error("csp-strict-deps: sonner no longer has __insertCSS; check how it adds its styles now");
  }
  return out;
}

export function stripRadixSelectStyle(code: string): string {
  const re =
    /\/\* @__PURE__ \*\/ jsx\(\s*"style",\s*\{\s*dangerouslySetInnerHTML:\s*\{\s*__html: `\[data-radix-select-viewport\][^`]*`\s*\},\s*nonce\s*\}\s*\)/;
  const out = code.replace(re, "null");
  if (out === code || /dangerouslySetInnerHTML/.test(out)) {
    throw new Error("csp-strict-deps: Radix Select's viewport <style> changed; update the transform");
  }
  return out;
}

export function cspStrictDeps(): Plugin {
  return {
    name: "admin-csp-strict-deps",
    apply: "build",
    enforce: "pre",
    transform(code, id) {
      if (SONNER.test(id)) return { code: stripSonnerStyleInjection(code), map: null };
      if (RADIX_SELECT.test(id)) return { code: stripRadixSelectStyle(code), map: null };
      return null;
    },
  };
}
