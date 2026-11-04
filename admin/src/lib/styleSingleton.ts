import { useEffect } from "react";

/**
 * A drop-in for `react-style-singleton` (aliased in vite.config.ts), the
 * package react-remove-scroll uses to lock the page scroll under a Radix
 * Dialog, Sheet or AlertDialog. The original appends a `<style>` element
 * with text, which the console's CSP (`style-src 'self'`, no
 * 'unsafe-inline') blocks: the scroll lock is lost and the browser logs a
 * violation. This one puts the same CSS on a constructed stylesheet in
 * `document.adoptedStyleSheets`, which is CSSOM and not subject to
 * style-src, so the CSP stays as it is. Browsers without constructable
 * stylesheets get no scroll lock and no violation.
 */

interface Sheet {
  add: (style: string) => void;
  remove: () => void;
}

function supported(): boolean {
  return (
    typeof document !== "undefined" &&
    "adoptedStyleSheets" in document &&
    typeof CSSStyleSheet === "function" &&
    "replaceSync" in CSSStyleSheet.prototype
  );
}

export const stylesheetSingleton = (): Sheet => {
  let counter = 0;
  let sheet: CSSStyleSheet | null = null;
  return {
    add(style: string) {
      if (counter === 0 && supported()) {
        try {
          sheet = new CSSStyleSheet();
          sheet.replaceSync(style);
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        } catch {
          sheet = null;
        }
      }
      counter++;
    },
    remove() {
      counter--;
      if (!counter && sheet) {
        const s = sheet;
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== s);
        sheet = null;
      }
    },
  };
};

export const styleHookSingleton = () => {
  const sheet = stylesheetSingleton();
  return (styles: string, isDynamic?: boolean) => {
    useEffect(() => {
      sheet.add(styles);
      return () => sheet.remove();
      // same dependency as the original: re-run only for dynamic styles
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [styles && isDynamic]);
  };
};

export const styleSingleton = () => {
  const useStyle = styleHookSingleton();
  const Sheet = ({ styles, dynamic }: { styles: string; dynamic?: boolean }) => {
    useStyle(styles, dynamic);
    return null;
  };
  return Sheet;
};
