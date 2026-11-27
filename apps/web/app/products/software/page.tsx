import Link from 'next/link';
import { PAID_PLAN_ORDER, PLAN_CATALOG } from '../../../src/plans/entitlements';
import { MarketingProofStrip } from '../../_components/marketing-proof-strip';
import { RoiCalculator } from '../../_components/roi-calculator';
import { Site, Kicker, Button, Arrow } from '../../home/site';

export const metadata = {
  title: 'Hirearchy Software — Anti-Proctoring, Evidence-First Evaluation',
  description:
    'Evaluate software engineers on bounded, role-relevant codebases. Chronological observable evidence, diffs, execution outputs, and neutral AI logs—zero webcam surveillance and human-owned verdicts.',
};

const funnelComparisonRows = [
  [
    'Task realism',
    'Isolated algorithmic puzzles & syntax trivia disconnected from day-to-day work.',
    'Bounded repository tasks: debugging, concurrency conflict resolution, and PR-style changes.',
  ],
  [
    'Candidate treatment',
    'Webcam/eye-tracking, desktop lockdowns, and high false-positive flags that alienate senior engineers.',
    'Zero spyware, upfront candidate-data-v1 consent, and a read-only submission receipt.',
  ],
  [
    'AI policy',
    'Error-prone AI detectors guessing hidden intent from typing pauses or code phrasing.',
    'Neutral recording of observable workspace AI interactions; never penalizes normal engineering work (ADR 0008 / ADR 0003).',
  ],
  [
    'Decision ownership',
    'Black-box percentile cutoffs and opaque pass/fail thresholds.',
    'Immutable r27 evidence timeline + optional advisory AI summary (ADR 0006, Ultra) + human-authored r210 verdict packet.',
  ],
];

