'use client';

import { useState } from 'react';
import {
  IconCheck,
  IconSparkles,
  IconUserCheck,
  IconUsers,
} from '@tabler/icons-react';

import {
  NEXT_STAGE_OPTIONS,
  experienceLevelLabel,
} from '../../../../src/hiring/catalogs';
import type {
  PerformanceFitReport,
  SessionHiringReviewContext,
} from '../../../../src/hiring/types';
import { hasPlanFeature } from '../../../../src/plans/entitlements';

export interface HiringDecisionPanelProps {
  readonly initialContext: SessionHiringReviewContext;
}

function readCsrfCookie(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)__Host-r23-csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function splitLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function candidateInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function HiringDecisionPanel({
  initialContext,
}: HiringDecisionPanelProps) {
  const [ctx, setCtx] = useState<SessionHiringReviewContext>(initialContext);
  const [opinionReviewerId, setOpinionReviewerId] = useState<string>(
    initialContext.teamMembers.find(
      (m) => m.principalId !== initialContext.currentPrincipalId,
    )?.principalId ??
      initialContext.teamMembers[0]?.principalId ??
      '',
  );
  const [opinionRequestNote, setOpinionRequestNote] = useState('');
  const [opinionResponses, setOpinionResponses] = useState<
    Record<string, string>
  >({});

  const [decision, setDecision] = useState<'accepted' | 'rejected'>(
    initialContext.decision?.decision ?? 'accepted',
  );
  const [strengthsText, setStrengthsText] = useState(
    initialContext.decision?.candidateStrengths.join('\n') ?? '',
  );
  const [weaknessesText, setWeaknessesText] = useState(
    initialContext.decision?.candidateWeaknesses.join('\n') ?? '',
  );
  const [feedbackNote, setFeedbackNote] = useState(
    initialContext.decision?.candidateFeedbackNote ?? '',
  );
  const [internalNotes, setInternalNotes] = useState(
    initialContext.decision?.internalNotes ?? '',
  );
  const [nextStageLabel, setNextStageLabel] = useState(
    initialContext.decision?.nextStageLabel ?? NEXT_STAGE_OPTIONS[0],
  );
  const [handoffRecipientId, setHandoffRecipientId] = useState(
    initialContext.decision?.handoffRecipientPrincipalId ??
      initialContext.teamMembers.find((m) => m.role === 'cto' || m.isOwner)
        ?.principalId ??
      initialContext.teamMembers[0]?.principalId ??
      '',
  );
  const [performanceReport, setPerformanceReport] =
    useState<PerformanceFitReport | null>(
      initialContext.decision?.performanceReport ?? null,
    );

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const reviewApiUrl = `/r23/api/organizations/${encodeURIComponent(ctx.organizationId)}/hiring/sessions/${encodeURIComponent(ctx.sessionId)}/review`;
  const orgBase = `/r23/organizations/${encodeURIComponent(ctx.organizationId)}`;
  const canGenerateFitReport = hasPlanFeature(
    ctx.plan.planTier,
    'aiPerformanceReport',
  );

  const callReviewApi = async (payload: Record<string, unknown>) => {
    const csrf = readCsrfCookie();
    const res = await fetch(reviewApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
      body: JSON.stringify({ ...payload, csrf }),
    });
    const data = (await res.json().catch(() => null)) as {
      reviewContext?: SessionHiringReviewContext;
      performanceReport?: PerformanceFitReport;
      reportError?: string;
      error?: { message?: string };
    } | null;
    if (!res.ok) {
      throw new Error(
        data?.error?.message ?? `Request failed (HTTP ${res.status})`,
      );
    }
    return data;
  };

  const handleRequestOpinion = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyAction('opinion');
    try {
      const data = await callReviewApi({
        action: 'request_second_opinion',
        reviewerPrincipalId: opinionReviewerId,
        note: opinionRequestNote,
      });
      if (data?.reviewContext) setCtx(data.reviewContext);
      setOpinionRequestNote('');
      setStatusMsg('Second opinion request sent to colleague.');
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to send request.',
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleRespondOpinion = async (opinionId: string) => {
    const note = (opinionResponses[opinionId] ?? '').trim();
    if (!note) return;
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyAction(`respond:${opinionId}`);
    try {
      const data = await callReviewApi({
        action: 'respond_second_opinion',
        opinionId,
        responseNote: note,
      });
      if (data?.reviewContext) setCtx(data.reviewContext);
      setStatusMsg('Second opinion recorded.');
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to submit response.',
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleGeneratePerformanceReport = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyAction('report');
    try {
      const data = await callReviewApi({
        action: 'generate_performance_report',
        candidateStrengths: splitLines(strengthsText),
        candidateWeaknesses: splitLines(weaknessesText),
        candidateFeedbackNote: feedbackNote,
        internalNotes,
        nextStageLabel,
      });
      if (data?.performanceReport) {
        setPerformanceReport(data.performanceReport);
        setStatusMsg(
          data.performanceReport.provider.mode === 'live_ai'
            ? 'Fit report ready for the next interviewer.'
            : 'Evidence summary ready. ' +
                (data.performanceReport.provider.fallbackReason ?? ''),
        );
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to generate fit report.',
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handlePublishDecision = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyAction('publish');
    try {
      const data = await callReviewApi({
        action: 'publish_decision',
        decision,
        candidateStrengths: splitLines(strengthsText),
        candidateWeaknesses: splitLines(weaknessesText),
        candidateFeedbackNote: feedbackNote,
        internalNotes,
        nextStageLabel,
        handoffRecipientPrincipalId: handoffRecipientId,
        performanceReport,
      });
      if (data?.reviewContext) {
        setCtx(data.reviewContext);
        if (data.reviewContext.decision?.performanceReport) {
          setPerformanceReport(data.reviewContext.decision.performanceReport);
        }
      }
      if (data?.reportError) setErrorMsg(data.reportError);
      setStatusMsg(
        decision === 'accepted'
          ? 'Acceptance published to the candidate’s account. The handoff is ready.'
          : 'Rejection decision and candidate feedback published to their Candidate Portal.',
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to publish decision.',
      );
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="hiring-page-shell" data-testid="hiring-decision-panel">
      <section className="hiring-card hiring-card-animated">
        <div className="hiring-candidate-identity">
          <span className="hiring-avatar" aria-hidden="true">
            {candidateInitials(
              ctx.candidateName || ctx.candidateEmail || 'Candidate',
            )}
          </span>
          <div>
            <div className="hiring-candidate-name">
              <span className="hiring-eyebrow">Candidate Context</span>
              {ctx.candidateCode ? (
                <span className="hiring-pill hiring-pill-plum">
                  {ctx.candidateCode}
                </span>
              ) : null}
              {ctx.decision ? (
                <span
                  className={`hiring-pill ${ctx.decision.decision === 'accepted' ? 'hiring-pill-success' : 'hiring-pill-danger'}`}
                >
                  {ctx.decision.decision === 'accepted'
                    ? `Accepted · ${ctx.decision.nextStageLabel ?? 'Handoff Ready'}`
                    : 'Rejected · Feedback Sent'}
                </span>
              ) : null}
            </div>
            <h3>
              {ctx.candidateName || ctx.candidateEmail || 'Candidate Session'}
            </h3>
            <div className="hiring-candidate-meta">
              {ctx.candidateEmail ? <span>{ctx.candidateEmail}</span> : null}
              <span>Role: {ctx.targetRole || 'Software Engineer'}</span>
              <span>Level: {experienceLevelLabel(ctx.experienceLevel)}</span>
              {ctx.skills.length > 0 ? (
                <span>Focus: {ctx.skills.join(', ')}</span>
              ) : null}
            </div>
          </div>
        </div>
      </section>

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

      <section
        className="hiring-card hiring-card-animated"
        aria-labelledby="second-opinion-heading"
      >
        <div className="hiring-candidate-name">
          <IconUsers size={18} />
          <h3 id="second-opinion-heading">
            Second Opinion (Team Collaboration)
          </h3>
        </div>
        <p className="hiring-muted-copy">
          Ask another evaluator, CTO, or engineering manager on your team to
          inspect this candidate&apos;s evidence before publishing a final
          decision.
        </p>

        <form
          onSubmit={handleRequestOpinion}
          className="hiring-page-shell hiring-mt-sm"
        >
          <div className="hiring-two-col">
            <div className="hiring-field">
              <label htmlFor="opinion-colleague">Colleague to consult</label>
              <select
                id="opinion-colleague"
                value={opinionReviewerId}
                onChange={(e) => setOpinionReviewerId(e.target.value)}
              >
                {ctx.teamMembers.map((m) => (
                  <option key={m.principalId} value={m.principalId}>
                    {m.displayName || m.email} ({m.role})
                  </option>
                ))}
              </select>
            </div>
            <div className="hiring-field">
              <label htmlFor="opinion-request-note">
                What should they inspect?
              </label>
              <input
                id="opinion-request-note"
                type="text"
                value={opinionRequestNote}
                onChange={(e) => setOpinionRequestNote(e.target.value)}
                placeholder="e.g. Check concurrency edge cases in moves.py"
              />
            </div>
          </div>
          <div>
            <button
              type="submit"
              className="hiring-btn"
              disabled={busyAction !== null || !opinionReviewerId}
            >
              <IconUserCheck size={15} />{' '}
              {busyAction === 'opinion'
                ? 'Requesting...'
                : 'Request Second Opinion'}
            </button>
          </div>
        </form>

        {ctx.secondOpinions.length > 0 ? (
          <div className="hiring-opinion-list hiring-mt-md">
            {ctx.secondOpinions.map((op) => {
              const isAssignedResponder =
                op.requestedReviewerPrincipalId === ctx.currentPrincipalId &&
                op.status === 'pending';
              return (
                <div key={op.id} className="hiring-opinion-card">
                  <div className="hiring-candidate-name">
                    <strong>
                      {op.requestedByName} → {op.requestedReviewerName}
                    </strong>
                    <span
                      className={`hiring-pill ${op.status === 'completed' ? 'hiring-pill-success' : 'hiring-pill-warning'}`}
                    >
                      {op.status}
                    </span>
                  </div>
                  {op.requestNote ? (
                    <p className="hiring-dossier-bio hiring-mt-xs">
                      Request: {op.requestNote}
                    </p>
                  ) : null}
                  {op.responseNote ? (
                    <p className="hiring-dossier-bio hiring-mt-xs">
                      <strong>Response:</strong> {op.responseNote}
                    </p>
                  ) : null}
                  {isAssignedResponder ? (
                    <div className="hiring-stack-xs hiring-mt-xs">
                      <textarea
                        rows={2}
                        aria-label="Second opinion response"
                        value={opinionResponses[op.id] ?? ''}
                        onChange={(e) =>
                          setOpinionResponses((prev) => ({
                            ...prev,
                            [op.id]: e.target.value,
                          }))
                        }
                        placeholder="Write your peer review note..."
                      />
                      <button
                        type="button"
                        className="hiring-btn hiring-btn-sm hiring-btn-primary"
                        disabled={busyAction !== null}
                        onClick={() => void handleRespondOpinion(op.id)}
                      >
                        Submit Second Opinion Response
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      {ctx.canPublishDecision ? (
        <section
          className="hiring-card hiring-card-animated"
          aria-labelledby="final-decision-heading"
        >
          <div className="hiring-candidate-name">
            <IconCheck size={18} />
            <h3 id="final-decision-heading">Decision and feedback</h3>
          </div>
          <p className="hiring-muted-copy">
            Choose the next step and add the feedback the candidate will see.
          </p>

          <form
            onSubmit={handlePublishDecision}
            className="hiring-page-shell hiring-mt-md"
          >
            <div className="hiring-builder-tabs">
              <button
                type="button"
                className={`hiring-builder-tab${decision === 'accepted' ? ' is-active' : ''}`}
                onClick={() => setDecision('accepted')}
              >
                Advance candidate
              </button>
              <button
                type="button"
                className={`hiring-builder-tab${decision === 'rejected' ? ' is-active' : ''}`}
                onClick={() => setDecision('rejected')}
              >
                Reject candidate
              </button>
            </div>

            <div className="hiring-two-col">
              <div className="hiring-field">
                <label htmlFor="decision-strengths">
                  Strengths (one per line)
                </label>
                <textarea
                  id="decision-strengths"
                  value={strengthsText}
                  onChange={(e) => setStrengthsText(e.target.value)}
                  placeholder="Clean decomposition of idempotency logic&#10;Verified edge cases methodically"
                />
              </div>

              <div className="hiring-field">
                <label htmlFor="decision-weaknesses">
                  Areas to improve (one per line)
                </label>
                <textarea
                  id="decision-weaknesses"
                  value={weaknessesText}
                  onChange={(e) => setWeaknessesText(e.target.value)}
                  placeholder="Missed negative capacity boundary check&#10;Did not run unit tests after final refactor"
                />
              </div>
            </div>

            <div className="hiring-field">
              <label htmlFor="decision-candidate-note">
                Message to candidate
              </label>
              <textarea
                id="decision-candidate-note"
                value={feedbackNote}
                onChange={(e) => setFeedbackNote(e.target.value)}
                placeholder="Summary feedback the candidate will see alongside strengths and growth areas."
              />
            </div>

            <div className="hiring-field">
              <label htmlFor="decision-internal-notes">
                Private team notes
              </label>
              <textarea
                id="decision-internal-notes"
                value={internalNotes}
                onChange={(e) => setInternalNotes(e.target.value)}
                placeholder="Internal calibration notes, salary band notes, or probes for the next interviewer."
              />
            </div>

            {decision === 'accepted' ? (
              <div className="hiring-card-subtle">
                <div className="hiring-two-col">
                  <div className="hiring-field">
                    <label htmlFor="decision-next-stage">
                      Next hiring stage
                    </label>
                    <select
                      id="decision-next-stage"
                      value={nextStageLabel}
                      onChange={(e) => setNextStageLabel(e.target.value)}
                    >
                      {NEXT_STAGE_OPTIONS.map((stage) => (
                        <option key={stage} value={stage}>
                          {stage}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="hiring-field">
                    <label htmlFor="decision-handoff-recipient">
                      Assign next-stage manager / interviewer
                    </label>
                    <select
                      id="decision-handoff-recipient"
                      value={handoffRecipientId}
                      onChange={(e) => setHandoffRecipientId(e.target.value)}
                    >
                      {ctx.teamMembers.map((m) => (
                        <option key={m.principalId} value={m.principalId}>
                          {m.displayName || m.email} ({m.role})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="hiring-stack-sm hiring-mt-sm">
                  {canGenerateFitReport ? (
                    <div className="hiring-header-actions">
                      <button
                        type="button"
                        className="hiring-btn"
                        disabled={busyAction !== null}
                        onClick={() => void handleGeneratePerformanceReport()}
                      >
                        <IconSparkles size={15} />{' '}
                        {busyAction === 'report'
                          ? 'Generating Kimi K3.1 Pro Fit Report...'
                          : performanceReport
                            ? 'Regenerate Kimi K3.1 Pro Managerial Fit Report'
                            : 'Generate Kimi K3.1 Pro Managerial Fit Report'}
                      </button>
                    </div>
                  ) : (
                    <div className="hiring-banner hiring-banner-warning">
                      <span>
                        Automated Kimi K3.1 Pro Managerial Fit Reports require
                        the <strong>Ultra</strong> plan. You can still publish
                        the acceptance and handoff with your own notes.
                      </span>
                      <a
                        className="hiring-btn hiring-btn-sm"
                        href={`${orgBase}/settings`}
                      >
                        Upgrade to Ultra
                      </a>
                    </div>
                  )}

                  {performanceReport ? (
                    <div className="hiring-card hiring-card-compact">
                      <span className="hiring-eyebrow">
                        {performanceReport.provider.mode === 'live_ai'
                          ? 'AI advisory · Kimi K3.1 Pro'
                          : 'Evidence summary'}
                      </span>
                      <h4>{performanceReport.fitHeadline}</h4>
                      <p className="hiring-dossier-bio">
                        {performanceReport.whyGoodOrBadFit}
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="hiring-header-actions">
              <button
                type="submit"
                className={`hiring-btn ${decision === 'accepted' ? 'hiring-btn-mint' : 'hiring-btn-danger'}`}
                disabled={busyAction !== null}
              >
                {busyAction === 'publish'
                  ? 'Publishing decision...'
                  : decision === 'accepted'
                    ? 'Publish acceptance'
                    : 'Publish rejection'}
              </button>
              {ctx.decision?.decision === 'accepted' ? (
                <a
                  className="hiring-btn hiring-btn-primary"
                  href={`${orgBase}/handoffs/${encodeURIComponent(ctx.sessionId)}`}
                >
                  Open handoff →
                </a>
              ) : null}
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
}
