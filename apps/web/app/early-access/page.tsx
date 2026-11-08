import { Site, Kicker, Button } from '../home/site';
import { EarlyAccessForm } from '../home/early-access-form';

export const metadata = {
  title: 'Request Early Access & Pilot Evaluation — Hirearchy',
  description:
    'Join our design partner cohort or request a supervised alpha pilot for your engineering team. Experience evidence-first technical hiring with verifiable source citations.',
};

export default function EarlyAccessPage() {
  return (
    <Site>
      <section
        className="ct-page-hero ct-page-hero--white ct-reveal"
        style={{ minHeight: 0 }}
      >
        <Kicker>Design Partner Program & Pilot Inquiries</Kicker>
        <h1 className="ct-enter">Request early access or pilot evaluation.</h1>
        <p>
          We are partnering with engineering leaders who want to move beyond
          LeetCode puzzles and opaque automated scoring. Connect with our team
          to explore a supervised alpha pilot or evaluate our evidence workbench
          on upcoming senior engineering roles.
        </p>
        <div className="ct-contact-links">
          <Button href="/products/software">Explore Software</Button>
          <Button href="/products/software#demo-limits">See demo limits</Button>
        </div>
      </section>

      <section
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
