'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  IconAlertTriangle,
  IconCheck,
  IconCircleCheck,
  IconCode,
  IconCopy,
  IconListDetails,
  IconMail,
  IconMessageCircle,
  IconSend,
  IconSparkles,
  IconTerminal2,
  IconUsers,
} from '@tabler/icons-react';

import {
  NEXT_STAGE_OPTIONS,
  experienceLevelLabel,
} from '../../../../src/hiring/catalogs';
import type {
  PeerReviewEmailDelivery,
  PeerReviewRequestContext,
  PeerReviewVerdict,
  PerformanceFitReport,
  SecondOpinionRecord,
  SessionHiringReviewContext,
} from '../../../../src/hiring/types';
import { hasPlanFeature } from '../../../../src/plans/entitlements';
import type { R27AiReviewReport } from '../../../../src/r27-evidence/ai-review-contract';
import { playHirearchySound } from '../../../../src/ui/sound';
import type { EvidenceFilter } from './evidence-workbench';

export interface HiringDecisionPanelProps {
  readonly initialContext: SessionHiringReviewContext;
  readonly aiReviewReport?: R27AiReviewReport | null;
  readonly initialPeerReviewId?: string | null;
  readonly onOpenEvidence?: (filter: EvidenceFilter) => void;
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

function formatRoleLabel(role: string): string {
  switch (role) {
    case 'cto':
      return 'CTO / Owner';
    case 'reviewer':
      return 'Evaluator';
    case 'recruiter':
      return 'Recruiter';
    default:
      return role;
  }
}

function formatTimestampShort(iso: string | null): string {
  if (!iso) return '';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function verdictPillMeta(opinion: SecondOpinionRecord): {
  label: string;
  className: string;
} {
  if (opinion.status !== 'completed') {
    return { label: 'Awaiting review', className: 'hiring-pill-warning' };
  }
  switch (opinion.verdict) {
    case 'approve':
      return { label: 'Approved', className: 'hiring-pill-success' };
    case 'request_changes':
      return { label: 'Concerns flagged', className: 'hiring-pill-danger' };
    case 'comment':
    default:
      return { label: 'Commented', className: 'hiring-pill-plum' };
  }
}

const VERDICT_OPTIONS: ReadonlyArray<{
  readonly id: PeerReviewVerdict;
  readonly label: string;
  readonly description: string;
}> = [
  {
    id: 'approve',
    label: 'Approve',
    description: 'Recommend advancing',
  },
  {
    id: 'comment',
    label: 'Comment',
    description: 'Share perspective',
  },
  {
    id: 'request_changes',
    label: 'Flag concerns',
    description: 'Hold or do not advance',
  },
];

function hasSharedContext(
  context: PeerReviewRequestContext | null | undefined,
): boolean {
  if (!context) return false;
  return Boolean(
    (context.evaluatorStrengths && context.evaluatorStrengths.length > 0) ||
    (context.evaluatorWeaknesses && context.evaluatorWeaknesses.length > 0) ||
    context.internalNotesExcerpt?.trim() ||
    context.aiAdvisory?.headline?.trim() ||
    context.aiAdvisory?.rationale?.trim(),
  );
}

function PeerReviewSharedContextBlock({
  context,
}: Readonly<{ context: PeerReviewRequestContext }>) {
  const strengths = context.evaluatorStrengths ?? [];
  const weaknesses = context.evaluatorWeaknesses ?? [];
  const notes = context.internalNotesExcerpt?.trim() ?? '';
  const ai = context.aiAdvisory ?? null;

  return (
    <div className="hiring-peer-context-box">
      {strengths.length > 0 || weaknesses.length > 0 ? (
        <div className="hiring-two-col">
          {strengths.length > 0 ? (
            <div>
              <strong className="hiring-peer-context-label">
                Requester strengths noted
              </strong>
              <ul className="hiring-bullet-list">
                {strengths.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {weaknesses.length > 0 ? (
            <div>
              <strong className="hiring-peer-context-label">
                Requester concerns / probes
              </strong>
              <ul className="hiring-bullet-list">
                {weaknesses.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {notes ? (
        <div>
          <strong className="hiring-peer-context-label">Requester notes</strong>
          <p className="hiring-prewrap hiring-peer-context-note">{notes}</p>
        </div>
      ) : null}

      {ai && (ai.headline || ai.rationale) ? (
        <div className="hiring-peer-ai-box">
          <div className="hiring-candidate-name">
            <span className="hiring-pill hiring-pill-plum">
              Advisory AI · {ai.verdictLabel} ({ai.score}/100)
            </span>
            {ai.providerLabel ? (
              <span className="hiring-muted-copy">{ai.providerLabel}</span>
            ) : null}
          </div>
          {ai.headline ? (
            <strong className="hiring-peer-context-label">{ai.headline}</strong>
          ) : null}
          {ai.rationale ? (
            <p className="hiring-peer-context-note">{ai.rationale}</p>
          ) : null}
          <p className="hiring-peer-ai-disclaimer">
            Advisory only — inspect the submitted code changes and chronology
            before submitting your review.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function HiringDecisionPanel({
  initialContext,
  aiReviewReport = null,
  initialPeerReviewId = null,
  onOpenEvidence,
}: HiringDecisionPanelProps) {
  const [ctx, setCtx] = useState<SessionHiringReviewContext>(initialContext);
  const otherTeammates = useMemo(
    () =>
      ctx.teamMembers.filter(
        (member) => member.principalId !== ctx.currentPrincipalId,
      ),
    [ctx.teamMembers, ctx.currentPrincipalId],
  );
  const selectableTeammates =
    otherTeammates.length > 0 ? otherTeammates : ctx.teamMembers;

  const [opinionReviewerId, setOpinionReviewerId] = useState<string>(
    selectableTeammates[0]?.principalId ?? '',
  );
  const [opinionRequestNote, setOpinionRequestNote] = useState('');
  const [attachContext, setAttachContext] = useState(true);
  const [opinionResponses, setOpinionResponses] = useState<
    Record<string, string>
  >({});
  const [opinionVerdicts, setOpinionVerdicts] = useState<
    Record<string, PeerReviewVerdict>
  >({});
  const [lastEmailDelivery, setLastEmailDelivery] =
    useState<PeerReviewEmailDelivery | null>(null);
  const [copiedReviewLink, setCopiedReviewLink] = useState(false);

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

  const peerReviewRefs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    if (!initialPeerReviewId) return;
    const target = peerReviewRefs.current.get(initialPeerReviewId);
    if (!target) return;
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({
      behavior: reduced ? 'auto' : 'smooth',
      block: 'nearest',
    });
  }, [initialPeerReviewId]);

  const reviewApiUrl = `/r23/api/organizations/${encodeURIComponent(ctx.organizationId)}/hiring/sessions/${encodeURIComponent(ctx.sessionId)}/review`;
  const orgBase = `/r23/organizations/${encodeURIComponent(ctx.organizationId)}`;
  const canGenerateFitReport = hasPlanFeature(
    ctx.plan.planTier,
    'aiPerformanceReport',
  );

  const pendingForMe = useMemo(
    () =>
      ctx.secondOpinions.filter(
        (op) =>
          op.status === 'pending' &&
          op.requestedReviewerPrincipalId === ctx.currentPrincipalId,
      ),
    [ctx.secondOpinions, ctx.currentPrincipalId],
  );

  const draftStrengths = useMemo(
    () => splitLines(strengthsText),
    [strengthsText],
  );
  const draftWeaknesses = useMemo(
    () => splitLines(weaknessesText),
    [weaknessesText],
  );
  const hasAttachableContext = Boolean(
    draftStrengths.length > 0 ||
    draftWeaknesses.length > 0 ||
    internalNotes.trim().length > 0 ||
    aiReviewReport !== null,
  );
  const attachmentPreviewParts = useMemo(() => {
    const parts: string[] = [];
    if (draftStrengths.length > 0) {
      parts.push(
        `${draftStrengths.length} strength${draftStrengths.length === 1 ? '' : 's'}`,
      );
    }
    if (draftWeaknesses.length > 0) {
      parts.push(
        `${draftWeaknesses.length} concern${draftWeaknesses.length === 1 ? '' : 's'}`,
      );
    }
    if (internalNotes.trim()) parts.push('private notes');
    if (aiReviewReport) parts.push('advisory AI summary');
    return parts;
  }, [
    draftStrengths.length,
    draftWeaknesses.length,
    internalNotes,
    aiReviewReport,
  ]);

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
      emailDelivery?: PeerReviewEmailDelivery;
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

  const buildRequestContextPayload = ():
    PeerReviewRequestContext | undefined => {
    if (!attachContext || !hasAttachableContext) return undefined;
    return {
      ...(draftStrengths.length > 0
        ? { evaluatorStrengths: draftStrengths.slice(0, 8) }
        : {}),
      ...(draftWeaknesses.length > 0
        ? { evaluatorWeaknesses: draftWeaknesses.slice(0, 8) }
        : {}),
      ...(internalNotes.trim()
        ? { internalNotesExcerpt: internalNotes.trim().slice(0, 1500) }
        : {}),
      ...(aiReviewReport
        ? {
            aiAdvisory: {
              headline: aiReviewReport.headline.slice(0, 240),
              score: aiReviewReport.score,
              verdictLabel: aiReviewReport.verdictLabel,
              rationale: aiReviewReport.rationale.slice(0, 1200),
              providerLabel: aiReviewReport.provider.label,
            },
          }
        : {}),
    };
  };

  const handleRequestOpinion = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);
    setLastEmailDelivery(null);
    setBusyAction('opinion');
    try {
      const requestContext = buildRequestContextPayload();
      const data = await callReviewApi({
        action: 'request_second_opinion',
        reviewerPrincipalId: opinionReviewerId,
        note: opinionRequestNote,
        ...(requestContext ? { requestContext } : {}),
      });
      if (data?.reviewContext) setCtx(data.reviewContext);
      if (data?.emailDelivery) setLastEmailDelivery(data.emailDelivery);
      setOpinionRequestNote('');
      playHirearchySound('dispatch');
      setStatusMsg(
        data?.emailDelivery?.status === 'sent'
          ? `Peer review requested and emailed to ${data.emailDelivery.recipientEmail}.`
          : 'Peer review request saved in the workspace.',
      );
    } catch (err) {
      playHirearchySound('error');
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Unable to send peer review request.',
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleRespondOpinion = async (opinionId: string) => {
    const note = (opinionResponses[opinionId] ?? '').trim();
    if (!note) return;
    const verdict: PeerReviewVerdict = opinionVerdicts[opinionId] ?? 'comment';
    setErrorMsg(null);
    setStatusMsg(null);
    setLastEmailDelivery(null);
    setBusyAction(`respond:${opinionId}`);
    try {
      const data = await callReviewApi({
        action: 'respond_second_opinion',
        opinionId,
        responseNote: note,
        verdict,
      });
      if (data?.reviewContext) setCtx(data.reviewContext);
      if (data?.emailDelivery) setLastEmailDelivery(data.emailDelivery);
      setOpinionResponses((prev) => {
        const next = { ...prev };
        delete next[opinionId];
        return next;
      });
      playHirearchySound('confirm');
      setStatusMsg(
        data?.emailDelivery?.status === 'sent'
          ? `Peer review submitted and emailed back to ${data.emailDelivery.recipientEmail}.`
          : 'Peer review submitted.',
      );
    } catch (err) {
      playHirearchySound('error');
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to submit peer review.',
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleCopyReviewLink = async () => {
    if (typeof window === 'undefined' || !navigator.clipboard) return;
    const url = `${window.location.origin}/r27/organizations/${encodeURIComponent(ctx.organizationId)}/sessions/${encodeURIComponent(ctx.sessionId)}?tab=review`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedReviewLink(true);
      window.setTimeout(() => setCopiedReviewLink(false), 2400);
    } catch {
      // Ignore clipboard failures in restricted frames.
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
        playHirearchySound('complete');
        setStatusMsg(
          data.performanceReport.provider.mode === 'live_ai'
            ? 'Fit report ready for the next interviewer.'
            : 'Evidence summary ready. ' +
                (data.performanceReport.provider.fallbackReason ?? ''),
        );
      }
    } catch (err) {
      playHirearchySound('error');
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
      playHirearchySound('submit');
      setStatusMsg(
        decision === 'accepted'
          ? 'Acceptance published to the candidate’s account. The handoff is ready.'
          : 'Rejection decision and candidate feedback published to their Candidate Portal.',
      );
    } catch (err) {
      playHirearchySound('error');
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to publish decision.',
      );
    } finally {
      setBusyAction(null);
    }
  };

  const pendingCount = ctx.secondOpinions.filter(
    (op) => op.status === 'pending',
  ).length;
  const completedCount = ctx.secondOpinions.filter(
    (op) => op.status === 'completed',
  ).length;

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
          <div className="hiring-stack-xs">
            <span>{statusMsg}</span>
            {lastEmailDelivery?.status === 'sent' &&
            lastEmailDelivery.inboxUrl ? (
              <div className="hiring-header-actions">
                <a
                  className="hiring-btn hiring-btn-sm"
                  href={lastEmailDelivery.inboxUrl}
                >
                  <IconMail size={14} aria-hidden="true" /> Open Local Inbox →
                </a>
              </div>
            ) : null}
            {lastEmailDelivery &&
            lastEmailDelivery.status !== 'sent' &&
            lastEmailDelivery.reason ? (
              <div className="hiring-header-actions">
                <span className="hiring-muted-copy">
                  {lastEmailDelivery.reason}
                </span>
                <button
                  type="button"
                  className="hiring-btn hiring-btn-sm"
                  onClick={() => void handleCopyReviewLink()}
                >
                  <IconCopy size={14} aria-hidden="true" />{' '}
                  {copiedReviewLink ? 'Review link copied' : 'Copy review link'}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {pendingForMe.length > 0 ? (
        <section
          className="hiring-card hiring-peer-spotlight"
          aria-labelledby="peer-review-spotlight-heading"
          data-testid="peer-review-action-card"
        >
          <div className="hiring-peer-spotlight-header">
            <span className="hiring-eyebrow">
              Peer review requested · Awaiting your response
            </span>
            <h3 id="peer-review-spotlight-heading">
              {pendingForMe.length === 1
                ? `${pendingForMe[0].requestedByName} asked for your peer review`
                : `${pendingForMe.length} peer reviews awaiting your response`}
            </h3>
            <p className="hiring-muted-copy">
              Inspect the candidate&apos;s submitted code changes and session
              timeline, then leave your verdict. Your review stays internal and
              emails the requester — you do not need to publish a final hiring
              decision.
            </p>
          </div>

          {onOpenEvidence ? (
            <div
              className="hiring-peer-jump-bar"
              role="group"
              aria-label="Inspect candidate evidence"
            >
              <button
                type="button"
                className="hiring-btn hiring-btn-sm"
                onClick={() => onOpenEvidence('Code changes')}
              >
                <IconCode size={14} aria-hidden="true" /> Inspect code changes
              </button>
              <button
                type="button"
                className="hiring-btn hiring-btn-sm"
                onClick={() => onOpenEvidence('Execution runs')}
              >
                <IconTerminal2 size={14} aria-hidden="true" /> Check test &amp;
                execution runs
              </button>
              <button
                type="button"
                className="hiring-btn hiring-btn-sm"
                onClick={() => onOpenEvidence('Chronology')}
              >
                <IconListDetails size={14} aria-hidden="true" /> Full chronology
              </button>
            </div>
          ) : null}

          <div className="hiring-opinion-list">
            {pendingForMe.map((op) => {
              const selectedVerdict = opinionVerdicts[op.id] ?? 'comment';
              const responseDraft = opinionResponses[op.id] ?? '';
              const isFocused = initialPeerReviewId === op.id;

              return (
                <article
                  key={op.id}
                  ref={(el) => {
                    if (el) peerReviewRefs.current.set(op.id, el);
                    else peerReviewRefs.current.delete(op.id);
                  }}
                  className={`hiring-peer-request-body${isFocused ? ' is-focused' : ''}`}
                >
                  <div className="hiring-peer-thread-meta">
                    <strong>Requested by {op.requestedByName}</strong>
                    {op.createdAt ? (
                      <span className="hiring-muted-copy">
                        {formatTimestampShort(op.createdAt)}
                      </span>
                    ) : null}
                  </div>

                  {op.requestNote ? (
                    <blockquote className="hiring-peer-quote">
                      {op.requestNote}
                    </blockquote>
                  ) : null}

                  {hasSharedContext(op.requestContext) ? (
                    <PeerReviewSharedContextBlock
                      context={op.requestContext!}
                    />
                  ) : null}

                  <fieldset className="hiring-verdict-fieldset">
                    <legend>Your review verdict</legend>
                    <div
                      className="hiring-verdict-grid"
                      role="radiogroup"
                      aria-label="Peer review verdict"
                    >
                      {VERDICT_OPTIONS.map((option) => {
                        const checked = selectedVerdict === option.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            role="radio"
                            aria-checked={checked}
                            className={`hiring-verdict-option hiring-verdict-${option.id}${checked ? ' is-selected' : ''}`}
                            onClick={() =>
                              setOpinionVerdicts((prev) => ({
                                ...prev,
                                [op.id]: option.id,
                              }))
                            }
                          >
                            <span
                              className="hiring-verdict-icon"
                              aria-hidden="true"
                            >
                              {option.id === 'approve' ? (
                                <IconCircleCheck size={16} />
                              ) : option.id === 'request_changes' ? (
                                <IconAlertTriangle size={16} />
                              ) : (
                                <IconMessageCircle size={16} />
                              )}
                            </span>
                            <span className="hiring-verdict-copy">
                              <strong>{option.label}</strong>
                              <span>{option.description}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>

                  <div className="hiring-field">
                    <label htmlFor={`peer-response-${op.id}`}>
                      Peer review note
                    </label>
                    <textarea
                      id={`peer-response-${op.id}`}
                      rows={3}
                      value={responseDraft}
                      onChange={(e) =>
                        setOpinionResponses((prev) => ({
                          ...prev,
                          [op.id]: e.target.value,
                        }))
                      }
                      placeholder="Summarize what stood out in the code, trade-offs, edge cases, or interview follow-ups..."
                    />
                  </div>

                  <div className="hiring-header-actions">
                    <button
                      type="button"
                      className="hiring-btn hiring-btn-primary"
                      disabled={
                        busyAction !== null || responseDraft.trim().length === 0
                      }
                      onClick={() => void handleRespondOpinion(op.id)}
                    >
                      <IconSend size={15} aria-hidden="true" />{' '}
                      {busyAction === `respond:${op.id}`
                        ? 'Submitting peer review…'
                        : 'Submit peer review'}
                    </button>
                    <span className="hiring-muted-copy">
                      Notifies {op.requestedByName} by email · Stays internal
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      <section
        className="hiring-card software-review-consult"
        aria-labelledby="peer-review-team-heading"
        data-testid="team-peer-review-panel"
      >
        <div className="hiring-peer-section-head">
          <div className="hiring-candidate-name">
            <IconUsers size={18} aria-hidden="true" />
            <h3 id="peer-review-team-heading">Team peer review</h3>
          </div>
          <div className="hiring-chip-group">
            {pendingCount > 0 ? (
              <span className="hiring-pill hiring-pill-warning">
                {pendingCount} pending
              </span>
            ) : null}
            {completedCount > 0 ? (
              <span className="hiring-pill hiring-pill-success">
                {completedCount} completed
              </span>
            ) : null}
          </div>
        </div>
        <p className="hiring-muted-copy">
          Request a GitHub-PR-style peer review from a tech lead, evaluator,
          recruiter, or CTO on your team. We email them a direct link straight
          to this candidate&apos;s evidence and your notes.
        </p>

        <form
          onSubmit={handleRequestOpinion}
          className="hiring-page-shell hiring-mt-sm"
        >
          <div className="hiring-two-col">
            <div className="hiring-field">
              <label htmlFor="opinion-colleague">Teammate to review</label>
              <select
                id="opinion-colleague"
                value={opinionReviewerId}
                onChange={(e) => setOpinionReviewerId(e.target.value)}
              >
                {selectableTeammates.map((m) => (
                  <option key={m.principalId} value={m.principalId}>
                    {m.displayName || m.email} · {formatRoleLabel(m.role)}
                    {m.principalId === ctx.currentPrincipalId ? ' (you)' : ''}
                  </option>
                ))}
              </select>
              {otherTeammates.length === 0 ? (
                <p className="hiring-field-hint">
                  Only your account is in this workspace so far.{' '}
                  <a href={`${orgBase}/settings`}>
                    Invite teammates in Team &amp; Plan →
                  </a>
                </p>
              ) : null}
            </div>
            <div className="hiring-field">
              <label htmlFor="opinion-request-note">
                What should they focus on?
              </label>
              <input
                id="opinion-request-note"
                type="text"
                value={opinionRequestNote}
                onChange={(e) => setOpinionRequestNote(e.target.value)}
                placeholder="e.g. Check concurrency edge cases in moves.py before we advance"
              />
            </div>
          </div>

          {hasAttachableContext ? (
            <label className="hiring-peer-checkbox">
              <input
                type="checkbox"
                checked={attachContext}
                onChange={(e) => setAttachContext(e.target.checked)}
              />
              <span>
                Include my draft notes &amp; advisory AI summary in the email
                {attachmentPreviewParts.length > 0 ? (
                  <small className="hiring-peer-checkbox-meta">
                    {' '}
                    ({attachmentPreviewParts.join(' · ')})
                  </small>
                ) : null}
              </span>
            </label>
          ) : null}

          <div className="hiring-header-actions">
            <button
              type="submit"
              className="hiring-btn hiring-btn-primary"
              disabled={busyAction !== null || !opinionReviewerId}
            >
              <IconMail size={15} aria-hidden="true" />{' '}
              {busyAction === 'opinion'
                ? 'Sending peer review email…'
                : 'Request peer review & send email'}
            </button>
            <button
              type="button"
              className="hiring-btn"
              onClick={() => void handleCopyReviewLink()}
            >
              <IconCopy size={14} aria-hidden="true" />{' '}
              {copiedReviewLink ? 'Link copied' : 'Copy review link'}
            </button>
          </div>
        </form>

        {ctx.secondOpinions.length > 0 ? (
          <div className="hiring-opinion-list hiring-mt-md">
            {ctx.secondOpinions.map((op) => {
              const badge = verdictPillMeta(op);
              const isFocused = initialPeerReviewId === op.id;
              return (
                <article
                  key={op.id}
                  ref={(el) => {
                    if (
                      el &&
                      op.requestedReviewerPrincipalId !== ctx.currentPrincipalId
                    ) {
                      peerReviewRefs.current.set(op.id, el);
                    }
                  }}
                  className={`hiring-opinion-card${isFocused ? ' is-focused' : ''}`}
                >
                  <div className="hiring-peer-thread-meta">
                    <div className="hiring-candidate-name">
                      <strong>
                        {op.requestedByName} → {op.requestedReviewerName}
                      </strong>
                      <span className={`hiring-pill ${badge.className}`}>
                        {badge.label}
                      </span>
                    </div>
                    <span className="hiring-muted-copy">
                      {formatTimestampShort(op.respondedAt ?? op.createdAt)}
                    </span>
                  </div>

                  {op.requestNote ? (
                    <p className="hiring-dossier-bio hiring-mt-xs">
                      <strong>Asked:</strong> {op.requestNote}
                    </p>
                  ) : null}

                  {hasSharedContext(op.requestContext) ? (
                    <details className="hiring-peer-context-details">
                      <summary>Shared requester context</summary>
                      <PeerReviewSharedContextBlock
                        context={op.requestContext!}
                      />
                    </details>
                  ) : null}

                  {op.responseNote ? (
                    <blockquote className="hiring-peer-response-quote">
                      {op.responseNote}
                    </blockquote>
                  ) : op.status === 'pending' &&
                    op.requestedReviewerPrincipalId !==
                      ctx.currentPrincipalId ? (
                    <p className="hiring-muted-copy hiring-mt-xs">
                      Waiting for {op.requestedReviewerName}
                      {op.requestedReviewerEmail
                        ? ` (${op.requestedReviewerEmail})`
                        : ''}{' '}
                      to submit their review.
                    </p>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : null}
      </section>

      {ctx.canPublishDecision ? (
        <section
          className="hiring-card software-review-decision"
          aria-labelledby="final-decision-heading"
        >
          <div className="hiring-candidate-name">
            <IconCheck size={18} aria-hidden="true" />
            <h3 id="final-decision-heading">Decision and feedback</h3>
          </div>
          <p className="hiring-muted-copy">
            {pendingForMe.length > 0
              ? 'Optional for peer reviewers — only publish a decision if you own the final hiring outcome for this candidate.'
              : 'Choose the next step and add the feedback the candidate will see.'}
          </p>

          <form
            onSubmit={handlePublishDecision}
            className="hiring-page-shell hiring-mt-md"
          >
            <div
              className="hiring-builder-tabs"
              role="group"
              aria-label="Hiring decision"
            >
              <button
                type="button"
                aria-pressed={decision === 'accepted'}
                className={`hiring-builder-tab${decision === 'accepted' ? ' is-active' : ''}`}
                onClick={() => setDecision('accepted')}
              >
                Advance candidate
              </button>
              <button
                type="button"
                aria-pressed={decision === 'rejected'}
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
                          {m.displayName || m.email} ({formatRoleLabel(m.role)})
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
                        <IconSparkles size={15} aria-hidden="true" />{' '}
                        {busyAction === 'report'
                          ? 'Generating Kimi K3.1 Pro Fit Report…'
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
                  ? 'Publishing decision…'
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
