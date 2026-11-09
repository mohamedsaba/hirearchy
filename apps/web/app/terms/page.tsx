import Link from 'next/link';
import { Site, Kicker, Button } from '../home/site';

export const metadata = {
  title: 'Terms draft — Hirearchy',
  robots: { index: false, follow: false },
};

export default function LegalPage() {
  return (
    <Site>
      <section className="ct-legal-page">
        <Kicker>Draft for founder and legal review</Kicker>
        <h1>Website terms draft</h1>
        <p>
          This is a working outline, not approved or effective terms and not a
          legal policy. Founder and counsel must complete and approve it before
          publication or any product access.
        </p>
        <h2>Scope and availability</h2>
        <p>
          Hirearchy Software is an engineering-evaluation prototype. The current
          deployment is not public; acceptance checks use synthetic data. The
          Stage A preview may accept early-access interest after founder
          approval and legal review. There is no public signup, hosted pilot,
          service commitment, or published price. A form submission does not
          create an account, contract, or right to access.
        </p>
        <h2>Preview use</h2>
        <p>
          During local acceptance rehearsals, use synthetic values only. Any use
          of an activated preview must follow the approved privacy notice and
          these terms. Candidate code execution, live AI assistance, and
          automated email are disabled in the internal demo. The product
          presents evidence for a human evaluator; it does not issue a score or
          hiring decision.
        </p>
        <h2>Information submitted</h2>
        <p>
          The early-access form can record interest for an authorized operator
          when the preview is approved for activation. Current acceptance checks
          use synthetic values. Its behavior and storage are described in the{' '}
          <Link href="/privacy">privacy notice draft</Link>; the founder must
          approve its retention, deletion, and backup handling before
          activation.
        </p>
        <h2>Items requiring legal review</h2>
        <p>
          Before this draft can be published, counsel must specify the
          contracting entity, jurisdiction, intellectual-property terms,
          permitted user materials, service disclaimers, liability terms,
          notices, and contact channel. None is selected or approved here.
        </p>
        <Button href="/">Back to Hirearchy</Button>
      </section>
    </Site>
  );
}
