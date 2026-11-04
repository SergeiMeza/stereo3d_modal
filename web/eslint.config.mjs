import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/** Owner 2026-11-04: UI overlays and controls come from components/ui
 * (shadcn on Radix: portals, collision handling, focus and dismiss
 * behaviour); no hand-rolled overlays. A real exception takes an
 * eslint-disable-next-line with the reason. */
const NO_HAND_ROLLED_OVERLAYS = [
  {
    selector:
      "JSXAttribute[name.name='role'][value.value=/^(dialog|alertdialog|menu|listbox|tooltip)$/]",
    message:
      "Hand-rolled overlay: use the components/ui primitive (Dialog, AlertDialog, DropdownMenu, Popover, Select, Tooltip).",
  },
  {
    selector:
      "CallExpression[callee.property.name='addEventListener'][callee.object.name=/^(document|window)$/][arguments.0.value=/^(mousedown|click|keydown|pointerdown)$/]",
    message:
      "Document/window-level pointer or key listener: overlays get outside-click and Escape from components/ui. Keyboard shortcuts need an eslint-disable with the reason.",
  },
  {
    selector:
      "JSXAttribute[name.name='className'][value.value=/\\b(absolute|fixed)\\b.*\\bz-50\\b|\\bz-50\\b.*\\b(absolute|fixed)\\b/]",
    message: "Positioned z-50 overlay: use the components/ui primitive (it portals and stays inside the viewport).",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/**", "src/**/*.test.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...NO_HAND_ROLLED_OVERLAYS] },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
