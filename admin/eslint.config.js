import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Owner 2026-11-04 (BL-29, same rule as web/eslint.config.mjs): overlays
 * and controls come from components/ui (shadcn on Radix: portals,
 * collision handling, focus and dismiss behaviour); no hand-rolled
 * overlays. A real exception takes an eslint-disable-next-line with the
 * reason. */
const NO_HAND_ROLLED_OVERLAYS = [
  {
    selector: "JSXAttribute[name.name='role'][value.value=/^(dialog|alertdialog|menu|listbox|tooltip)$/]",
    message: "Hand-rolled overlay: use the components/ui primitive (Dialog, AlertDialog, Sheet, DropdownMenu, Popover, Select, Tooltip).",
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
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: "No HTML injection: customer text is plain text, and a <style> breaks the CSP (style-src 'self').",
  },
];

export default defineConfig([
  globalIgnores(["dist/**", "dist-overlays/**", "node_modules/**"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/**", "src/**/*.test.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...NO_HAND_ROLLED_OVERLAYS] },
  },
  {
    files: ["scripts/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
]);
