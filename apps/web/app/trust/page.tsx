import type { ReactNode } from 'react';
import Link from 'next/link';
import { Site, Kicker, Button, Arrow } from '../home/site';
import { R26_CANDIDATE_DATA_NOTICE_VERSION } from '../../src/r26-candidate/contract';

export const metadata = {
  title: 'Trust, Privacy & Candidate Respect',
  description:
    'How Hirearchy earns senior engineers’ trust: zero webcam proctoring, explicit candidate-data-v1 consent, neutral AI logging, hardened Docker sandboxing, and PostgreSQL FORCE ROW LEVEL SECURITY.',
};

const aiAndHumanFinality = [
  [
    'No AI authorship witch-hunts.',
    'Hirearchy never runs error-prone AI-detection classifiers or infers hidden mental state from typing pauses or coding style. Generated assessment style observations (ADR 0008) are strictly labeled non-evidentiary and excluded from r27 evidence and r210 review packets.',
  ],
  [
    'Neutral workspace AI logging (r212).',
    'When an organization enables the workspace AI assistant, prompts and responses are recorded neutrally as observable tooling context alongside file revisions—never auto-penalized and never hidden from the candidate’s policy disclosure.',
  ],
  [
    'Strict isolation of advisory AI (ADR 0006).',
    'Optional advisory AI Candidate Reviews live in an isolated synthesis layer. Immutable PostgreSQL evidence (r27), file revision diffs (r28), anchored evaluator observations (r29), and finalized review packets (r210) remain human-authored and free of automated candidate verdicts.',
  ],
];

const architectureSpecs: ReadonlyArray<
  readonly [surface: string, mechanism: ReactNode, scope: string]
> = [
  [
    'Candidate consent',
    <>
      Explicit <code>{R26_CANDIDATE_DATA_NOTICE_VERSION}</code> SHA-256 notice
      before session activation
    </>,
    'Active candidate workspaces',
  ],
  [
    'Execution containment',
    <>
      Docker <code>--network none</code>, <code>--read-only</code>,{' '}
      <code>--cap-drop ALL</code>, <code>no-new-privileges</code>, UID 1000
      subreaper
    </>,
    'Restricted-executor runtime (gated off in synthetic demo)',
  ],
  [
    'Submission finality',
    <>
      Whole-container cgroup pause (<code>docker pause</code>) + ephemeral
      read-only helper diff capture
    </>,
    'Dedicated hirearchy-ws-* named volume',
  ],
  [
    'Tenant data isolation',
    <>
      PostgreSQL <code>FORCE ROW LEVEL SECURITY</code> across tenant tables (
      <code>0001–0023</code>)
    </>,
    'Org-scoped sessions, library, credits & decisions',
  ],
  [
    'Privilege separation',
    <>
      <code>app_candidate_gateway</code> restricted to{' '}
      <code>r26_candidate_command</code> &amp; lifecycle readiness; runtime RPCs
      in <code>staging</code> schema
    </>,
    'Database role & schema boundary',
  ],
  [
    'Session & mutation safety',
    <>
      HTTP-only <code>__Host-r23-session</code>, double-submit{' '}
      <code>__Host-r23-csrf</code>, same-origin checks,{' '}
      <code>expectedVersion</code> + <code>requestId</code>
    </>,
    'Authenticated team & candidate APIs',
  ],
];

