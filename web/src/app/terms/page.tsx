/**
 * /terms — static Terms of Use. Mirrors how billing actually works
 * (pay per video, a quote before every paid step, plans, prepaid balance)
 * — keep in sync with the gateway README and BL-19 when they change.
 * Plain-language on purpose. Commercial use of outputs needs a Business or
 * Studio plan (owner 2026-11-04). BL-08: a lawyer reviews this page before
 * production.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { FEEDBACK_EMAIL } from "@/lib/contact";
import { LEGAL_EFFECTIVE_DATE } from "@/components/legal/effectiveDate";
import { LegalSection, LegalShell } from "@/components/legal/LegalShell";

export const metadata: Metadata = {
  title: "Terms of Use",
  description:
    "The terms that govern your use of Spatial Video Studio on the web, including content ownership, use of outputs and payment.",
  alternates: { canonical: "/terms" },
};

/** Infringement and abuse notices (owner confirmed the mailbox,
 * 2026-11-04). */
const LEGAL_EMAIL = "legal@spatial-ai-labs.com";

export default function TermsPage() {
  return (
    <LegalShell title="Terms of Use" effective={LEGAL_EFFECTIVE_DATE}>
      <LegalSection title="1. Agreement">
        <p>
          These terms are a contract between you and Spatial AI Labs Ltd
          (&ldquo;we&rdquo;, &ldquo;us&rdquo;), a company registered in
          England and Wales with its registered office in London, United
          Kingdom, governing Spatial Video Studio on the web at stereo3d.studio (the &ldquo;Service&rdquo;). By creating an account or using the
          Service you accept them. If you use the Service for an
          organization, you accept on its behalf and confirm you may do so.
        </p>
      </LegalSection>

      <LegalSection title="2. The Service">
        <p>
          Spatial Video Studio on the web converts 2D video into
          stereoscopic 3D. The limits on source videos are shown in the
          app; limits and features may change, and availability is not
          guaranteed. We work hard to keep your projects intact, but you
          should keep your own copies of source material.
        </p>
      </LegalSection>

      <LegalSection title="3. Your account">
        <p>
          Keep your credentials secure and your account information
          accurate. You are responsible for activity under your account.
          You must be at least 16 years old to use the Service.
        </p>
      </LegalSection>

      <LegalSection title="4. Your content">
        <p>
          <strong>You keep ownership</strong> of the videos you upload and
          the 3D outputs the Service produces from them. You grant us a
          limited license to store, process and display your content — only
          as needed to operate the Service for you.
        </p>
        <p>
          You are responsible for having the rights to the videos you
          convert. Uploading content you do not own or have permission to
          use is a violation of these terms. We may remove content and
          suspend accounts in response to credible infringement reports or
          unlawful material. How you may use outputs commercially is set
          out in section 5.
        </p>
      </LegalSection>

      <LegalSection title="5. Using your 3D outputs">
        <p>
          Ownership stays with you; this section is about how you may use
          the outputs.
        </p>
        <ul>
          <li>Outputs made while you have an active Business or Studio
            plan may be used commercially: client work, advertising, sale
            or licensing, monetised channels and stock libraries. These
            rights stay with those outputs after the plan ends.</li>
          <li>All other outputs are for personal, non-commercial use.</li>
          <li>Outputs made before {LEGAL_EFFECTIVE_DATE} keep the rights
            they had when they were made.</li>
        </ul>
      </LegalSection>

      <LegalSection title="6. Acceptable use">
        <p>Do not use the Service to:</p>
        <ul>
          <li>process content you have no right to use;</li>
          <li>process unlawful content, or content that sexualizes or
            exploits minors (reported to authorities without notice);</li>
          <li>make non-consensual intimate imagery, or deepfakes of real
            people without their consent;</li>
          <li>harass or impersonate anyone, or invade someone&rsquo;s
            privacy;</li>
          <li>break export control or sanctions law;</li>
          <li>probe, overload, or interfere with the Service or other
            users&rsquo; work;</li>
          <li>resell the Service itself. Converting client footage
            you&rsquo;re authorised to work on needs a Business or Studio
            plan;</li>
          <li>reverse engineer the Service except where law permits.</li>
        </ul>
        <p>
          We don&rsquo;t review content before or after processing and
          aren&rsquo;t responsible for what users upload or make; you are
          solely responsible for your content and outputs.
        </p>
      </LegalSection>

      {/* Facts checked against the gateway README and BL-19 (2026-11-04):
          Pro on the web is a Weekly, Monthly or Yearly subscription
          (our own Stripe subscriptions, no passes); Studio bills yearly and its
          usage credit comes each month (gateway 00089). */}
      <LegalSection title="7. Fees and payment">
        <p>
          You <strong>pay per video</strong>. Optional plans lower the
          price: Pro (a weekly, monthly or yearly subscription), Business
          (billed monthly) and Studio (billed yearly).
          Before any paid step &mdash; a preview or a full video &mdash; you
          see a <strong>quote</strong>, and that is the most you are
          charged for it.
        </p>
        <ul>
          <li>A full video is priced per minute, and each started minute
            counts as a full minute. A preview is priced by its own
            length.</li>
          <li>Frame rates above 30 fps need a Business or Studio plan.</li>
          <li>You can pay from a prepaid balance, which you top up
            yourself or let reload automatically when it runs low, or with
            a saved payment method.</li>
          {/* TODO(BL-32): when deferred payments return, bring back
              "Smaller runs are charged after they finish; larger ones are
              charged when they start." */}
          <li>You pay before a run starts. Your credit and balance are
            used first. If nothing is delivered, you are refunded.</li>
          <li>You can cancel a run before it starts or within its first
            minute; after that it runs to the end.</li>
          <li>A plan&rsquo;s usage credit is given each month and
            doesn&rsquo;t carry over. If you cancel a plan, it runs to the
            end of the period you paid for.</li>
          {/* owner 2026-11-07 (gateway 00166): Pro's one-time credit; the
              amount and the days live in /v1/pricing and show on /pro and
              /pricing */}
          <li>Joining paid Pro, a free trial included, comes with usage
            credit once; so does the first time you sign in on the web with
            Pro from the app. It must be used within the period shown when
            you join, isn&rsquo;t paid out and is used before your balance.
            If you have more than one plan, only the credit of the highest
            one applies.</li>
          <li>Prices exclude any taxes we must collect, which are added.</li>
          <li>Prices may change, but never retroactively: a quote you
            accepted is honoured.</li>
        </ul>
        <p>
          If a payment fails we may retry it and pause new paid runs until
          it is settled. Billing questions or disputes:{" "}
          <a className="text-primary hover:underline" href={`mailto:${FEEDBACK_EMAIL}`}>{FEEDBACK_EMAIL}</a>
          {" "}&mdash; talk to us first; we would rather fix it than argue.
        </p>
      </LegalSection>

      <LegalSection title="8. Outputs and 3D viewing">
        <p>
          Automated 3D conversion is not perfect; review outputs before
          publishing them. Stereoscopic content can cause eye strain,
          dizziness or discomfort for some viewers — follow your headset
          manufacturer&rsquo;s comfort guidance, and take breaks. You are
          responsible for how and where you use the outputs.
        </p>
        <p>
          Videos may start with a short Spatial Video Studio title. Business and
          Studio plans can turn it off.
        </p>
        <p>
          Outputs may carry metadata (content credentials) and an invisible
          identifier showing they were made with Spatial Video Studio and
          which run they came from.
        </p>
      </LegalSection>

      <LegalSection title="9. Our intellectual property">
        <p>
          The Service — its software, models, design and branding — belongs
          to us and our licensors. These terms give you a right to use the
          Service, not a license to any of the above beyond that use.
        </p>
      </LegalSection>

      <LegalSection title="10. Feedback">
        <p>
          If you send us feedback or suggestions, we may use them without
          restriction or obligation to you. Please do send feedback.
        </p>
      </LegalSection>

      <LegalSection title="11. Disclaimers">
        <p>
          The Service is provided <strong>&ldquo;as is&rdquo; and
          &ldquo;as available&rdquo;</strong>, without warranties of any
          kind, express or implied, including fitness for a particular
          purpose and non-infringement. We do not warrant that the Service
          will be uninterrupted or error-free.
        </p>
      </LegalSection>

      <LegalSection title="12. Limitation of liability">
        <p>
          To the maximum extent permitted by law, we are not liable for
          indirect, incidental, special, consequential or punitive damages,
          or for lost profits, data or goodwill. Our total liability for
          all claims arising out of the Service is limited to the amounts
          you paid us in the twelve months before the event giving rise to
          the claim. This limit also covers our officers, directors and
          staff. Nothing in these terms limits liability that cannot be
          limited by law.
        </p>
        <p>
          The Service is provided by Spatial AI Labs Ltd; any claim
          relating to the Service must be brought against the company.
        </p>
      </LegalSection>

      <LegalSection title="13. Indemnification">
        <p>
          You will indemnify us against third-party claims arising from
          content you upload without sufficient rights, from your outputs
          and how you use them, or from your violation of these terms.
        </p>
      </LegalSection>

      <LegalSection title="14. Termination">
        <p>
          You can stop using the Service and ask us to delete your account
          at any time. We may suspend or terminate accounts that violate
          these terms or create risk for the Service; where reasonable, we
          will warn you first. Sections 4 (as to past processing), 5, 9,
          11–13 and 16 survive termination.
        </p>
      </LegalSection>

      <LegalSection title="15. Notice and takedown">
        <p>
          Send notices of infringement or abuse to{" "}
          <a className="text-primary hover:underline" href={`mailto:${LEGAL_EMAIL}`}>{LEGAL_EMAIL}</a>.
          We act on valid notices, may share account details with
          authorities where the law requires, and close the accounts of
          repeat infringers.
        </p>
      </LegalSection>

      <LegalSection title="16. Governing law">
        <p>
          These terms are governed by the laws of England and Wales, and
          disputes are subject to the exclusive jurisdiction of the courts
          of England and Wales, except where the law of your place of
          residence grants you non-waivable rights or venue.
        </p>
      </LegalSection>

      <LegalSection title="17. Changes to these terms">
        <p>
          We may update these terms as the Service evolves. Material
          changes will be announced in the app or by email, and continuing
          to use the Service after they take effect means you accept them.
          The effective date above always reflects the current version.
        </p>
      </LegalSection>

      <LegalSection title="18. Contact">
        <p>
          Spatial AI Labs Ltd, London, United Kingdom ·{" "}
          <a className="text-primary hover:underline" href={`mailto:${FEEDBACK_EMAIL}`}>{FEEDBACK_EMAIL}</a>
          {" "}· See also our{" "}
          <Link className="text-primary hover:underline" href="/privacy">
            Privacy Policy
          </Link>
          .
        </p>
      </LegalSection>
    </LegalShell>
  );
}
