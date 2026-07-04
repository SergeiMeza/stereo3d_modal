/**
 * /privacy — static Privacy Policy. Written to match how the product
 * actually works today (Firebase auth, Google Cloud storage/Firestore,
 * Stripe billing, cloud GPU processing); update it when the data flow
 * changes. Plain-language on purpose — same voice as the rest of the app.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { FEEDBACK_EMAIL } from "@/components/FeedbackLink";
import { LegalSection, LegalShell } from "@/components/legal/LegalShell";

export const metadata: Metadata = {
  title: "Privacy Policy — Stereo3D Studio",
  description:
    "How Stereo3D Studio collects, uses, stores and protects your data.",
};

export default function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy" effective="July 4, 2026">
      <LegalSection title="1. Who we are">
        <p>
          Stereo3D Studio (the &ldquo;Service&rdquo;) is a 2D-to-3D video
          conversion product operated by Spatial AI Labs Ltd
          (&ldquo;we&rdquo;, &ldquo;us&rdquo;), a company registered in
          England and Wales with its registered office in London, United
          Kingdom. This policy explains what data we collect when you use
          the Service, why we collect it, and the choices you have.
          Questions or requests: <a className="text-primary hover:underline" href={`mailto:${FEEDBACK_EMAIL}`}>{FEEDBACK_EMAIL}</a>.
        </p>
      </LegalSection>

      <LegalSection title="2. Information we collect">
        <p>
          <strong>Account information.</strong> When you sign in we receive
          your email address and, if you use Google sign-in, your name and
          profile photo from Google. We assign your account an internal user
          ID.
        </p>
        <p>
          <strong>Billing information.</strong> Payments are processed by
          Stripe. Your card number never touches our servers — Stripe stores
          it and gives us a customer reference plus card metadata (brand and
          last four digits) so you can recognize the card on file. We keep
          records of quotes, charges, holds and receipts for the jobs you
          run.
        </p>
        <p>
          <strong>Your content.</strong> The videos you upload and everything
          the Service derives from them — scene cuts, depth maps, previews
          and finished 3D renders — are stored so you can work on and
          download them.
        </p>
        <p>
          <strong>Usage and technical data.</strong> Standard server logs
          (IP address, browser type, request timestamps) and job records
          (what was run, how long it took, what it cost). We use these to
          operate the Service, prevent abuse and debug problems. We use
          cookies and similar storage only to keep you signed in — not for
          advertising.
        </p>
      </LegalSection>

      <LegalSection title="3. How we use your information">
        <ul>
          <li>To provide the Service: storing your uploads, running the
            conversions you request on cloud GPUs, and delivering the
            results back to you.</li>
          <li>To bill you: quoting, charging the card on file, issuing
            receipts and handling payment issues.</li>
          <li>To support you: responding when you contact us, and
            investigating failed jobs.</li>
          <li>To protect the Service: detecting abuse, enforcing limits and
            keeping the platform secure.</li>
          <li>To improve the Service: aggregate, non-identifying usage
            metrics (job sizes, durations, failure rates).</li>
        </ul>
        <p>
          <strong>We do not sell your data. We do not use your videos to
          train machine-learning models. We do not show ads.</strong> Your
          content is processed only to produce the outputs you asked for.
        </p>
      </LegalSection>

      <LegalSection title="4. Where your data lives and who processes it">
        <p>
          Your data is stored and processed on infrastructure in the United
          States. Because we are a UK company, this means your data is
          transferred outside the UK; those transfers rely on our
          processors&rsquo; recognized safeguards (such as the UK
          extension to the EU&ndash;US Data Privacy Framework and standard
          contractual clauses). We use a small set of processors, each only
          for what it says:
        </p>
        <ul>
          <li><strong>Google Cloud / Firebase</strong> — authentication,
            video and artifact storage, and our database.</li>
          <li><strong>Stripe</strong> — payment processing and card
            storage.</li>
          <li><strong>Cloud GPU providers</strong> — the compute that runs
            your conversions; your video frames pass through their machines
            during a job.</li>
          <li><strong>Vercel</strong> — hosting for the web application.</li>
        </ul>
        <p>
          We share data with no one else, except if required by law or to
          protect the Service and its users.
        </p>
      </LegalSection>

      <LegalSection title="5. Retention and deletion">
        <p>
          Uploads and derived artifacts are kept while the project that owns
          them exists, so you can come back to your work. Delete a project
          (or ask us to delete your account) and the associated content is
          removed from active systems, with residual copies purged from
          backups on a rolling basis. Billing records are retained as long
          as tax and accounting law requires.
        </p>
      </LegalSection>

      <LegalSection title="6. Security">
        <p>
          All traffic is encrypted in transit. Content is accessed through
          short-lived signed URLs scoped to your account, and internal
          access is limited to what operating the Service requires. No
          system is perfectly secure — if we learn of a breach affecting
          your data, we will notify you.
        </p>
      </LegalSection>

      <LegalSection title="7. Your rights">
        <p>
          You can access and update account details in the app. You can ask
          us to export or delete your data, or to correct anything we hold
          about you, by emailing{" "}
          <a className="text-primary hover:underline" href={`mailto:${FEEDBACK_EMAIL}`}>{FEEDBACK_EMAIL}</a>.
          Under the UK GDPR (and, where it applies, the EU GDPR) you have
          rights of access, rectification, erasure, restriction,
          portability and objection, and the right to complain to the
          UK Information Commissioner&rsquo;s Office (ICO); we honor
          reasonable requests regardless of jurisdiction.
        </p>
      </LegalSection>

      <LegalSection title="8. Children">
        <p>
          The Service is not directed at children and may not be used by
          anyone under 16. We do not knowingly collect data from children.
        </p>
      </LegalSection>

      <LegalSection title="9. Changes to this policy">
        <p>
          We may update this policy as the Service evolves. Material changes
          will be announced in the app or by email, and the effective date
          above always reflects the current version.
        </p>
      </LegalSection>

      <LegalSection title="10. Contact">
        <p>
          Spatial AI Labs Ltd, London, United Kingdom ·{" "}
          <a className="text-primary hover:underline" href={`mailto:${FEEDBACK_EMAIL}`}>{FEEDBACK_EMAIL}</a>
          {" "}· See also our{" "}
          <Link className="text-primary hover:underline" href="/terms">
            Terms of Use
          </Link>
          .
        </p>
      </LegalSection>
    </LegalShell>
  );
}
