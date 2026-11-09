import { Site, Kicker, Button } from '../home/site';

export const metadata = {
  title: 'Privacy draft — Hirearchy',
  robots: { index: false, follow: false },
};

export default function LegalPage() {
  return (
    <Site>
      <section className="ct-legal-page">
        <Kicker>Draft for founder and legal review</Kicker>
        <h1>Early-access form privacy notice draft</h1>
        <p>
          This working draft describes the early-access form. It is not an
          approved privacy policy or a compliance statement. At the time of this
          draft, no public deployment is active and acceptance checks use
          synthetic values. The Stage A preview is intended to record real
          early-access interest only after founder approval; this notice must be
          reviewed before then.
        </p>
        <h2>Information collected</h2>
        <p>
          The form collects your name, work email, company or team, role,
          engineering team size, selected challenge, and optional note. The
          stored request record does not include a client IP address or browser
          user-agent. The application ignores forwarded-IP headers for rate
          limiting and applies a shared limit of five requests per 15 minutes
          across visitors to its single app process. This draft does not
          describe separate infrastructure-provider or network access logs.
        </p>
        <h2>Use and access</h2>
        <p>
          The form stores requests for an authorized operator to review on the
          application host. Current acceptance checks use synthetic values.
          There is no public signup or hosted pilot, and submitting the form
          does not create an account or grant access. No automated email or
          follow-up is configured. The founder must approve the service, privacy
          notice, and deletion process before real requests are accepted. Do not
          submit candidate information, code, credentials, or secrets.
        </p>
        <h2>Storage, export, and deletion</h2>
        <p>
          Requests are stored in a JSON file on the application data volume. No
          automatic expiry or retention period is configured. A host operator
          can preview a selection and explicitly delete by request ID or a
          chosen UTC cutoff; this is not a public deletion service. An export
          creates a separate protected copy. A deletion from the active file
          does not remove copies in exports or backups. It is complete only
          after the operator confirms that every affected copy was securely
          removed or expired. If a backup is restored, the same deletion must be
          applied before intake resumes.
        </p>
        <p>
          No numeric retention period, deletion-request contact, or backup
          expiry schedule has been approved. Founder and legal review must set
          them before public use. The informational contact page does not accept
          privacy requests.
        </p>
        <Button href="/">Back to Hirearchy</Button>
      </section>
    </Site>
  );
}