export default function TrustPage() {
  return (
    <Site dark>
      <section className="ct-page-hero ct-page-hero--dark ct-reveal">
        <Kicker>Trust, Privacy &amp; Candidate Respect</Kicker>
        <h1 className="ct-enter">
          Built to earn senior
          <br />
          engineers&apos; trust.
        </h1>
        <p>
          Hiring tools shouldn&apos;t treat candidates like suspects or turn
          human judgment into black-box numbers. Here is exactly what Hirearchy
          captures, isolates, and refuses to build.
        </p>
        <nav className="ct-chapter-jumps" aria-label="Trust standard chapters">
          <a className="ct-chapter-jump" href="#candidate-respect">
            <span className="ct-chapter-jump-num">01</span>
            <span>Anti-Proctoring</span>
          </a>
          <a className="ct-chapter-jump" href="#neutral-ai">
            <span className="ct-chapter-jump-num">02</span>
            <span>Neutral AI</span>
          </a>
          <a className="ct-chapter-jump" href="#sandboxing-and-isolation">
            <span className="ct-chapter-jump-num">03</span>
            <span>Sandboxing &amp; RLS</span>
          </a>
        </nav>
        <div className="ct-contact-links ct-contact-links--hero">
          <Button href="/demo" light>
            Try live reviewer demo
          </Button>
          <Link
            className="ct-button-secondary ct-button-secondary--dark"
            href="/early-access"
            prefetch={false}
          >
            Request early access
          </Link>
        </div>
      </section>

      <section
        className="ct-editorial ct-editorial--lilac ct-reveal"
        id="candidate-respect"
        data-chapter="Candidate Respect"
      >
        <Kicker>Pillar 01 / Anti-Proctoring Pledge</Kicker>
        <h2 className="ct-enter" style={{ marginTop: '18px' }}>
          The Candidate Respect Standard.
        </h2>
        <p style={{ marginBottom: '36px' }}>
          Invasive browser lockdowns and webcam proctoring push senior engineers
          out of pipelines before a human ever reads their code. Hirearchy
          replaces surveillance with explicit consent and verifiable work
          artifacts.
        </p>

        <div className="ct-columns ct-columns--cards">
          <article className="ct-enter">
            <h3>Zero surveillance.</h3>
            <p>
              No webcam recording, no microphone capture, no eye or gaze
              tracking, no desktop lockdown binaries, no browser extensions, and
              no keystroke-biometric profiling.
            </p>
          </article>
          <article className="ct-enter">
            <h3>
              Explicit consent (<code>{R26_CANDIDATE_DATA_NOTICE_VERSION}</code>
              ).
            </h3>
            <p>
              Before activating a session, candidates review the exact notice
              text versioned by SHA-256 digest: only saved code, file revisions,
              task activity, and final submission are recorded for the assigned
              hiring team.
            </p>
          </article>
          <article className="ct-enter">
            <h3>Read-only receipt.</h3>
            <p>
              Candidates keep read-only access to their frozen submission
              manifest and published outcome. Internal evaluator notes and
              advisory fit reports remain strictly withheld (ADR 0009), and
              candidate feedback stays private to Hirearchy.
            </p>
          </article>
        </div>
      </section>

      <section
        className="ct-editorial ct-reveal"
        id="neutral-ai"
        data-chapter="Neutral AI"
      >
        <Kicker>Pillar 02 / ADR 0006 &amp; ADR 0008</Kicker>
        <h2 className="ct-enter" style={{ marginTop: '18px' }}>
          Neutral AI &amp; human finality.
        </h2>
        <p style={{ marginBottom: '32px' }}>
          Evidence precedes judgment. Observable tooling events, test outputs,
          advisory AI synthesis, and human decisions are kept structurally
          separate across storage and UI.
        </p>
        <ol className="ct-principles">
          {aiAndHumanFinality.map(([title, copy], index) => (
            <li className="ct-enter" key={title}>
              <span>0{index + 1}</span>
              <h3>{title}</h3>
              <p>{copy}</p>
            </li>
          ))}
        </ol>
      </section>

      <section
        className="ct-editorial ct-editorial--lilac ct-reveal"
        id="sandboxing-and-isolation"
        data-chapter="Isolation & RLS"
      >
        <Kicker>Pillar 03 &amp; 04 / Runtime &amp; Data Isolation</Kicker>
        <h2 className="ct-enter" style={{ marginTop: '18px' }}>
          Hardened sandboxing &amp; tenant isolation.
        </h2>
        <p style={{ marginBottom: '36px' }}>
          Untrusted candidate code and multi-tenant hiring records never share
          trust boundaries.
        </p>

        <div
          className="ct-columns ct-columns--cards"
          style={{ marginBottom: '48px' }}
        >
          <article className="ct-enter">
            <h3>Docker freeze finality.</h3>
            <p>
              Each restricted-executor session runs inside a hardened container
              (<code>--network none</code> by default, <code>--read-only</code>,{' '}
              <code>--cap-drop ALL</code>, <code>no-new-privileges</code>)
              backed by a dedicated <code>hirearchy-ws-*</code> volume. On
              submission, the container pauses via cgroup freeze (
              <code>docker pause</code>) while an ephemeral read-only helper
              captures diffs.
            </p>
          </article>
          <article className="ct-enter">
            <h3>PostgreSQL FORCE RLS.</h3>
            <p>
              Multi-tenant isolation is enforced inside PostgreSQL using{' '}
              <code>ENABLE</code> and <code>FORCE ROW LEVEL SECURITY</code>{' '}
              across tenant tables (migrations 0001–0023), scoping sessions,
              saved problems, credits, and hiring decisions to each
              organization.
            </p>
          </article>
          <article className="ct-enter">
            <h3>Honest staging boundary.</h3>
            <p>
              Our public interactive demo uses synthetic data and keeps live
              untrusted code execution gated off. See the full{' '}
              <Link
                className="ct-inline-link"
                href="/products/software#demo-limits"
                prefetch={false}
              >
                staging scope &amp; boundaries
              </Link>{' '}
              for what is active vs. gated in each environment.
            </p>
          </article>
        </div>

        <div className="ct-trust-spec-wrap">
          <table className="ct-trust-spec-table">
            <caption className="ct-sr-only">
              Hirearchy Software security and privacy architecture controls
            </caption>
            <thead>
              <tr>
                <th scope="col">Control surface</th>
                <th scope="col">Implemented mechanism</th>
                <th scope="col">Scope</th>
              </tr>
            </thead>
            <tbody>
              {architectureSpecs.map(([surface, mechanism, scope]) => (
                <tr key={surface}>
                  <th scope="row">
                    <span className="ct-spec-surface-badge">{surface}</span>
                  </th>
                  <td className="ct-spec-mechanism">{mechanism}</td>
                  <td>
                    <span className="ct-spec-scope-pill">{scope}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="ct-contact-cta ct-reveal" data-chapter="Next steps">
        <Kicker>Inspect the product</Kicker>
        <h2>See evidence-first review in action.</h2>
        <p style={{ maxWidth: '640px', marginBottom: '24px' }}>
          Walk through a pre-populated realistic engineering session in our
          zero-signup sandbox, or request an early-access conversation for your
          engineering team.
        </p>
        <div className="ct-contact-links">
          <Button href="/demo">Try live reviewer demo</Button>
          <Button href="/early-access">Request early access</Button>
          <Link
            className="ct-inline-link"
            href="/products/software"
            prefetch={false}
          >
            Explore Hirearchy Software <Arrow />
          </Link>
        </div>
      </section>
    </Site>
  );
}
