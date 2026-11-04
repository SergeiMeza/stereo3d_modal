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

/** Owner rule 2026-11-05 (ADR 0138): shared and server state lives in
 * jotai atoms. No React context for state (theme, Stripe Elements and
 * Next/Radix providers are theirs, not ours), and no useState holding a
 * fetch result. Files not migrated yet are on STATE_ALLOWLIST below,
 * which only shrinks. */
const STATE_IN_ATOMS = [
  {
    selector: "CallExpression[callee.name='createContext'], CallExpression[callee.property.name='createContext']",
    message: "No React context for state (ADR 0138): put shared state in a jotai atom (lib/state, a feature's *Atoms.ts).",
  },
  {
    selector:
      "CallExpression[callee.name='useState'] TSTypeReference > Identifier[name=/^(Project|Conversion|Conversions|BillingStatus|BillingMethods|BillingHistory|SavedMethod|PublicPricing|GatewayLimits|AccountSettings|StepQuoteResponse|PlanChangePreview|CheckoutStart|RunFormatJob|Downloads|AccountPlan)$/]",
    message: "Server data in useState (ADR 0138): keep fetch results in a jotai atom (see lib/state/sharedFetch, priceAtoms, workspaceAtoms).",
  },
  {
    selector: "CallExpression[callee.name=/^set[A-Z]/] > AwaitExpression",
    message: "A fetch result into useState (ADR 0138): keep it in a jotai atom, written by an action atom.",
  },
  {
    selector: "CallExpression[callee.property.name='then'] > ArrowFunctionExpression > CallExpression.body[callee.name=/^set[A-Z]/]",
    message: "A fetch result into useState (ADR 0138): keep it in a jotai atom, written by an action atom.",
  },
];

/** Files that still hold server data in useState; remove a file once it
 * moves to atoms. Never add one. */
const STATE_ALLOWLIST = [
  "src/components/auth/Passkeys.tsx",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/**", "src/**/*.test.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...NO_HAND_ROLLED_OVERLAYS, ...STATE_IN_ATOMS] },
  },
  ...(STATE_ALLOWLIST.length > 0
    ? [
        {
          files: STATE_ALLOWLIST,
          rules: { "no-restricted-syntax": ["error", ...NO_HAND_ROLLED_OVERLAYS] },
        },
      ]
    : []),
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
