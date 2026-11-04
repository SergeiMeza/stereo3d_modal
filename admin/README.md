# Spatial Video Studio admin console

Owner-only web app for refund, dispute and fraud cases (payment spec v7 §M1,
§M7, §C12, §C13, A4). It talks only to the gateway's `/v1/admin/*` routes
(gateway README, "Admin API"). It's a separate Vite + React + TypeScript app
with its own build, lockfile and Vercel project. Nothing in it ships to
customers.

| env   | console                               | gateway                                                          | Stripe |
| ----- | ------------------------------------- | ---------------------------------------------------------------- | ------ |
| local | `http://localhost:5174`               | test: `https://stereo3d-gateway-test-151335782809.us-central1.run.app` | test   |
| test  | `https://admin-test.stereo3d.studio`  | test (same)                                                      | test   |
| prod  | `https://admin.stereo3d.studio`       | `https://stereo3d-gateway-prod-151335782809.us-central1.run.app` | live   |

The gateway only answers these three origins (`ADMIN_ORIGINS`; prod admits
only `admin.stereo3d.studio`). A `*.vercel.app` preview URL can load the page
but every API call gets 403 `origin_not_allowed`. That's expected.

## Run locally

```bash
cd admin
pnpm install          # pnpm 12; build scripts are set in pnpm-workspace.yaml
cp .env.example .env.local   # optional: the defaults point at the test gateway
pnpm dev              # http://localhost:5174 (fixed port: the gateway admits it)
pnpm test             # unit tests with mocked gateway responses
pnpm build && pnpm preview   # production build on :5174, served with the CSP headers
```

## Signing in (ADR 0135)

Sign-in is **Google, then a passkey** (ADR 0135). It needs an account with
the `svs_admin` custom claim; without it the console stops at "This account
has no access." The owner's one-time steps (the claim, the first passkey,
Firebase) are in BL-23,
`spatial-video-studio/Docs/backlog/BL-23-admin-console-setup.md` (SVS
a9ffc582). Then:

1. **Google** (Firebase popup).
2. **"Use your passkey"**: `POST /v1/admin/session/options` (fetched as the
   step opens, so the browser's prompt opens straight from the click), the
   passkey through `@simplewebauthn/browser`, then
   `POST /v1/admin/session/verify`. The gateway's session token is kept in
   `sessionStorage` only and sent as `X-Admin-Session` on every admin call;
   401 `session_expired` drops it and asks for the passkey again, and a
   Google sign-out drops it too.
3. **No passkey yet** (409 `no_passkey`): "Set up a passkey" right after
   Google (`POST /v1/admin/passkeys/register/options`, create,
   `…/register/verify`), then sign in with it.

"A passkey uses Face ID, Touch ID, your phone or a security key. Nothing to
type." An authenticator code (TOTP) is only a temporary fallback, one link
away ("Use an authenticator code instead"), while the gateway still accepts
it. The
passkey routes are the console's working shape (`PASSKEY_ROUTES` in
`src/lib/api.ts`) until the gateway sends its own.

`VITE_GATEWAY_URL` picks the gateway, and `VITE_ENV_LABEL` (`test` or `prod`)
is shown next to "admin" in the header. Neither is secret. The Firebase web
config is the shared `spatial-video-studio` project's public config, the same
one the customer web app uses (`src/lib/firebaseAuth.ts`).

## What's in it

The feature list, with status and sources, lives in
`spatial-video-studio/Docs/admin-console.md`; its **History** section
names the commit for every change to the console. Each console change
is its own commit naming the feature and its ADR or BL.

