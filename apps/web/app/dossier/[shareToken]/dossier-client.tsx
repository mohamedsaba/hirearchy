'use client';

import Link from 'next/link';
import {
  IconAlertCircle,
  IconArrowRight,
  IconCheck,
  IconCircleCheck,
  IconClock,
  IconCompass,
  IconFileDiff,
  IconMessages,
  IconPrinter,
  IconShieldCheck,
} from '@tabler/icons-react';

import type { PublicDossierView } from '../../../src/demo/sample-session';
import { experienceLevelLabel } from '../../../src/hiring/catalogs';
import { ThemeToggle } from '../../_components/theme-toggle';
import '../dossier.css';

export interface DossierClientProps {
  readonly dossier: PublicDossierView;
  readonly demoCtaHref: string;
}

function formatDisplayDate(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fitStatusLabel(
  status: 'demonstrated' | 'partial' | 'gap' | 'not_assessed',
): string {
  switch (status) {
    case 'demonstrated':
      return 'Demonstrated';
    case 'partial':
      return 'Partial';
    case 'gap':
      return 'Gap';
    case 'not_assessed':
    default:
      return 'Not assessed';
  }
}

export function DossierClient({ dossier, demoCtaHref }: DossierClientProps) {
  const accepted = dossier.decision === 'accepted';
  const report = dossier.includeAiAdvisory ? dossier.performanceReport : null;

  return (
    <div className="software-product dossier-page">
      <header className="dossier-topbar dossier-no-print">
        <div className="dossier-topbar-brand">
          <span className="software-document-wordmark">
            <span>Hirearchy</span>
            <span className="software-document-product">Software</span>
          </span>
          <span className="dossier-org-context">
            · {dossier.organizationName} Dossier
            {dossier.isDemo ? ' · Sample' : ''}
          </span>
          <span
            className={`hiring-pill ${dossier.visibilityMode === 'redacted' ? 'hiring-pill-success' : 'hiring-pill-warning'}`}
            style={{ marginBlockStart: 0 }}
          >
            <IconShieldCheck size={14} aria-hidden="true" />
            {dossier.visibilityMode === 'redacted'
              ? 'Redacted Identity · Zero PII'
              : 'Named Candidate Brief'}
          </span>
        </div>

        <div className="hiring-header-actions dossier-topbar-actions">
          {dossier.expiresAt ? (
            <span className="hiring-muted-copy">
              Expires {formatDisplayDate(dossier.expiresAt)}
            </span>
          ) : null}
          <ThemeToggle variant="header" />
          <button
            type="button"
            className="hiring-btn hiring-btn-primary hiring-btn-sm"
            onClick={() => window.print()}
          >
            <IconPrinter size={15} aria-hidden="true" /> Print / Save PDF
          </button>
        </div>
      </header>

      <main className="dossier-container" id="dossier-main">
        <section className="dossier-card dossier-header-card">
          <div className="dossier-header-top">
            <div>
              <span className="hiring-eyebrow">
                {dossier.organizationName} · Engineering Hiring Verdict
              </span>
              <h1 className="dossier-candidate-title">
                {dossier.candidateDisplay}
              </h1>
              <div className="hiring-candidate-meta hiring-mt-xs">
                {dossier.candidateCode ? (
                  <span
                    className="hiring-pill hiring-pill-plum"
                    style={{ marginBlockStart: 0 }}
                  >
                    {dossier.candidateCode}
                  </span>
                ) : null}
                <span>
                  {dossier.headlineRole || dossier.targetRole} ·{' '}
                  {experienceLevelLabel(dossier.experienceLevel)}
                </span>
                {dossier.locationLabel ? (
                  <span>{dossier.locationLabel}</span>
                ) : null}
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                justifyItems: 'end',
                gap: '0.35rem',
              }}
            >
              <span
                className={`hiring-pill ${accepted ? 'hiring-pill-success' : 'hiring-pill-danger'}`}
                style={{
                  marginBlockStart: 0,
                  fontSize: '0.85rem',
                  padding: '0.3rem 0.75rem',
                }}
              >
                <IconCheck size={15} aria-hidden="true" />
                {accepted
                  ? `Advance · ${dossier.nextStageLabel ?? 'Next Stage'}`
                  : 'Hold / Do Not Advance'}
              </span>
              <span className="hiring-muted-copy">
                Published {formatDisplayDate(dossier.publishedAt)} by{' '}
                <strong>{dossier.decidedByName}</strong>
              </span>
            </div>
          </div>

          <div>
            <span className="hiring-muted-copy">
              Assessed on <strong>{dossier.scenarioTitle}</strong>
            </span>
          </div>

          {dossier.skills.length > 0 ? (
            <div className="hiring-chip-group">
              {dossier.skills.map((skill) => (
                <span
                  key={skill}
                  className="hiring-pill"
                  style={{ marginBlockStart: 0 }}
                >
                  {skill}
                </span>
              ))}
            </div>
          ) : null}
        </section>

        <section
          className="dossier-card"
          aria-labelledby="dossier-evidence-heading"
        >
          <span className="hiring-eyebrow">Observable Session Evidence</span>
          <h2 id="dossier-evidence-heading" className="hiring-mt-xs">
            Captured Work Summary
          </h2>
          <div className="dossier-stats-grid hiring-mt-sm">
            <div className="dossier-stat-card">
              <span className="dossier-stat-head">
                <IconClock size={14} aria-hidden="true" />
                <span className="dossier-stat-label">Active Duration</span>
              </span>
              <strong className="dossier-stat-value">
                {dossier.evidenceSummary.durationMinutes !== null
                  ? `${dossier.evidenceSummary.durationMinutes} min`
                  : 'Recorded'}
              </strong>
            </div>
            <div className="dossier-stat-card">
              <span className="dossier-stat-head">
                <IconFileDiff size={14} aria-hidden="true" />
                <span className="dossier-stat-label">Files Modified</span>
              </span>
              <strong className="dossier-stat-value">
                {dossier.evidenceSummary.filesModified}
                {dossier.evidenceSummary.totalFiles > 0
                  ? ` / ${dossier.evidenceSummary.totalFiles}`
                  : ''}
              </strong>
            </div>
            <div
              className="dossier-stat-card"
              data-passed={
                dossier.evidenceSummary.executionRunsPassed > 0
                  ? 'true'
                  : 'false'
              }
            >
              <span className="dossier-stat-head">
                {dossier.evidenceSummary.executionRunsPassed > 0 ? (
                  <IconCircleCheck
                    size={15}
                    className="dossier-stat-icon--success"
                    aria-hidden="true"
                  />
                ) : (
                  <IconAlertCircle
                    size={15}
                    className="dossier-stat-icon--warning"
                    aria-hidden="true"
                  />
                )}
                <span className="dossier-stat-label">Verification Runs</span>
              </span>
              <strong className="dossier-stat-value">
                {dossier.evidenceSummary.executionRunsPassed} /{' '}
                {dossier.evidenceSummary.executionRunsTotal} passed
              </strong>
            </div>
            <div className="dossier-stat-card">
              <span className="dossier-stat-head">
                <IconMessages size={14} aria-hidden="true" />
                <span className="dossier-stat-label">Workspace AI Log</span>
              </span>
              <strong className="dossier-stat-value">
                {dossier.evidenceSummary.aiInteractionsCount}{' '}
                {dossier.evidenceSummary.aiInteractionsCount === 1
                  ? 'exchange'
                  : 'exchanges'}
              </strong>
            </div>
          </div>
          <p className="hiring-muted-copy hiring-mt-sm">
            Workspace AI interactions are recorded neutrally as observable
            tooling context—never auto-penalized. Human evaluators own all
            verdicts.
          </p>
        </section>

        <section
          className="dossier-card"
          aria-labelledby="dossier-verdict-notes-heading"
        >
          <span className="hiring-eyebrow">Human Evaluator Synthesis</span>
          <h2 id="dossier-verdict-notes-heading" className="hiring-mt-xs">
            Strengths &amp; Follow-up Areas
          </h2>
          <div className="dossier-two-col hiring-mt-sm">
            <div className="hiring-card-subtle dossier-synthesis-card dossier-synthesis-card--strengths">
              <strong className="dossier-synthesis-heading">
                <IconCircleCheck
                  size={16}
                  className="dossier-synthesis-icon"
                  aria-hidden="true"
                />
                Demonstrated Strengths
              </strong>
              {dossier.candidateStrengths.length > 0 ? (
                <ul className="hiring-bullet-list">
                  {dossier.candidateStrengths.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              ) : (
                <p className="hiring-muted-copy hiring-mt-xs">
                  None listed in published summary.
                </p>
              )}
            </div>

            <div className="hiring-card-subtle dossier-synthesis-card dossier-synthesis-card--explore">
              <strong className="dossier-synthesis-heading">
                <IconCompass
                  size={16}
                  className="dossier-synthesis-icon"
                  aria-hidden="true"
                />
                Areas to Explore in Next Interview
              </strong>
              {dossier.candidateWeaknesses.length > 0 ? (
                <ul className="hiring-bullet-list">
                  {dossier.candidateWeaknesses.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              ) : (
                <p className="hiring-muted-copy hiring-mt-xs">
                  No open risk flags listed.
                </p>
              )}
            </div>
          </div>

          {dossier.candidateFeedbackNote ? (
            <div className="hiring-card-subtle hiring-mt-sm">
              <strong>Evaluator Summary Note</strong>
              <p className="hiring-prewrap hiring-mt-xs">
                {dossier.candidateFeedbackNote}
              </p>
            </div>
          ) : null}
        </section>

        {dossier.peerVerdictsSummary.length > 0 ? (
          <section
            className="dossier-card"
            aria-labelledby="dossier-peer-heading"
          >
            <span className="hiring-eyebrow">Team Calibration</span>
            <h2 id="dossier-peer-heading" className="hiring-mt-xs">
              Peer Review Verdicts
            </h2>
            <div className="hiring-opinion-list hiring-mt-sm">
              {dossier.peerVerdictsSummary.map((peer, idx) => (
                <div key={idx} className="hiring-opinion-card">
                  <div className="hiring-candidate-name">
                    <strong>{peer.reviewerName}</strong>
                    <span
                      className={`hiring-pill ${peer.verdict === 'approve' ? 'hiring-pill-success' : peer.verdict === 'request_changes' ? 'hiring-pill-danger' : 'hiring-pill-plum'}`}
                      style={{ marginBlockStart: 0 }}
                    >
                      {peer.verdict === 'approve'
                        ? 'Approved'
                        : peer.verdict === 'request_changes'
                          ? 'Concerns flagged'
                          : 'Commented'}
                    </span>
                  </div>
                  {peer.responseNote ? (
                    <p className="hiring-dossier-bio hiring-mt-xs">
                      {peer.responseNote}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {report ? (
          <section
            className="dossier-card"
            aria-labelledby="dossier-fit-heading"
          >
            <span className="hiring-eyebrow">
              Advisory Managerial Synthesis (Non-Binding)
            </span>
            <h2 id="dossier-fit-heading" className="hiring-mt-xs">
              {report.fitHeadline}
            </h2>
            <p className="hiring-dossier-bio hiring-mt-xs">
              {report.whyGoodOrBadFit}
            </p>

            {report.requirementAssessment.length > 0 ? (
              <div className="hiring-stack-xs hiring-mt-md">
                <strong>Requirement &amp; Skill Coverage</strong>
                <div className="hiring-stack-xs">
                  {report.requirementAssessment.map((req, idx) => (
                    <div key={idx} className="dossier-fit-req">
                      <div className="hiring-preview-header">
                        <strong>{req.requirement}</strong>
                        <span
                          className={`hiring-pill ${req.status === 'demonstrated' ? 'hiring-pill-success' : req.status === 'gap' ? 'hiring-pill-danger' : 'hiring-pill-warning'}`}
                          style={{ marginBlockStart: 0 }}
                        >
                          {fitStatusLabel(req.status)}
                        </span>
                      </div>
                      <p className="hiring-muted-copy hiring-mt-xs">
                        {req.evidence}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {dossier.includeVerificationQuestions &&
            report.suggestedNextInterviewQuestions.length > 0 ? (
              <div className="hiring-card-subtle hiring-mt-md">
                <strong>Recommended Live Verification Questions</strong>
                <ol className="hiring-ol-list hiring-mt-xs">
                  {report.suggestedNextInterviewQuestions.map((q, idx) => (
                    <li key={idx}>{q}</li>
                  ))}
                </ol>
              </div>
            ) : null}
          </section>
        ) : null}

        <footer className="dossier-footer">
          <span>
            Evidence-first engineering evaluation by{' '}
            <strong>Hirearchy Software</strong> — no automated scores, no webcam
            proctoring.
          </span>
          <div className="hiring-header-actions dossier-no-print">
            <Link href="/demo" className="hiring-btn hiring-btn-sm">
              Inspect how evidence is captured{' '}
              <IconArrowRight size={14} aria-hidden="true" />
            </Link>
            <Link
              href={demoCtaHref}
              className="hiring-btn hiring-btn-sm hiring-btn-mint"
            >
              Try Hirearchy for your team
            </Link>
          </div>
        </footer>
      </main>
    </div>
  );
}
