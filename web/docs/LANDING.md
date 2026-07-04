# Landing page — requirements

Route: `/` (`web/src/app/page.tsx`). The landing doubles as the product
page; signed-in users are not redirected away (CTA switches to "Open
studio").

## Positioning

**One-liner:** the closest 3D quality to a VFX studio — without hiring
one, at a fraction of the price.

**Audience:** VR / spatial-video users and creators. They own (or ship
content to) Apple Vision Pro, Samsung Galaxy XR, Meta Quest, other
SBS-capable headsets, players and 3D displays. They know what "spatial
video" and "side-by-side" mean; they don't know (or care) about our
internal pipeline names.

**Message hierarchy** (order of the page):
1. Hero — the claim + CTA + device row (who it's for).
2. Proof — the studio itself (real product screenshots, workflow tabs).
3. Control — what makes it studio-grade (per-scene 3D, frame-exact,
   editable everything).
4. Delivery — every headset covered (formats × devices).
5. Price — pay-as-you-go, binding quote before every render, previews
   before you commit.
6. Beta note + feedback CTA.
7. Footer.

## Sections

### 1. Hero
- Eyebrow badge: "2D → 3D conversion studio · Beta".
- H1: the VFX-studio positioning claim.
- Subcopy: one sentence — upload a video, direct the depth, deliver to
  every headset.
- Primary CTA: "Open studio" (signed in) / "Start converting" → /signin.
  Secondary CTA: anchor link "See how it works" → workflow section.
- Device strip: Apple Vision Pro · Samsung Galaxy XR · Meta Quest ·
  3D displays & players (text badges, no trademarked logos).
- Hero visual: the Stereo tab screenshot (side-by-side video + depth map
  is the most self-explanatory single image) in a browser-chrome frame.

### 2. Workflow ("Your video, directed by you")
Interactive tab strip mirroring the app's own left nav — Media, Cut,
Depth, Stereo, Deliver. Clicking a tab swaps the screenshot and a short
description. Uses the five prepared screenshots. Default tab: Cut (the hero already shows Stereo).
Copy per tab (user-facing vocabulary only):
- **Media** — frame-exact source review: resolution, frame rate, every
  frame addressable.
- **Cut** — auto-detected scene cuts you can edit, merge, import/export;
  every boundary frame-exact.
- **Depth** — AI depth maps, temporally stable across the whole shot;
  pick the resolution knob, preview cheaply, export or bring your own.
- **Stereo** — per-scene 3D: every scene measured and classified
  automatically; override depth strength per scene; ship credits/logos
  as 2D.
- **Deliver** — full-quality render that inherits your preview work and
  reuses it at a discount; pick preset (1080p → 4K) and formats.

### 3. Studio-grade quality (3-4 feature cards)
- Temporally stable depth — video-native depth model, no per-frame
  flicker.
- Scene-aware stereo — depth resets at cuts; per-shot depth script with
  a viewing-comfort budget.
- Clean edges — occlusions filled by video inpainting, not smearing.
- Frame-exact control — cuts, trims and overrides are all integer frame
  indices; what you set is what renders.

### 4. Delivery formats × devices
Table/cards mapping formats to devices:
- **Apple spatial video (MV-HEVC .mov)** — Apple Vision Pro (shows up in
  Photos as Spatial Video); also plays on Android XR headsets like
  Samsung Galaxy XR.
- **Side-by-side / Half-SBS** — Meta Quest (any 3D player), YouTube VR,
  3D TVs and projectors.
- **Top-bottom / Half-TB** — 3D displays and players that expect TB.
- **Anaglyph** — instant red-cyan check on any flat screen.
Audio is carried through on all formats.

### 5. Pricing ("Pay for renders, not seats")
- No subscription; card on file, pay per job.
- Binding quote before every paid render — the price you see is the
  price you pay.
- Cheap low-res previews first; production reuses your preview work
  (depth, scene profile) at a discount.
- Honesty rule: no concrete dollar amounts on the page (prices are
  quote-based and Firestore-tunable) — the quote UI is the price.

### 6. Beta note
- Beta limits stated plainly: videos up to 5 minutes, below 4K input.
- Feedback CTA (mailto sergei@spatial-ai-labs.com, reuse FeedbackLink
  styling/subject).

### 7. Footer
- Product name, contact email, © Spatial AI Labs, year.

## Assets

Five app screenshots prepared in `web/assets/` (media/cut/depth/stereo/
deliver tabs, ~2056×2200 PNG, 1.3-2.1 MB each). Requirements:
- Convert to WebP, max width 1600, quality ~82 → `web/public/landing/`.
  Target ≤ 250 KB each; total page image weight ≤ 1.5 MB.
- Rendered via `next/image` (lazy-loaded except the hero image, which is
  `priority`), inside a subtle browser-chrome frame with the studio
  border/radius vocabulary.
- `web/assets/` stays the source of truth for re-exports; it is not
  served.

## Design constraints

- Dark-only studio theme; use the existing tokens exclusively
  (`bg-background`, `bg-card`, `border-border`/`edge`, `text-primary`
  #4f8cff, `text-muted-foreground`…). No new colors, no gradients that
  fight the app: at most a faint primary glow behind the hero image.
- Same type system (Geist Sans / Geist Mono); mono for the small
  technical accents (step numbers, format tags) as the app already does.
- The global header (logo, Beta badge, Projects, Feedback, UserMenu)
  stays; the landing renders inside the existing layout.
- Responsive: single column on mobile, tab strip scrolls horizontally if
  needed; hero image full-width on small screens.
- Accessible: tabs keyboard-operable (buttons with aria-selected),
  images with real alt text, one h1, section headings h2.

## Copy rules

- No internal terms: no model names, GPU names, "ProPainter",
  "dual-res", "fan-out", "Modal". Say what it does, not what it's
  called.
- No fabricated proof: no testimonials, no client logos, no made-up
  stats. The screenshots are the proof.
- Device names are descriptive compatibility claims (plain text, no
  brand logos).
- Claims must be true of the shipped product today (e.g. spatial video
  is device-verified on Vision Pro — safe to say "appears as Spatial
  Video in Photos").

## Technical

- Next.js App Router page, client component only where state demands it
  (auth-dependent CTA, workflow tab switcher) — split the tab switcher
  into its own client component so the rest can stay server-rendered if
  convenient; the page is currently a client component and may remain
  one for simplicity.
- No new dependencies; icons from lucide-react (already installed).
- Existing tests must pass; add/adjust a smoke test if the home page has
  one (CTA renders, tab switching works).
- SEO (implemented 2026-07): canonical domain is **https://stereo3d.studio**
  (stereo3dstudio.com 301-redirects to it; `src/lib/site.ts` is the single
  source of truth, `NEXT_PUBLIC_SITE_URL` overrides). The route is a server
  component (`app/page.tsx`) carrying canonical + JSON-LD
  (Organization/WebSite/SoftwareApplication); the body is the client
  `LandingContent`. Site-wide title template + OG/Twitter cards live in
  `app/layout.tsx` with a dedicated 1200×630 `public/landing/og.jpg`
  (regenerate from `assets/stereo_tab.png`, cropped below the app header so
  no account email shows). `robots.ts` disallows the session-gated app
  routes; `sitemap.ts` lists `/`, `/privacy`, `/terms`. Section headings are
  real `h2`s (eyebrow labels are `p`), one `h1` in the hero.

## Out of scope

- Public marketing site separate from the app.
- Video/animated demos (screenshots only for now).
- Published price list (quote UI is the price).
- Sign-up changes; CTA reuses the existing /signin flow.

## Acceptance

- `/` renders the seven sections above with the prepared screenshots.
- Lighthouse-sane: images lazy + sized, no layout shift from images
  (explicit dimensions), total landing image payload ≤ 1.5 MB.
- `npm test` and `next build` green; deployed via the normal
  main → staging flow (Vercel).
