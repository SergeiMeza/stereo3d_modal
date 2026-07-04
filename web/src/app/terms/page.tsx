/**
 * /terms — static Terms of Use. Mirrors how billing actually works
 * (pay-as-you-go, binding quote per job, charge on success, holds for
 * large jobs) — keep in sync with the gateway's billing behavior when it
 * changes. Plain-language on purpose.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { FEEDBACK_EMAIL } from "@/components/FeedbackLink";
import { LegalSection, LegalShell } from "@/components/legal/LegalShell";

export const metadata: Metadata = {
  title: "Terms of Use — Stereo3D Studio",
  description:
    "The terms that govern your use of Stereo3D Studio, including content ownership, payment and beta conditions.",
};

export default function TermsPage() {
  return (
    <LegalShell title="Terms of Use" effective="July 4, 2026">
      <LegalSection title="1. Agreement">
        <p>
          These terms are a contract between you and Spatial AI Labs
          (&ldquo;we&rdquo;, &ldquo;us&rdquo;) governing Stereo3D Studio
          (the &ldquo;Service&rdquo;). By creating an account or using the
          Service you accept them. If you use the Service for an
          organization, you accept on its behalf and confirm you may do so.
        </p>
      </LegalSection>

      <LegalSection title="2. The Service (beta)">
        <p>
          Stereo3D Studio converts 2D video into stereoscopic 3D. The
          Service is currently in <strong>beta</strong>: source videos are
          limited (today: up to 5 minutes and below 4K resolution), limits
          and features may change, and availability is not guaranteed. We
          work hard to keep your projects intact, but during the beta you
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
          unlawful material.
        </p>
      </LegalSection>

      <LegalSection title="5. Acceptable use">
        <p>Do not use the Service to:</p>
        <ul>
          <li>process content you have no right to use;</li>
          <li>process unlawful content, or content that sexualizes or
            exploits minors (reported to authorities without notice);</li>
          <li>probe, overload, or interfere with the Service or other
            users&rsquo; work;</li>
          <li>resell the Service itself (converting client footage you are
            authorized to work on is fine);</li>
          <li>reverse engineer the Service except where law permits.</li>
        </ul>
      </LegalSection>

      <LegalSection title="6. Fees and payment">
        <p>
          The Service is <strong>pay-as-you-go</strong>: no subscription,
          no minimum. You add a payment card, and each paid job (previews
          and production renders) shows a <strong>quote before it
          starts</strong> — that quoted price is binding and is what you
          are charged. Larger jobs may place a temporary authorization hold
          for the quoted amount when they start.
        </p>
        <ul>
          <li>You are only charged for jobs that complete successfully;
            failed jobs are not charged and holds are released.</li>
          <li>Production renders that reuse work from your previews are
            discounted, as shown in the quote.</li>
          <li>Prices may change at any time, but never retroactively — a
            quote you accepted is honored.</li>
          <li>Quoted prices are exclusive of any taxes we are required to
            collect.</li>
        </ul>
        <p>
          If a charge fails we may retry it and pause new paid jobs until
          the balance is settled. Billing questions or disputes:{" "}
          <a className="text-primary hover:underline" href={`mailto:${FEEDBACK_EMAIL}`}>{FEEDBACK_EMAIL}</a>
          {" "}— talk to us first; we would rather fix it than argue.
        </p>
      </LegalSection>

      <LegalSection title="7. Outputs and 3D viewing">
        <p>
          Automated 3D conversion is not perfect; review outputs before
          publishing them. Stereoscopic content can cause eye strain,
          dizziness or discomfort for some viewers — follow your headset
          manufacturer&rsquo;s comfort guidance, and take breaks. You are
          responsible for how and where you use the outputs.
        </p>
      </LegalSection>

      <LegalSection title="8. Our intellectual property">
        <p>
          The Service — its software, models, design and branding — belongs
          to us and our licensors. These terms give you a right to use the
          Service, not a license to any of the above beyond that use.
        </p>
      </LegalSection>

      <LegalSection title="9. Feedback">
        <p>
          If you send us feedback or suggestions, we may use them without
          restriction or obligation to you. (Please do — the Service is in
          beta because we want it.)
        </p>
      </LegalSection>

      <LegalSection title="10. Disclaimers">
        <p>
          The Service is provided <strong>&ldquo;as is&rdquo; and
          &ldquo;as available&rdquo;</strong>, without warranties of any
          kind, express or implied, including fitness for a particular
          purpose and non-infringement. Beta software has rough edges; we
          do not warrant that the Service will be uninterrupted or
          error-free.
        </p>
      </LegalSection>

      <LegalSection title="11. Limitation of liability">
        <p>
          To the maximum extent permitted by law, we are not liable for
          indirect, incidental, special, consequential or punitive damages,
          or for lost profits, data or goodwill. Our total liability for
          all claims arising out of the Service is limited to the amounts
          you paid us in the twelve months before the event giving rise to
          the claim. Nothing in these terms limits liability that cannot be
          limited by law.
        </p>
      </LegalSection>

      <LegalSection title="12. Indemnification">
        <p>
          You will indemnify us against third-party claims arising from
          content you upload without sufficient rights, or from your
          violation of these terms.
        </p>
      </LegalSection>

      <LegalSection title="13. Termination">
        <p>
          You can stop using the Service and ask us to delete your account
          at any time. We may suspend or terminate accounts that violate
          these terms or create risk for the Service; where reasonable, we
          will warn you first. Sections 4 (as to past processing), 8, and
          10–14 survive termination.
        </p>
      </LegalSection>

      <LegalSection title="14. Governing law">
        <p>
          These terms are governed by the laws of Japan, and disputes are
          subject to the exclusive jurisdiction of the Tokyo District
          Court, except where the law of your place of residence grants you
          non-waivable rights or venue.
        </p>
      </LegalSection>

      <LegalSection title="15. Changes to these terms">
        <p>
          We may update these terms as the Service evolves. Material
          changes will be announced in the app or by email, and continuing
          to use the Service after they take effect means you accept them.
          The effective date above always reflects the current version.
        </p>
      </LegalSection>

      <LegalSection title="16. Contact">
        <p>
          Spatial AI Labs ·{" "}
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
