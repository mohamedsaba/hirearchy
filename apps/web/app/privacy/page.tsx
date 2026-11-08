import { Site, Kicker, Button } from '../home/site';
export const metadata = {
  title: 'Privacy',
  robots: { index: false, follow: false },
};
export default function LegalPage() {
  return (
    <Site>
      <section className="ct-legal-page">
        <Kicker>Draft for founder and legal review</Kicker>
        <h1>Website privacy notice draft</h1>
        <p>
          This draft describes only the early-access request form. It is not an
          approved privacy policy or a compliance statement and must be reviewed
          before public use.
        </p>
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
          An authorized Hirearchy operator can review requests from the
          application host and may use the details to consider the request and
          follow up manually. Automated email and follow-up are not configured.
          No public account or pilot access is created by submitting the form.
        </p>
        <h2>Storage and retention</h2>
        <p>
          Requests are stored in the application data volume and remain there
          until an authorized operator deletes them. There is no automatic
          expiry or deletion schedule, and a deletion request process has not
          been approved. Do not submit candidate information, credentials,
          secrets, or other sensitive details.
        </p>
        <p>
          Founder and legal review must set the retention period and deletion
          channel before this notice or the intake form is used publicly.
        </p>
        <Button href="/">Back to Hirearchy</Button>
      </section>
    </Site>
  );
}
