# Terms and Privacy (web app)

**BL-08: the Terms of Use and Privacy Policy need a lawyer's look before
they go to production.**

Updated 2026-11-04 on `feat/lifelike-web` (owner decisions):

- Terms "Using your 3D outputs": commercial use only for outputs made with
  an active Business or Studio plan (rights stay with those outputs after
  the plan ends); all other outputs personal, non-commercial; outputs made
  before the effective date keep their earlier rights. Ownership stays
  with the user.
- Terms "Fees and payment" rewritten for today's model (pay per video,
  plans, quote as the maximum, whole minutes, above 30 fps with a plan,
  prepaid balance, charge timing, cancel window, monthly credit, taxes, no
  retroactive changes). Facts checked against the gateway README and
  BL-19. Notices go to legal@spatial-ai-labs.com (confirmed by the owner).
  One open point remains as a `[CHECK]` comment in the Privacy source: how
  long review cases are kept.
- Terms: the short Spatial Video Studio title at the start of videos.
- Privacy: RevenueCat (plan status), account settings (language, title
  on/off), prepaid balance records with Stripe, review cases and the
  download/play log (13 months).
- Effective date: `LEGAL_EFFECTIVE_DATE` in
  `src/components/legal/effectiveDate.ts`, a placeholder the owner sets
  when deploying.

Updated 2026-11-09 (owner): Commercial use is a +50% add-on on any plan
(Lifelike runs and previews; no title on those videos). Terms "Using your
3D outputs": outputs of runs bought with it may be used commercially;
Business and Studio no longer include it, except that outputs made on such
a plan before 9 November 2026, and on a plan active that day until its
next renewal, keep commercial use. The effective date was not changed.

Updated 2026-11-09 (owner): Business and Studio can no longer turn the
title off; only Commercial use removes it, on any plan. Terms section 8
and the Privacy Policy's "Account settings" no longer mention the switch.

Related copy: plan cards no longer list commercial use (the Plans section
notes it as an add-on on any plan); the pay sheet for a run without it
says "For personal use. Commercial use is an add-on for Lifelike 3D
videos."

The older file-retention draft is in `docs/drafts/files-retention-terms-privacy.md`.
