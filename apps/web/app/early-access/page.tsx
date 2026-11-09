import { Site, Kicker, Button } from '../home/site';
import { EarlyAccessForm } from '../home/early-access-form';

export const metadata = {
  title: 'Request Early Access & Pilot Evaluation — Hirearchy',
  description:
    'Request an early-access conversation about Hirearchy Software, an engineering-evaluation prototype built around observable work and human review.',
};

export default function EarlyAccessPage() {
  return (
    <Site>
      <section
        className="ct-page-hero ct-page-hero--white ct-reveal"
        style={{ minHeight: 0 }}
      >
        <Kicker>Early access interest</Kicker>
        <h1 className="ct-enter">Request an early-access conversation.</h1>
        <p>
          Hirearchy Software is an engineering-evaluation prototype. This form
          records interest for operator review; there is no public signup or
          hosted pilot available yet. Candidate code execution, live AI
          assistance, and automated email are disabled in the current demo.
        </p>
        <div className="ct-contact-links">
          <Button href="#early-access-form">Request early access</Button>
          <Button href="/products/software">Explore Software</Button>
          <Button href="/products/software#demo-limits">See demo limits</Button>
        </div>
      </section>

      <section
        id="early-access-form"
        aria-labelledby="early-access-form-heading"
        tabIndex={-1}
        className="ct-editorial ct-editorial--lilac ct-reveal"
        style={{ paddingTop: '2.5cqw', paddingBottom: '4cqw' }}
      >
        <div style={{ maxWidth: '820px', margin: '0 auto', width: '100%' }}>
          <EarlyAccessForm />
        </div>
      </section>
    </Site>
  );
}
