# Landing page — requirements

Route: `/` (`web/src/app/page.tsx`). The landing doubles as the product
page; signed-in users are not redirected away (CTA switches to "Open
studio").

## Positioning

**One-liner (2026-11):** turn any video into lifelike 3D — Lifelike 3D, our
newest 3D technology, is the product (S3D-01, S3D-44, S3D-46). Classic 3D
lives on only in existing projects and is not sold on this page. The old
"closest 3D quality to a VFX studio" positioning, depth direction, per-shot
depth scripts, inpainting and frame-exact controls are gone from the page.

**Audience:** VR / spatial-video users and creators. They own (or ship
content to) Apple Vision Pro, Samsung Galaxy XR, Meta Quest, other
SBS-capable headsets, players and 3D displays. They know what "spatial
video" and "side-by-side" mean; they don't know (or care) about our
internal pipeline names.

**What the page says (owner, 2026-11):** lifelike 3D from any video; any
length, up to 8K (S3D-05); one eye keeps your original picture at the
highest sizes (S3D-48, S3D-65); Foveated Detail, "sharper where you look"
(S3D-50); works in Vision Pro and every headset browser; "from $X a
minute at 24 fps" and "Pro members save N%" — both live from GET
/v1/pricing (`from_cents_per_minute`, `pro_discount`), never hardcoded.
Owner-approved list (2026-11): from $4 a minute (1080p), Pro saves 15%,
5K–8K named "Cinema", Business and Studio plans ($299 / $999 a month) for
teams — the page shows $4 / 15% once the gateway's pricing config says
so. Little text: clutter makes pages hard to read.

**Order of the page (2026-11):**
1. Hero — New tag, eyebrow, H1, one line, CTA + "from $X a minute",
   limits + Pro line + See prices; the 2D → 3D loop.
2. Four points — Lifelike depth · Any length, up to 8K · Your original in
   one eye (at Cinema sizes, 5K to 8K) · Foveated Detail.
3. Works with — the scrolling device row (S3D-51).
4. Three steps — upload, preview a moment, make it 3D.
5. Samples — clips to download.
6. How it looks — real screenshots of the new web UI.
7. What happens to your video — the three looping step clips.
8. Watch it — Vision Pro spatial video and side by side; works in every
   headset browser.
9. Closing CTA — "See your own video in 3D", price line, Make your first
   3D video + See prices, "For teams: Business and Studio plans. See
   plans" (→ /pricing), feedback link (no "beta").
10. Footer.

## Sections

### 1. Hero
> 2026-11 (S3D-46, redesign mock 12): the hero now leads with Lifelike 3D —
> "New" tag + eyebrow "Lifelike 3D · our newest 3D technology", H1 "Turn
> any video into lifelike 3D", one CTA "Make your first 3D video", "from
> $X a minute" from GET /v1/pricing, the red-cyan clip in a light-edge
> frame, then three benefits, "Watch on" devices and three steps. The
> Quality and Pricing sections were dropped (prices live on /pricing); the
> closing section is "See your own video in 3D" + See prices. The text
> below describes the earlier page.

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

> 2026-11 samples: the hero's red-cyan clip became a before/after
> (`HeroCompare.tsx`): the Mustang sample's 2D frame (cropped to match the
> 3D result's framing) and the same frame in red-cyan, a range input as
> the divider. Two WebP stills in `public/landing/samples/`, no video.
> Later in 2026-11 the hero became a loop (`HeroLoop.tsx`, `LoopVideo.tsx`):
> `public/landing/hero/sunset-session-2d-3d.{mp4,webm,jpg}` (licensed
> footage since 2026-11-04; the earlier diner clip was generated), 7.5 s,
> 960×540, the Sunset session sample — left of a gliding line the Lifelike
> left eye, right of it the same moment seen from a gently swaying
> viewpoint drawn from that eye. No red-cyan; the poster stays under
> reduced motion. `HERO_COMPARE` and its stills are gone.
> A **Samples** section (`Samples.tsx`, `src/lib/samples.ts`) follows the
> three steps: nine 9–15 s clips of the owner's licensed footage (since
> 2026-11-04; the five earlier generated samples are no longer listed, their
> CDN files stay for old links) made with Lifelike 3D (test service, preset
> 4K with the Master bitrate, Foveated Detail on the portrait clip), each
> with downloads for Vision
> Pro (spatial `.mov`), the other headsets and XR glasses (side by side
> `.mp4`) and the 2D original. Files on the public CDN under
> `samples/2026-11/` with `Content-Disposition: attachment`; muted loops
> under `samples/2026-11/loops/` mount only when a tile is played (H.264
> listed first: iPhone Safari paints the VP9 WebM black). Lede: "Made with
> Lifelike 3D in Spatial Video Studio on the web. Download one to your
> headset, or the 2D original to compare." Source set and entries:
> `/Volumes/Extreme Pro/splat-compare/website-samples-2026-11c` (PUBLISH.md).

### 2. How it looks ("From upload to headset") — replaced the workflow tabs 2026-11
`ProductTour.tsx`. From 640 px up: a tab strip (Projects · Make 3D ·
Progress · Files, Make 3D open first) over one large screenshot with a
one-line caption. On phones: the four phone captures in a horizontal snap
row with captions. Screenshots are the real web app, see Assets. The
Classic-era workflow tabs (`WorkflowTabs.tsx`, `BrowserFrame.tsx`,
`*-tab.webp`) were removed.