| Screen | Route | Gateway |
| --- | --- | --- |
| Sign-in (A0, ADR 0135): Google, then the passkey (or set one up); the authenticator code behind a link; no access; session ended | any | Firebase Auth, `POST /v1/admin/session/options`, `…/session/verify`, `POST /v1/admin/passkeys/register/options`, `…/register/verify` |
| Security (ADR 0135): passkeys (name, created, last used), add one (fresh passkey), remove with a confirm; the last one can't go | `/security` | `GET /v1/admin/passkeys`, `DELETE /v1/admin/passkeys/{id}`, register routes |
| Disputes badge (header, every page): open disputes and EFWs, refreshed every 60 s and on focus, links to Disputes; red banner when disputes are due within 3 days | all pages | `GET /v1/admin/disputes/summary` (`open`, `open_efws`) |
| Cases (A1): tabs, filters, search, counts (open, overdue, due today), disputes, EFW and failed refunds first | `/cases` | `GET /v1/admin/cases` |
| Case (A2): header, banners, per-run table, decisions with a confirm sheet (amount per run, what's left after it, the mail), evidence (M7), timeline and notes, related cases, refunds | `/cases/:id` | `GET /v1/admin/cases/{id}`, `POST …/actions`, `GET /v1/admin/mail-previews` |
| Plan-invoice disputes as cases, with the promo snapshot | `/cases/:id` | (webhooks) |
| Closed cases: notes and decisions refused (409 `case_closed`: "Reopen the case to add notes"); "Follow-up of CASE-…" on the new case and its follow-ups on the closed one | `/cases/:id` | `follow_up_of`, `follow_up_ids` |
| "Promotional grants restored by X" event on closed dispute cases | `/cases/:id` | case `events` (kind `promo_restored`) |
| Accounts (A3): billing state, balance, methods, cases, payment history, ledger; clear review, clear sheet-only, block or unblock, resend E2, write off owed, adjust balance, open a case | `/accounts`, `/accounts/:uid` | `GET/POST /v1/admin/accounts/{uid}(/actions)`, `POST /v1/admin/cases` |
| Company details on the account: name, address, tax ID and verification, billing email, PO, and the change log | `/accounts/:uid` | admin account `company`, `company_changes` |
| Grants: Grant Pro / Business / Studio (end date 1 week, 1 month, 3 months or custom; reason; fresh sign-in), the grants list with status, Revoke with a reason (re-grants the others) | `/accounts/:uid` | `GET/POST /v1/admin/accounts/{uid}/grants`, `DELETE …/grants/{id}` |
| Re-grants: promotional grants a refund, dispute, fraud warning or plan end took and gave back; restore after a lost dispute (reason, fresh sign-in) | `/accounts/:uid` | admin account `promo_regrants`, action `restore_promo_grants` |
| Disputes and fraud (A4): monthly rate against the 0.75% line, outcomes, money, EFWs, open disputes by due date, breakdowns, monthly table, CSV | `/disputes` | `GET /v1/admin/disputes/summary` |
| Onboarding: headset answers by week and by plan, the welcome variants side by side (web / `app_pro`), conversion per device | `/onboarding` | `GET /v1/admin/onboarding/headsets` |
| Business/Studio setup funnel (opened → plan → details → checkout → bought) and the answers by main use and team size | `/onboarding` | `GET /v1/admin/onboarding/headsets` (`business_setup`), `GET /v1/admin/onboarding/business_funnel` |
| Plans surfaces: views, clicks, dismissals and plan starts per placement, and by trigger reason | `/plans` | `GET /v1/admin/plans/surfaces` |
| Feedback: web and app feedback, read only, by platform | `/feedback` | `GET /v1/admin/feedback` |
| Mail previews | `/mails` | `GET /v1/admin/mail-previews` |
| Refund policy (read-only) | `/policy` | `GET /v1/admin/policy` |

Behaviour the gateway expects:
- **401 `reauth_required`** on a money action: the console shows "Confirm it's
  you". With `{method: "passkey"}` (or on a passkey session) that's "Use your
  passkey" (a `reassert` assertion through the session routes); on a TOTP
  session it's Google, then the code. Then the action runs once more. If
  you cancel: "Not confirmed. Nothing was charged or refunded."
- **401 `session_expired`** (passkey session over): the token is dropped and
  the passkey step comes back.
- **409 `no_passkey`** at sign-in: "Set up a passkey". **409
  `last_passkey`** on Security: "Add another passkey before removing this
  one."
- **409 `amount_changed`**: the case reloads, the sheet stays open with the new
  amounts and "The amount changed to $X.", and you confirm again.
  Approve and Partial send `expected_max_cents`, the maximum the sheet showed.
- **409 `action_unavailable`**: the case reloads and the sheet says so.
- **409 `case_closed`** on a note or decision: "Reopen the case to add
  notes."
- **Grants**: 502 `grant_failed` keeps the failed record in the list with
  the gateway's message; 503 `rc_unavailable` says nothing was granted;
  202 on a revoke says some grants will be retried tonight; 409
  `grant_not_active` and `nothing_to_restore` say so.
- **401 `invalid_token`**: retried once with a fresh token, then the session
  ends ("Your session ended. Sign in again.").
- **403 `no_access` / `mfa_required`**: the no-access screen, or the
  authenticator-code fallback.

Security:
- **Customer text is plain text only.** Customer messages, notes, banners,
  hints, mail text and evidence strings are React text nodes. The code never
  uses `dangerouslySetInnerHTML` and never auto-links anything.
- **Outbound links** (Stripe Dashboard, Cloud Logging, Modal) are links only
  when they're `https` on an allowed host (`src/lib/links.ts`). Anything else
  is shown as text.
- **Sessions** use Firebase `browserSessionPersistence` and the passkey
  session token lives in `sessionStorage`, so closing the tab signs you out.
  Requests carry a bearer token and `X-Admin-Session`, `credentials: "omit"`,
  and no cookies.
- **CSP** (`src/lib/csp.ts`) is sent as a header by `vercel.json` (both
  gateways, plus `frame-ancestors 'none'`) and as a meta tag in the build
  (only this build's gateway). The browser enforces both, so a build can only
  reach its own gateway. On top of the spec's policy, Firebase's Google popup
  needs `script-src https://apis.google.com`, `frame-src` for the Firebase
  auth domain, and `connect-src` for `identitytoolkit` and `securetoken`.
  Nothing is allowed `unsafe-inline` or `unsafe-eval`. The dev server sends
  no CSP, because Vite's hot reload uses inline scripts. A test keeps
  `vercel.json` in step with `csp.ts`. If you change `csp.ts` or the
  gateways, regenerate `vercel.json`.
- **Passkeys** need no CSP change: WebAuthn has no directive,
  `@simplewebauthn/browser` (pinned 13.3.0) is bundled into our own scripts,
  and its calls go to the gateway, already in `connect-src`. The
  Permissions-Policy names `publickey-credentials-get/create=(self)`.
- The second step is the passkey (ADR 0135). The temporary TOTP fallback
  uses an authenticator app; SMS would need reCAPTCHA scripts, which this
  CSP doesn't allow.

## Deploy on Vercel

The Vercel project **`stereo3d-admin`** exists, on the same repository and
Git integration as the web app, with **Root Directory** `admin`.
`vercel.json` sets the framework (Vite), the install command
(`npx --yes pnpm@12.15.0 install --frozen-lockfile`), the build command
(`npm run build`), the output (`dist`), the SPA rewrite and the security
headers (Node 22 or newer).

- **Test**: every push to the branch `staging` builds
  `https://admin-test.stereo3d.studio` (Preview env, test gateway). Keep
  `staging` a fast-forward of `feat/lifelike-web`.
- **Prod** (`admin.stereo3d.studio`, branch `main`) is held by the project's
  Ignored Build Step, so a push to `main` doesn't publish the console. It
  opens with the web launch, once the gateway's admin routes are live on
  prod.
- **Environment variables** (nothing secret): `VITE_GATEWAY_URL` and
  `VITE_ENV_LABEL`, test for Preview and prod for Production (the gateway
  URLs are in the table at the top).
- **CSP**: if you change `src/lib/csp.ts` or the gateways, regenerate
  `vercel.json` (a test checks they match).

The owner's remaining steps (Firebase, the `svs_admin` claim, the first
passkey, DNS checks) are in BL-23 (SVS a9ffc582).

## Layout

```
admin/
  index.html, vite.config.ts, vercel.json, pnpm-workspace.yaml
  src/
    main.tsx, App.tsx, styles.css
    lib/       api client, auth (interface + Firebase), adminSession, passkeys, csp, router, types, format, links
    screens/   SignIn, CasesList, CasePage (+ ActionSheet, CaseEvidence), AccountPage (+ Grants),
               Disputes, Onboarding, PlansSurfaces, Feedback, MailPreviews, Policy, Security
    components/ ui.tsx, Brand, DisputesAlert (header badge and due banner)
    test/      fixtures, harness (fake fetch and fake auth), webauthn (fake navigator.credentials)
```
