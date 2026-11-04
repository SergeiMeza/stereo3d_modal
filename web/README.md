# Spatial Video Studio on the web — web client (stereo3d.studio)

Professional 2D→3D conversion studio (Next.js App Router). One video = one
project; the workspace tabs (Media / Cut / Depth / Stereo / Deliver / History)
drive paid step conversions through the Go gateway — the browser never talks
to Modal or Stripe secrets directly. Architecture: [DESIGN.md](DESIGN.md).

## Development

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # vitest (jsdom + MSW mock gateway)
npx tsc --noEmit && npm run lint
```

Two independent mode switches (`.env.local`, see `.env.local.example`):

| env                       | values                        | what it does                                                                                                                                       |
| ------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_MOCK`    | `1` / unset                   | `1` = MSW mock gateway in the browser (fixtures from `fixtures/`, fake card setup/billing). Unset = real gateway.                                  |
| `NEXT_PUBLIC_AUTH_MODE`   | `mock` (default) / `firebase` | `mock` = fixed dev user, token `mock-token`. `firebase` = real Firebase auth (Google / email+password) against the `spatial-video-studio` project. |
| `NEXT_PUBLIC_GATEWAY_URL` | URL                           | gateway base; default `http://localhost:8787`                                                                                                      |

The Firebase web config is hardcoded (public by design) in
`src/lib/firebase.ts`; `NEXT_PUBLIC_FIREBASE_*` envs only override it.
Stripe's publishable key arrives at runtime from the gateway
(`GET /v1/billing`, the onboarding SetupIntent, and 3DS fallbacks all carry
it) — the client needs no Stripe env at all.

Billing is pay-as-you-go: `/onboarding` captures a card (gateway
SetupIntent) before `/projects` is reachable; paid steps then bill the
saved card automatically — expensive runs hold-then-capture, cheap runs
charge on success — with failures surfaced in-app (banner + 3DS confirm).

## UI overlays and controls

UI overlays and controls come from `src/components/ui` (shadcn on Radix);
no hand-rolled overlays. Popovers, menus, dialogs, confirmations, sheets,
tabs and tooltips use `Popover`, `DropdownMenu`, `Dialog`, `AlertDialog`,
`SheetFrame`, `Tabs` and `Tooltip`: they portal, flip and shift to stay
16 px inside the viewport, and handle focus, outside clicks and Escape.
Add a missing shadcn component to `components/ui` rather than building one.

- ESLint (`no-restricted-syntax`, outside `components/ui`) flags raw
  `role="dialog|alertdialog|menu|listbox|tooltip"`, document/window-level
  `mousedown|click|keydown|pointerdown` listeners and `absolute|fixed … z-50`
  classes. A real exception (keyboard shortcuts, a full-width bar) takes an
  `eslint-disable-next-line no-restricted-syntax -- <reason>`.
- `pnpm test:overlays` (run in CI next to `pnpm test`) installs Chromium for
  the pinned `playwright` devDependency and runs `scripts/overlay-bounds.mjs`:
  at 390 and 1280 px it opens the popovers, menus and sheets against the mock
  gateway (it starts `next dev` itself, or uses `BASE_URL`) and fails if any
  leaves the viewport.
- Radix menus and tabs open on pointer or keyboard events, not `click`: in
  tests use `fireEvent.keyDown(trigger, { key: "Enter" })` for menus and
  `fireEvent.mouseDown(tab)` for tabs.

## State

