# Stereo3D Studio admin console

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

Signing in needs an account with the `svs_admin` custom claim and an
authenticator-app second factor. See
`spatial-video-studio/Docs/backlog/BL-23-admin-console-setup.md`. Without them
the console stops at "This account has no access." or at the second-factor
set-up screen.

`VITE_GATEWAY_URL` picks the gateway, and `VITE_ENV_LABEL` (`test` or `prod`)
is shown next to "admin" in the header. Neither is secret. The Firebase web
config is the shared `spatial-video-studio` project's public config, the same
one the customer web app uses (`src/lib/firebaseAuth.ts`).

## What's in it

| Screen | Route | Gateway |
| --- | --- | --- |
| Sign-in (A0): Google, then the authenticator code; set up a second factor; no access; session ended | any | Firebase Auth |
| Cases (A1): tabs, filters, search, counts (open, overdue, due today), disputes, EFW and failed refunds first | `/cases` | `GET /v1/admin/cases` |
| Case (A2): header, banners, per-run table, decisions with a confirm sheet (amount per run, what's left after it, the mail), evidence (M7), timeline and notes, related cases, refunds | `/cases/:id` | `GET /v1/admin/cases/{id}`, `POST …/actions`, `GET /v1/admin/mail-previews` |
| Accounts (A3): billing state, balance, methods, cases, payment history, ledger; clear review, clear sheet-only, block or unblock, resend E2, write off owed, adjust balance, open a case | `/accounts`, `/accounts/:uid` | `GET/POST /v1/admin/accounts/{uid}(/actions)`, `POST /v1/admin/cases` |
| Disputes and fraud (A4): monthly rate against the 0.75% line, outcomes, money, EFWs, open disputes by due date, breakdowns, monthly table, CSV | `/disputes` | `GET /v1/admin/disputes/summary` |
| Mail previews | `/mails` | `GET /v1/admin/mail-previews` |
| Refund policy (read-only) | `/policy` | `GET /v1/admin/policy` |

Behaviour the gateway expects:
- **401 `reauth_required`** on a money action: the console shows "Confirm it's
  you" (Google, then the code if asked), refreshes the token and runs the
  action once more. If you cancel: "Not confirmed. Nothing was charged or
  refunded."
- **409 `amount_changed`**: the case reloads, the sheet stays open with the new
  amounts and "The amount changed to $X.", and you confirm again.
  Approve and Partial send `expected_max_cents`, the maximum the sheet showed.
- **409 `action_unavailable`**: the case reloads and the sheet says so.
- **401 `invalid_token`**: retried once with a fresh token, then the session
  ends ("Your session ended. Sign in again.").
- **403 `no_access` / `mfa_required`**: the no-access screen, or the
  second-factor set-up.

Security:
- **Customer text is plain text only.** Customer messages, notes, banners,
  hints, mail text and evidence strings are React text nodes. The code never
  uses `dangerouslySetInnerHTML` and never auto-links anything.
- **Outbound links** (Stripe Dashboard, Cloud Logging, Modal) are links only
  when they're `https` on an allowed host (`src/lib/links.ts`). Anything else
  is shown as text.
- **Sessions** use Firebase `browserSessionPersistence`, so closing the tab
  signs you out. Requests carry a bearer token, `credentials: "omit"`, and no
  cookies.
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
- The second factor is an authenticator app (TOTP). SMS would need
  reCAPTCHA scripts, which this CSP doesn't allow.

## Deploy on Vercel (the owner creates the project and DNS)

One Vercel project, for example `stereo3d-admin`, on the same repository and
Git integration as the web app:

1. **New Project** → import this repository → **Root Directory** `admin`.
   `vercel.json` sets the framework (Vite), the install command
   (`npx --yes pnpm@12.15.0 install --frozen-lockfile`), the build command
   (`npm run build`), the output (`dist`), the SPA rewrite and the security
   headers. Node 22 or newer.
2. **Environment variables** (nothing secret):
   - Production: `VITE_GATEWAY_URL=https://stereo3d-gateway-prod-151335782809.us-central1.run.app`, `VITE_ENV_LABEL=prod`
   - Preview: `VITE_GATEWAY_URL=https://stereo3d-gateway-test-151335782809.us-central1.run.app`, `VITE_ENV_LABEL=test`
3. **Production branch** `main`. Optionally, set **Ignored Build Step**
   `git diff --quiet HEAD^ HEAD -- .` so commits that don't touch `admin/`
   don't rebuild it.
4. **Domains**:
   - `admin.stereo3d.studio` → Production;
   - `admin-test.stereo3d.studio` → assigned to the Git branch `staging`
     (Preview env, test gateway), like the web app's staging alias.
5. **DNS** at the `stereo3d.studio` registrar: a `CNAME` for `admin` and one
   for `admin-test`, both to `cname.vercel-dns.com` (or the record Vercel
   shows).
6. **Firebase**: Firebase's authorized-domain check also accepts subdomains of
   an entry, so `stereo3d.studio`, which is already listed, should cover both
   hosts. If the popup says the domain isn't authorized, add the two hosts
   under Authentication → Settings → Authorized domains.
7. Optional: Vercel Authentication (Deployment Protection) in front of the
   console, as a second gate before Firebase.

Don't deploy the console from `main` until the gateway's admin routes are
live on prod (the prod admin origin is `admin.stereo3d.studio`).

## Layout

```
admin/
  index.html, vite.config.ts, vercel.json, pnpm-workspace.yaml
  src/
    main.tsx, App.tsx, styles.css
    lib/       api client, auth (interface + Firebase), csp, router, types, format, links
    screens/   SignIn, CasesList, CasePage (+ ActionSheet, CaseEvidence), AccountPage, Disputes, MailPreviews, Policy
    components/ui.tsx
    test/      fixtures, harness (fake fetch and fake auth)
```