### 3. Pipeline ("What happens to your video") — added 2026-07, clips redone 2026-11
Three alternating rows, each a looping clip beside user-facing copy. The
clips are made from the owner's licensed footage (since 2026-11-04; the
first versions used generated clips) and carry no text — the copy is on
the page. Each lives in `public/landing/steps/` as `<name>.mp4` (H.264,
listed first), `<name>.webm` (VP9 4:2:0) and `<name>.jpg` (poster),
960×540, 24 fps, 10–12 s,
≤ 2 MB per file, the tail cross-faded into the head so the loop has no jump:
- **01 · Depth** — "We understand the shape of every scene"
  (`depth`: the Rooftop party clip plays; a glowing line sweeps across and
  leaves the scene coloured by distance — near warm, far blue, with slow
  flowing contour lines — then a second pass brings the picture back).
- **02 · 3D** — "Two eyes from one camera" (`stereo`: the Fencing hall clip
  seen from a gently swaying viewpoint, ending on its Lifelike left-eye and
  right-eye views side by side with matching guide lines). No red-cyan.
- **03 · Files** — "Plays like it was shot in 3D" (`delivery`: four 3 s
  scenes — Studio take as a floating window over a defocused real scene,
  Drift chase on a big screen in a dark virtual theatre, Rooftop singalong's
  two Lifelike eyes through the headset lenses, River stones on a
  see-through screen framed by XR glasses). No generated plates, no product
  renders, no logos.
Copy rule (Lifelike team, 2026-11): never "depth map", "splat" or a model
name on the page; say what the viewer gets ("We understand the shape of
every scene").
Component: `PipelineSteps.tsx`. Muted loops with MP4 then WebM sources and
a poster; a clip plays only while on screen (IntersectionObserver) and
never under `prefers-reduced-motion: reduce`, where the poster stays.
`aria-label`s describe each clip. No new dependencies. Build scripts:
session scratchpad `real/` (prep.sh: 1080p copies of each sample's 2D
original and its two Lifelike eyes from the 4K Master SBS; depth_local.py:
a local stand-in for the swaying viewpoint; step1_depth.py,
step2_stereo.py, step3_deliver.py, hero.py, encode.sh), adapted from the
first set's `motion/`.

### 4. Four Lifelike points (under the hero) — 2026-11
Lifelike depth ("Every moment rebuilt as a real 3D scene."), Any length,
up to 8K (title from `methodLimitText("lifelike")`; "From a short clip to a
whole film."), Your original in one eye ("At the highest sizes, one eye
shows your own frames."), Foveated Detail ("Sharper where you look.").
Two columns on phones, four on desktop.

### 5. Watch it ("On Vision Pro and every headset")
"Works in Vision Pro and every headset browser: open the site there and
watch or download straight to the headset." Two cards: Vision Pro spatial
video (.mov) and Side by side (.mp4). Top-bottom and red-cyan are not
sold with Lifelike (S3D-08).

### 6. Pricing
No price section; prices live on /pricing (S3D-18). The hero and the
closing line take "from $X a minute" and the Pro share from GET
/v1/pricing — never hardcoded.

### 7. Beta note
Removed 2026-11 (owner): no "Beta" chip in the app header, on the landing
or in metadata; the closing feedback line stays without "In beta".

### 8. Footer
- Product name, contact email, © Spatial AI Labs, year.

## Assets

**App screenshots (2026-11)** in `public/landing/ui/`: `projects`,
`make-3d`, `tracker`, `files` (2240×1400 WebP, 2× for the 1120 px panel)
and `<name>-phone` (780×1400 WebP, 390 px at 2×); ~370 KB for all eight.
Captured from the real web app in mock-gateway mode
(`NEXT_PUBLIC_API_MOCK=1 next dev`) with Playwright: the seeded fixture
project is replaced through `window.__mockDb` by five Lifelike projects
named after the licensed samples (Sunset session, Fencing hall, Drift
chase, River stones, Street dance, at their real 4K sizes) with thumbs and
strips served from a temporary `public/_shots/` (deleted after); then
Make 3D (Vision Pro + Meta Quest, 4K), a run through the tracker (`gpuWaitPolls = 0`) and its
Files. Crops: projects 1280×800 CSS px, Make 3D below the project bar,
tracker and files as cards centred on the app background. Scripts in the
session scratchpad `landing-ui/scripts2/` (common.js, shoot.js, crop.py).
Never show a real account or customer video.

**OG card** `public/landing/og.jpg` (1200×630): rendered from HTML — the
headline, "Up to 8K. For Vision Pro and every headset.", the hero loop's
poster (Sunset session) and "Stereo3D Studio · the web version of Spatial Video Studio".

## Design constraints

- Dark-only studio theme; use the existing tokens exclusively
  (`bg-background`, `bg-card`, `border-border`/`edge`, `text-primary`
  #4f8cff, `text-muted-foreground`…). No new colors, no gradients that
  fight the app: at most a faint primary glow behind the hero image.
- Same type system (Geist Sans / Geist Mono); mono for the small
  technical accents (step numbers, format tags) as the app already does.
- The global header (logo, Projects, Pricing, Feedback, UserMenu)
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
- SEO (implemented 2026-07): canonical domain is
  **https://www.stereo3d.studio** (the stereo3d.studio apex and
  stereo3dstudio.com 301-redirect to it; `src/lib/site.ts` is the single
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
- ~~Video/animated demos~~ (added 2026-07: the pipeline section's three
  short looping clips; everything else remains screenshots).
- Published price list (quote UI is the price).
- Sign-up changes; CTA reuses the existing /signin flow.

## Acceptance

- `/` renders the sections in "Order of the page" with the app screenshots.
- Lighthouse-sane: images lazy + sized, no layout shift from images
  (explicit dimensions), total landing image payload ≤ 1.5 MB.
- `npm test` and `next build` green; deployed via the normal
  main → staging flow (Vercel).
