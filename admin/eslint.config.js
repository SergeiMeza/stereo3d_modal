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

/** ADR 0138 (owner 2026-11-05): shared state and gateway responses live in
 * jotai atoms (src/state/); React Context only for non-state providers. */
const STATE_IN_ATOMS = [
  {
    selector: "CallExpression[callee.name='createContext'], CallExpression[callee.property.name='createContext']",
    message:
      "ADR 0138: shared state goes in a jotai atom, not a React Context. Context is only for non-state providers (theme, Radix, router), in the allowlist below.",
  },
  {
    selector: "CallExpression[callee.name=/^set[A-Z]/] > AwaitExpression",
    message: "ADR 0138: a gateway response kept in useState: use a query atom (src/state/query.ts, useQuery).",
  },
  {
    selector: "CallExpression[callee.property.name='then'] > Identifier[name=/^set[A-Z]/]",
    message: "ADR 0138: a gateway response kept in useState: use a query atom (src/state/query.ts, useQuery).",
  },
  {
    selector: "CallExpression[callee.name='useLoad']",
    message: "ADR 0138: useLoad keeps a response in useState: use useQuery (src/state/query.ts).",
  },
];

/** Files allowed a React Context or a response in useState. Non-state
 * providers stay (the router); the rest is migration left to do. */
const STATE_ALLOWLIST = [
  "src/lib/router.tsx", // the router's provider (allowed: router)
  // migration in progress (ADR 0138): this list shrinks to the router
  "src/lib/useLoad.ts",
  "src/screens/AccountPage.tsx",
  "src/screens/CasePage.tsx",
  "src/screens/Security.tsx",
  "src/screens/SignIn.tsx",
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
    rules: { "no-restricted-syntax": ["error", ...NO_HAND_ROLLED_OVERLAYS, ...STATE_IN_ATOMS] },
  },
  {
    files: STATE_ALLOWLIST,
    rules: { "no-restricted-syntax": ["error", ...NO_HAND_ROLLED_OVERLAYS] },
  },
  {
    // shadcn primitives: Field's id plumbing is a non-state context
    files: ["src/components/ui/**/*.tsx"],
    ignores: ["src/components/ui/field.tsx"],
    rules: { "no-restricted-syntax": ["error", STATE_IN_ATOMS[0]] },
  },
  {
    files: ["scripts/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
]);
