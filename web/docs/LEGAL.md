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
  BL-19; open points carry `[CHECK]` comments in the page source.
- Terms: the short Stereo3D Studio title at the start of videos.
- Privacy: RevenueCat (plan status), account settings (language, title
  on/off), prepaid balance records with Stripe, review cases and the
  download/play log (13 months).
- Effective date: `LEGAL_EFFECTIVE_DATE` in
  `src/components/legal/effectiveDate.ts`, a placeholder the owner sets
  when deploying.

Related copy: plan cards say "Commercial use of your videos"; the pay
sheet without a plan says "For personal use. Commercial use comes with
Business and Studio plans."

The older file-retention draft is in `docs/drafts/files-retention-terms-privacy.md`.