export default function SoftwarePage() {
  return (
    <Site dark>
      <section className="ct-page-hero ct-page-hero--dark ct-reveal">
        <Kicker>
          Hirearchy Software / Anti-Proctoring, Evidence-First Evaluation
        </Kicker>
        <h1 className="ct-enter">
          Real codebase work.
          <br />
          Zero surveillance.
        </h1>
        <p>
          Evaluate engineers on bounded, role-relevant repositories. Inspect
          chronological file revisions, diffs, execution outputs, and neutral AI
          logs—with zero webcam tracking, zero algorithmic rankings, and
          human-owned verdicts.
        </p>
        <div
          className="ct-contact-links"
          style={{ marginTop: '24px', alignItems: 'center' }}
        >
          <Button href="/early-access" light>
            Request early access
          </Button>
          <Button href="/demo" light>
            Try live reviewer demo
          </Button>
          <Link
            className="ct-hero-secondary-link"
            href="/trust"
            prefetch={false}
          >
            Read Trust &amp; Candidate Standard <Arrow />
          </Link>
        </div>
      </section>

      <section
        className="ct-proof-section ct-reveal"
        aria-label="Platform design standards and live metrics"
      >
        <MarketingProofStrip variant="full" />
      </section>

      <section
        className="ct-editorial ct-editorial--lilac ct-reveal"
        id="comparison"
        data-chapter="Comparison"
      >
        <Kicker>Why senior engineers drop out</Kicker>
        <h2 className="ct-enter" style={{ marginTop: '18px' }}>
          The Old Funnel vs. Hirearchy Software
        </h2>
        <div className="ct-contrast-table-wrap">
          <table className="ct-contrast-table">
            <caption className="ct-sr-only">
              Comparison between legacy screening funnels and Hirearchy Software
            </caption>
            <thead>
              <tr>
                <th scope="col">Dimension</th>
                <th scope="col">The Old Funnel</th>
                <th scope="col">Hirearchy Software</th>
              </tr>
            </thead>
            <tbody>
              {funnelComparisonRows.map(([dimension, oldWay, hirearchyWay]) => (
                <tr key={dimension}>
                  <th scope="row">{dimension}</th>
                  <td>{oldWay}</td>
                  <td className="ct-contrast-win">{hirearchyWay}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="ct-editorial ct-reveal">
        <h2 className="ct-enter">The work. The record.</h2>
        <div className="ct-record-grid">
          <article className="ct-record ct-enter">
            <Kicker>Illustrative task</Kicker>
            <h3>Make a focused engineering change.</h3>
            <p>
              Candidates work on a bounded scenario like{' '}
              <em>Reservation Moves v3</em>—reading the starter codebase,
              resolving scheduling conflicts, saving revisions, and submitting
              for assigned evaluator review.
            </p>
          </article>
          <article className="ct-record ct-enter">
            <Kicker>Illustrative record</Kicker>
            <ol>
              <li>Workspace revision saved with verifiable diffs</li>
              <li>Candidate submission recorded into chronological timeline</li>
              <li>
                Evaluator observation linked directly to its source evidence
              </li>
            </ol>
          </article>
        </div>
      </section>

      <section className="ct-editorial ct-editorial--lilac ct-reveal">
        <h2 className="ct-enter">
          Evidence informs.
          <br />
          People decide.
        </h2>
        <p
          className="ct-enter"
          style={{ maxWidth: '680px', marginBottom: '36px' }}
        >
          Our platform architecture reflects our product principles. We separate
          observable facts from human judgment.
        </p>

        <ol className="ct-principles">
          <li className="ct-enter">
            <span>01</span>
            <h3>No automated scoring or rankings.</h3>
            <p>
              Hirearchy never outputs a numerical score, competence percentile,
              or automated pass/fail decision. Software engineering is too
              multidimensional for false precision. Your engineers make the
              decision; Hirearchy provides the evidence.
            </p>
          </li>
          <li className="ct-enter">
            <span>02</span>
            <h3>Inspectable, citable provenance.</h3>
            <p>
              Evaluators can link observations to saved revisions or timeline
              events, then review the supporting evidence during a debrief.
            </p>
          </li>
          <li className="ct-enter">
            <span>03</span>
            <h3>Visible uncertainty &amp; neutral AI recording.</h3>
            <p>
              Observable interactions with tooling are recorded neutrally. We do
              not run error-prone AI detectors or guess candidate mental states.
              We surface what happened, and let your evaluators interpret its
              relevance to your hiring bar.
            </p>
          </li>
        </ol>
      </section>

      <section
        className="ct-editorial ct-reveal"
        id="pricing"
        data-chapter="ROI & Plans"
      >
        <Kicker>Value-anchored plans</Kicker>
        <h2 className="ct-enter" style={{ marginTop: '18px' }}>
          Reclaim senior engineering hours.
        </h2>
        <p style={{ maxWidth: '720px', marginBottom: '32px' }}>
          Model the engineering hours saved by replacing unstructured live
          screens and manual take-home grading—and match your hiring volume to
          the right plan.
        </p>

        <RoiCalculator />

        <div className="ct-plan-summary-grid" aria-label="Available plan tiers">
          {PAID_PLAN_ORDER.map((tierId) => {
            const plan = PLAN_CATALOG[tierId];
            return (
              <article
                className={`ct-plan-summary-card${tierId === 'ultra' ? ' ct-plan-summary-card--featured' : ''}`}
                key={plan.id}
              >
                <div className="ct-plan-summary-head">
                  <span className="ct-plan-summary-badge">
                    {plan.badgeLabel}
                  </span>
                  {tierId === 'ultra' && (
                    <span className="ct-plan-summary-rec">Recommended</span>
                  )}
                </div>
                <h3>{plan.priceLabel}</h3>
                <p>{plan.tagline}</p>
                <ul>
                  {plan.highlights.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
        <p className="ct-plan-trust-note">
          No automated candidate verdicts. Every tier keeps human evaluators in
          full control of hiring decisions.
        </p>
      </section>

      <section
        className="ct-editorial ct-editorial--lilac ct-reveal"
        id="demo-limits"
        data-testid="software-staging-limits"
        data-chapter="Staging scope"
      >
        <Kicker>Radical engineering transparency</Kicker>
        <h2 className="ct-enter" style={{ marginTop: '18px' }}>
          Current staging scope &amp; engineering boundaries
        </h2>
        <p className="ct-enter" style={{ maxWidth: '720px' }}>
          Integrated AI assistance and code execution are unavailable in this
          internal demo. AI use carries no automatic positive or negative
          judgement, and the demo does not infer whether code came from AI or
          any other source.
        </p>
        <div style={{ maxWidth: '720px', marginTop: '20px' }}>
          <ul
            style={{
              paddingLeft: '24px',
              lineHeight: '1.6',
              color: 'var(--ct-ink)',
            }}
          >
            <li style={{ marginBottom: '12px' }}>
              <strong>Live Untrusted Code Execution:</strong> Live backend
              execution of untrusted candidate code is disabled pending our
              hardened container isolation release gate. Candidates work against
              deterministic starter code and save verifiable file revisions.
            </li>
            <li style={{ marginBottom: '12px' }}>
              <strong>Integrated Live AI Assistance:</strong> Interactive LLM
              assistance is disabled in this staging demo. Candidate actions are
              recorded neutrally without speculating on AI origins.
            </li>
            <li style={{ marginBottom: '12px' }}>
              <strong>Automated Email Delivery (SMTP):</strong> Outbound SMTP
              delivery is disabled. An authorized recruiter can copy a candidate
              invitation from the internal demo; evaluators sign in to review
              assigned sessions.
            </li>
          </ul>
        </div>
      </section>

      <section
        className="ct-contact-cta ct-reveal"
        style={{ background: 'var(--ct-plum)', color: '#ffffff' }}
        data-testid="software-pilot-cta"
      >
        <Kicker>Early access interest</Kicker>
        <h2 style={{ color: '#ffffff' }}>
          Ready to evaluate real engineering work?
        </h2>
        <p
          style={{
            color: '#cfc6dc',
            maxWidth: '600px',
            margin: '16px auto 28px',
          }}
        >
          Try the zero-signup reviewer sandbox or request an early-access
          conversation for your team.
        </p>
        <div className="ct-contact-links" style={{ justifyContent: 'center' }}>
          <Button href="/early-access" light>
            Request early access
          </Button>
          <Button href="/demo" light>
            Try live reviewer demo
          </Button>
          <Link
            className="ct-hero-secondary-link"
            href="/trust"
            prefetch={false}
          >
            Read Trust &amp; Candidate Standard <Arrow />
          </Link>
        </div>
      </section>
    </Site>
  );
}
