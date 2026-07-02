# Stereo3D Studio — web client

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

| env | values | what it does |
|---|---|---|
| `NEXT_PUBLIC_API_MOCK` | `1` / unset | `1` = MSW mock gateway in the browser (fixtures from `fixtures/`, fake checkout). Unset = real gateway. |
| `NEXT_PUBLIC_AUTH_MODE` | `mock` (default) / `firebase` | `mock` = fixed dev user, token `mock-token`. `firebase` = real Firebase auth (Google / email+password) against the `spatial-video-studio` project. |
| `NEXT_PUBLIC_GATEWAY_URL` | URL | gateway base; default `http://localhost:8787` |

The Firebase web config is hardcoded (public by design) in
`src/lib/firebase.ts`; `NEXT_PUBLIC_FIREBASE_*` envs only override it.
Stripe's publishable key arrives per-conversion from the gateway
(`payment.publishable_key`) — the client needs no Stripe env at all.

## Environments

| | gateway | Stripe | Firebase |
|---|---|---|---|
| local mock | MSW in-browser | mock panel | mock user |
| test | `https://stereo3d-gateway-test-151335782809.us-central1.run.app` | test mode | spatial-video-studio |
| prod | `https://stereo3d-gateway-prod-151335782809.us-central1.run.app` | live mode | spatial-video-studio |

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
