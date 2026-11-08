import { Site, Kicker, Button } from '../../home/site';

export const metadata = {
  title: 'Hirearchy Software — Realistic Engineering Evidence & Human Review',
  description:
    'Evaluate software engineers on realistic, role-relevant codebases. Chronological observable evidence reconstruction with inspectable source citations. No automated scores.',
};

export default function SoftwarePage() {
  return (
    <Site dark>
      <section className="ct-page-hero ct-page-hero--dark ct-reveal">
        <Kicker>
          Hirearchy Software / Evidence-First Technical Evaluation
        </Kicker>
        <h1 className="ct-enter">
          See engineering
          <br />
          work in context.
        </h1>
        <p>
          Evaluate software engineers on bounded, realistic codebases.
          Reconstruct candidate actions chronologically, inspect verifiable code
          diffs, and cite concrete evidence in human-owned reviews—with zero
          automated scores or algorithmic rejections.
        </p>
        <div className="ct-contact-links" style={{ marginTop: '24px' }}>
          <Button href="/early-access" light>
            Request early access
          </Button>
          <Button href="#demo-limits" light>
            See demo limits
          </Button>
        </div>
      </section>

      <section className="ct-editorial ct-editorial--lilac ct-reveal">
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

      <section className="ct-editorial ct-reveal">
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
            <h3>Visible uncertainty & neutral AI recording.</h3>
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
        className="ct-editorial ct-editorial--lilac ct-reveal"
        id="demo-limits"
        data-testid="software-staging-limits"
      >
        <h2 className="ct-enter">What this internal demo supports</h2>
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
          Request a conversation about future access. The current product is a
          synthetic internal demo; no hosted pilot or public signup is available
          yet.
        </p>
        <div className="ct-contact-links" style={{ justifyContent: 'center' }}>
          <Button href="/early-access" light>
            Request early access
          </Button>
        </div>
      </section>
    </Site>
  );
}