Shared state lives in jotai atoms (ADR 0138, owner 2026-11-05: "react
context and react vanilla state management is too bug-prone").

- **jotai for anything two components read**, and for every server answer
  (a project, a run, a quote, billing, pricing). `useState` is only for
  truly local, short-lived UI: an input draft, a hover, an open/closed
  toggle nobody else reads. No new React context for state; context stays
  for non-state needs (theme, Stripe Elements' own provider, Next/Radix).
- **Where atoms live**: next to their feature, in `*Atoms.ts`
  (`components/steps/quoteAtoms.ts`, `make3dAtoms.ts`, `priceAtoms.ts`,
  `conversionAtoms.ts`, `components/workspace/workspaceAtoms.ts`,
  `components/pay/payAtoms.ts`); the plumbing is in `lib/state`.
- **Two kinds of store**: the app store (jotai's default) holds the
  session's state (auth, billing, pricing, limits, viewer prefs; read it
  with `useAppAtomValue`/`useAppAtom`), and each project page gets its own
  store (`ProjectStateProvider`, keyed by the project id) for the project,
  its runs, the checkout and Make 3D's picks, so opening another project
  starts clean. Per-item atoms use `atomFamily` from `jotai-family`, keyed by
  id; tests reset them in `vitest.setup.ts` (`family.remove`).
- **Async is latest-wins**: action atoms are the only writers of server
  state; each request takes a sequence number and an answer that isn't the
  latest is dropped (`requestQuoteAtom`), or answers are cached per request
  key and readers only look up their current key (`priceAtoms`). Changes
  settle (debounce) before they're fetched, a fetch has a timeout and an
  error state with Retry, and a price shows only for the selections it
  answers ("Updating…" meanwhile).
- **Nothing secret in an atom**: no tokens, no API clients (pass the
  gateway client to an action as an argument), and only plain UI state is
  persisted (`atomWithStorage` with `lib/state/safeStorage`, e.g. Make 3D's
  picks per project).
- ESLint (`no-restricted-syntax`) flags `createContext`, `useState` typed
  with a server type, and `setX(await …)` / `.then((x) => setX(x))`. Files
  not migrated yet are on `STATE_ALLOWLIST` in `eslint.config.mjs`, which
  only shrinks.

## Environments

|              | web app                                                          | gateway                                                          | Stripe     | Firebase             |
| ------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------- | ---------- | -------------------- |
| local mock   | `http://localhost:3000`                                          | MSW in-browser                                                   | mock panel | mock user            |
| test/staging | <https://stereo3d-studio-git-staging-spatial-ai-labs.vercel.app> | `https://stereo3d-gateway-test-151335782809.us-central1.run.app` | test mode  | spatial-video-studio |
| prod         | <https://stereo3d-studio.vercel.app>                             | `https://stereo3d-gateway-prod-151335782809.us-central1.run.app` | live mode  | spatial-video-studio |

## Deploy on Vercel

Root directory: `web/`. Framework preset: Next.js (no custom build settings).

Environment variables:

- Production:
  - `NEXT_PUBLIC_AUTH_MODE=firebase`
  - `NEXT_PUBLIC_GATEWAY_URL=https://stereo3d-gateway-prod-151335782809.us-central1.run.app`
- Preview (staging against the test gateway + Stripe test mode):
  - `NEXT_PUBLIC_AUTH_MODE=firebase`
  - `NEXT_PUBLIC_GATEWAY_URL=https://stereo3d-gateway-test-151335782809.us-central1.run.app`

Leave `NEXT_PUBLIC_API_MOCK` unset in both.

After the first deploy, add the Vercel domains (production domain and the
`*.vercel.app` preview domain you use) to Firebase → Authentication →
Settings → Authorized domains, or `signInWithPopup` will refuse to open.
Optionally set `CORS_ORIGINS` on the Cloud Run gateways to the final domains
(they default to `*`, which is safe with bearer-token auth but noisier).

### Staging

The `staging` branch is the test environment: pushes to it build a Vercel
preview at the stable alias
`https://stereo3d-studio-git-staging-spatial-ai-labs.vercel.app`, which uses
the Preview env vars (test gateway → open Modal test endpoint, Stripe test
mode). That alias is in Firebase authorized domains, so Google sign-in works
there; other ad-hoc preview URLs are not. Typical flow: push to `staging`,
verify against test billing, then fast-forward `main`.
