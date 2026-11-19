'use client';

import { useState } from 'react';
import { IconSparkles } from '@tabler/icons-react';

import { experienceLevelLabel } from '../../../../../../src/hiring/catalogs';
import type { HandoffDossierItem } from '../../../../../../src/hiring/types';
import {
  hasPlanFeature,
  type OrganizationPlanSummary,
} from '../../../../../../src/plans/entitlements';

export interface HandoffDossierClientProps {
  readonly organizationId: string;
  readonly initialDossier: HandoffDossierItem;
  readonly plan: OrganizationPlanSummary;
}

function readCsrfCookie(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)__Host-r23-csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function splitInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function HandoffDossierClient({
  organizationId,
  initialDossier,
  plan,
}: HandoffDossierClientProps) {
  const [dossier, setDossier] = useState<HandoffDossierItem>(initialDossier);
  const [busy, setBusy] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const canGenerateFitReport = hasPlanFeature(
    plan.planTier,
    'aiPerformanceReport',
  );
  const apiUrl = `/r23/api/organizations/${encodeURIComponent(organizationId)}/hiring/handoffs`;
  const orgBase = `/r23/organizations/${encodeURIComponent(organizationId)}`;

  const updateStatus = async (
    nextStatus: 'pending' | 'reviewed' | 'completed',
  ) => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusy(nextStatus);
    try {
      const csrf = readCsrfCookie();
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({
          csrf,
          sessionId: dossier.sessionId,
          handoffStatus: nextStatus,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        handoffs?: HandoffDossierItem[];
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        throw new Error(
          data?.error?.message ?? `Unable to update handoff (${res.status})`,
        );
      }
      const updated = data?.handoffs?.find(
        (h) => h.sessionId === dossier.sessionId,
      );
      if (updated) setDossier(updated);
      setStatusMsg(`Handoff marked as "${nextStatus}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Update failed.');
    } finally {
      setBusy(null);
    }
  };

  const regenerateFitReport = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusy('regen');
    try {
      const csrf = readCsrfCookie();
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        body: JSON.stringify({
          csrf,
          sessionId: dossier.sessionId,
          regeneratePerformanceReport: true,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        handoffs?: HandoffDossierItem[];
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        throw new Error(
          data?.error?.message ??
            `Unable to regenerate fit report (${res.status})`,
        );
      }
      const updated = data?.handoffs?.find(
        (h) => h.sessionId === dossier.sessionId,
      );
      if (updated) setDossier(updated);
      setStatusMsg(
        'Updated Managerial Performance & Fit Report using Kimi K3.1 Pro.',
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Generation failed.');
    } finally {
      setBusy(null);
    }
  };

  const report = dossier.decision.performanceReport;

  return (
    <div className="hiring-handoff-dossier">
      {errorMsg ? (
        <div className="hiring-banner hiring-banner-danger" role="alert">
          {errorMsg}
        </div>
      ) : null}
      {statusMsg ? (
        <div className="hiring-banner hiring-banner-success" role="status">
          {statusMsg}
        </div>
      ) : null}

      <section className="hiring-card hiring-card-animated">
        <div className="hiring-candidate-name">
          <span className="hiring-eyebrow">Handoff Status &amp; Controls</span>
          <span className="hiring-pill hiring-pill-plum">
            {dossier.decision.handoffStatus}
          </span>
        </div>
        <div className="hiring-candidate-meta hiring-mt-sm">
          <span>Decided by: {dossier.decision.decidedByName}</span>
          <span>
            Assigned interviewer:{' '}
            {dossier.decision.handoffRecipientName ?? 'Team manager'}
          </span>
          <span>
            Next stage:{' '}
            {dossier.decision.nextStageLabel ?? 'Managerial Interview'}
          </span>
        </div>
        <div className="hiring-header-actions hiring-mt-md">
          {(['pending', 'reviewed', 'completed'] as const).map((statusOpt) => (
            <button
              key={statusOpt}
              type="button"
              className={`hiring-btn hiring-btn-sm${dossier.decision.handoffStatus === statusOpt ? ' hiring-btn-primary' : ''}`}
              disabled={busy !== null}
              onClick={() => void updateStatus(statusOpt)}
            >
              Mark {statusOpt}
            </button>
          ))}
        </div>
      </section>

      <section className="hiring-card hiring-card-animated">
        <span className="hiring-eyebrow">Candidate Dossier</span>
        <div className="hiring-candidate-identity hiring-mt-xs">
          <span className="hiring-avatar" aria-hidden="true">
            {splitInitials(dossier.candidateName)}
          </span>
          <div>
            <div className="hiring-candidate-name">
              <h2>{dossier.candidateName}</h2>
              {dossier.candidateCode ? (
                <span className="hiring-pill hiring-pill-plum">
                  {dossier.candidateCode}
                </span>
              ) : null}
            </div>
            <div className="hiring-candidate-meta">
              <span>{dossier.candidateEmail}</span>
              <span>
                {dossier.candidateProfile.headlineRole || dossier.targetRole} ·{' '}
                {experienceLevelLabel(dossier.experienceLevel)}
                {dossier.candidateProfile.yearsExperience !== null
                  ? ` (${dossier.candidateProfile.yearsExperience} yrs)`
                  : ''}
              </span>
              {dossier.candidateProfile.locationCountry ? (
                <span>
                  {[
                    dossier.candidateProfile.locationCity,
                    dossier.candidateProfile.locationCountry,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        {dossier.candidateProfile.bio ? (
          <p className="hiring-dossier-bio hiring-mt-sm">
            {dossier.candidateProfile.bio}
          </p>
        ) : null}
        <div className="hiring-chip-group hiring-mt-sm">
          {dossier.skills.map((s) => (
            <span key={s} className="hiring-pill">
              {s}
            </span>
          ))}
        </div>
      </section>

      <section className="hiring-card hiring-card-animated">
        <span className="hiring-eyebrow">Evaluator Decision &amp; Notes</span>
        <div className="hiring-two-col hiring-mt-sm">
          <div className="hiring-card-subtle">
            <strong>Strengths (Shared with candidate)</strong>
            <ul className="hiring-bullet-list">
              {dossier.decision.candidateStrengths.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
            <strong className="hiring-sublabel">
              Weaknesses / Probes (Shared with candidate)
            </strong>
            <ul className="hiring-bullet-list">
              {dossier.decision.candidateWeaknesses.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
          <div className="hiring-card-subtle">
            <strong>Internal Interview Notes (Hiring Team Only)</strong>
            <p className="hiring-prewrap hiring-mt-xs">
              {dossier.decision.internalNotes || 'No internal notes recorded.'}
            </p>
            <strong className="hiring-sublabel">
              Published Candidate Note
            </strong>
            <p className="hiring-prewrap hiring-mt-xs">
              {dossier.decision.candidateFeedbackNote || '—'}
            </p>
          </div>
        </div>
      </section>

      {dossier.secondOpinions.length > 0 ? (
        <section className="hiring-card hiring-card-animated">
          <span className="hiring-eyebrow">Peer Second Opinions</span>
          <div className="hiring-opinion-list hiring-mt-sm">
            {dossier.secondOpinions.map((op) => (
              <div key={op.id} className="hiring-opinion-card">
                <strong>
                  {op.requestedByName} → {op.requestedReviewerName} ({op.status}
                  )
                </strong>
                {op.requestNote ? <p>Ask: {op.requestNote}</p> : null}
                {op.responseNote ? <p>Response: {op.responseNote}</p> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="hiring-card hiring-card-animated">
        <div className="hiring-preview-header">
          <div>
            <span className="hiring-eyebrow">
              Kimi K3.1 Pro Intelligence · Ultra Feature
            </span>
            <h2>Managerial Performance &amp; Role Fit Report</h2>
          </div>
          {canGenerateFitReport ? (
            <button
              type="button"
              className="hiring-btn"
              disabled={busy !== null}
              onClick={() => void regenerateFitReport()}
            >
              <IconSparkles size={15} />{' '}
              {busy === 'regen'
                ? 'Analyzing with Kimi K3.1 Pro...'
                : report
                  ? 'Refresh Fit Report'
                  : 'Generate Fit Report'}
            </button>
          ) : (
            <a
              className="hiring-btn hiring-btn-sm"
              href={`${orgBase}/settings`}
            >
              Upgrade to Ultra
            </a>
          )}
        </div>

        {!report ? (
          <p className="hiring-muted-copy hiring-mt-sm">
            No automated Performance &amp; Fit Report has been generated for
            this handoff yet.
          </p>
        ) : (
          <div className="hiring-page-shell hiring-mt-md">
            <div className="hiring-card-subtle">
              <span className="hiring-pill hiring-pill-plum">
                {report.overallFitVerdict}
              </span>
              <h3 className="hiring-mt-sm">{report.fitHeadline}</h3>
              <p className="hiring-dossier-bio hiring-mt-xs">
                {report.whyGoodOrBadFit}
              </p>
            </div>

            <div className="hiring-two-col">
              <div className="hiring-card-subtle">
                <strong>Clearly Demonstrated in Evidence</strong>
                <ul className="hiring-bullet-list">
                  {report.clearlyDemonstrated.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
              <div className="hiring-card-subtle">
                <strong>Unclear / Not Yet Assessed (Probe Next Round)</strong>
                <ul className="hiring-bullet-list">
                  {report.unclearOrNotAssessed.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>

            {report.requirementAssessment.length > 0 ? (
              <div>
                <strong>Requirement &amp; Skill Coverage</strong>
                <ul className="hiring-timing-list hiring-mt-xs">
                  {report.requirementAssessment.map((req, i) => (
                    <li key={i} className="hiring-timing-item">
                      <strong>{req.requirement}</strong> ·{' '}
                      <span className="hiring-pill">{req.status}</span> —{' '}
                      {req.evidence}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {report.suggestedNextInterviewQuestions.length > 0 ? (
              <div className="hiring-card-subtle">
                <strong>Recommended Follow-Up Interview Questions</strong>
                <ol className="hiring-ol-list">
                  {report.suggestedNextInterviewQuestions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
