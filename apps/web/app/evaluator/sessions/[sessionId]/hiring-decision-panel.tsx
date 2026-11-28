'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  IconAlertTriangle,
  IconCheck,
  IconCircleCheck,
  IconCode,
  IconFileAnalytics,
  IconLink,
  IconListDetails,
  IconLock,
  IconMail,
  IconMessageCircle,
  IconSend,
  IconTerminal2,
  IconUsers,
} from '@tabler/icons-react';

import { DEMO_PERFORMANCE_FIT_REPORT } from '../../../../src/demo/sample-session';
import { NEXT_STAGE_OPTIONS } from '../../../../src/hiring/catalogs';
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
import {
  readPersistedJson,
  removePersistedKey,
  writePersistedJson,
} from '../../../../src/ui/browser-state';
import { formatLocalDateTime } from '../../../../src/ui/relative-time';
import { HirearchyAiThinking } from '../../../_components/ai';
import { emitToast } from '../../../_components/brand-toast';
import { CandidateOutcome } from '../../../_components/candidate-outcome';
import { CopyActionButton } from '../../../_components/copy-action-button';
import { DossierSharePanel } from '../../../r23/organizations/[organizationId]/handoffs/[sessionId]/handoff-dossier-client';
import type { EvidenceFilter } from './evidence-workbench';

export interface HiringDecisionDraft {
  readonly decision: 'accepted' | 'rejected' | null;
  readonly strengthsText: string;
  readonly weaknessesText: string;
  readonly feedbackNote: string;
  readonly internalNotes: string;
  readonly nextStageLabel: string;
  readonly handoffRecipientId: string;
}

export function initialHiringDecisionDraft(
  initialContext: SessionHiringReviewContext,
): HiringDecisionDraft {
  return {
    decision: initialContext.decision?.decision ?? null,
    strengthsText: initialContext.decision?.candidateStrengths.join('\n') ?? '',
    weaknessesText:
      initialContext.decision?.candidateWeaknesses.join('\n') ?? '',
    feedbackNote: initialContext.decision?.candidateFeedbackNote ?? '',
    internalNotes: initialContext.decision?.internalNotes ?? '',
    nextStageLabel:
      initialContext.decision?.nextStageLabel ?? NEXT_STAGE_OPTIONS[0],
    handoffRecipientId:
      initialContext.decision?.handoffRecipientPrincipalId ??
      initialContext.teamMembers.find((m) => m.role === 'cto' || m.isOwner)
        ?.principalId ??
      initialContext.teamMembers[0]?.principalId ??
      '',
  };
}

export function hiringDecisionDraftKey(
  sessionId: string,
  isolated = false,
): string {
  return isolated
    ? `hirearchy:demo:decision-draft:v2:${sessionId}`
    : `hirearchy:eval:decision-draft:v2:${sessionId}`;
}

export function restoreHiringDecisionDraft(
  sessionId: string,
  defaults: HiringDecisionDraft,
  isolated = false,
): HiringDecisionDraft {
  const saved = readPersistedJson<Partial<HiringDecisionDraft>>(
    hiringDecisionDraftKey(sessionId, isolated),
    'durable',
  );
  if (saved) {
    return {
      ...defaults,
      ...saved,
    };
  }
  if (isolated) return defaults;
  const previous = readPersistedJson<Partial<HiringDecisionDraft>>(
    `hirearchy:eval:decision-draft:v1:${sessionId}`,
    'durable',
  );
  if (!previous) return defaults;

  // The previous form preselected Advance, so that draft value may be implicit.
  return {
    ...defaults,
    ...previous,
    decision:
      previous?.decision === 'rejected' ? 'rejected' : defaults.decision,
  };
}

export interface HiringDecisionPanelProps {
  readonly initialContext: SessionHiringReviewContext;
  readonly aiReviewReport?: R27AiReviewReport | null;
  readonly initialPeerReviewId?: string | null;
  readonly draft?: HiringDecisionDraft | null;
  readonly onDraftChange?: (next: HiringDecisionDraft) => void;
  readonly onOpenEvidence?: (filter: EvidenceFilter) => void;
  readonly onContextChange?: (next: SessionHiringReviewContext) => void;
  readonly advisory?: ReactNode;
  readonly onBackToEvidence?: () => void;
  readonly demoMode?: boolean;
  readonly isSample?: boolean;
  readonly onSimulatedPublish?: (
    draft: HiringDecisionDraft,
    report: PerformanceFitReport | null,
  ) => void;
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
  draft: controlledDraft,
  onDraftChange,
  onOpenEvidence,
  onContextChange,
  advisory,
  onBackToEvidence,
  demoMode = false,
  isSample = false,
  onSimulatedPublish,
}: HiringDecisionPanelProps) {
  const isolated = demoMode || isSample;
  const [ctx, setCtxState] =
    useState<SessionHiringReviewContext>(initialContext);
  const setCtx = (next: SessionHiringReviewContext) => {
    setCtxState(next);
    onContextChange?.(next);
  };
  const otherTeammates = useMemo(
    () =>
      ctx.teamMembers.filter(
        (member) => member.principalId !== ctx.currentPrincipalId,
      ),
    [ctx.teamMembers, ctx.currentPrincipalId],
  );
  const [peerFormOpen, setPeerFormOpen] = useState(
    initialContext.secondOpinions.length > 0,
  );
  const [preferredPeerId, setPreferredPeerId] = useState('');
  const opinionReviewerId =
    otherTeammates.find((member) => member.principalId === preferredPeerId)
      ?.principalId ??
    otherTeammates[0]?.principalId ??
    '';
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
  const peerDraftStorageKey = isolated
    ? `hirearchy:demo:peer-draft:v1:${ctx.sessionId}`
    : `hirearchy:eval:peer-draft:v1:${ctx.sessionId}`;
  const [peerDraftHydrated, setPeerDraftHydrated] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const saved = readPersistedJson<{
        preferredPeerId?: string;
        opinionRequestNote?: string;
        attachContext?: boolean;
        opinionResponses?: Record<string, string>;
        opinionVerdicts?: Record<string, PeerReviewVerdict>;
      }>(peerDraftStorageKey, 'durable');
      if (saved && typeof saved === 'object') {
        if (typeof saved.preferredPeerId === 'string') {
          setPreferredPeerId(saved.preferredPeerId);
        }
        if (typeof saved.opinionRequestNote === 'string') {
          setOpinionRequestNote(saved.opinionRequestNote);
        }
        if (typeof saved.attachContext === 'boolean') {
          setAttachContext(saved.attachContext);
        }
        if (
          saved.opinionResponses &&
          typeof saved.opinionResponses === 'object'
        ) {
          setOpinionResponses(saved.opinionResponses);
        }
        if (
          saved.opinionVerdicts &&
          typeof saved.opinionVerdicts === 'object'
        ) {
          setOpinionVerdicts(saved.opinionVerdicts);
        }
      }
      setPeerDraftHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [peerDraftStorageKey]);

  useEffect(() => {
    if (!peerDraftHydrated) return;
    const hasContent =
      Boolean(preferredPeerId) ||
      Boolean(opinionRequestNote.trim()) ||
      attachContext === false ||
      Object.values(opinionResponses).some((v) => Boolean(v.trim())) ||
      Object.keys(opinionVerdicts).length > 0;
    if (!hasContent) {
      removePersistedKey(peerDraftStorageKey);
      return;
    }
    writePersistedJson(
      peerDraftStorageKey,
      {
        preferredPeerId,
        opinionRequestNote,
        attachContext,
        opinionResponses,
        opinionVerdicts,
      },
      'durable',
    );
  }, [
    attachContext,
    opinionRequestNote,
    opinionResponses,
    opinionVerdicts,
    peerDraftHydrated,
    peerDraftStorageKey,
    preferredPeerId,
  ]);

  const defaultDraft = useMemo(
    () => initialHiringDecisionDraft(initialContext),
    [initialContext],
  );
  const draftStorageKey = hiringDecisionDraftKey(ctx.sessionId, isolated);
  const [internalDraft, setInternalDraft] =
    useState<HiringDecisionDraft>(defaultDraft);
  const activeDraft = controlledDraft ?? internalDraft;
  const [draftSaveStatus, setDraftSaveStatus] = useState<
    'saved' | 'unavailable' | null
  >(null);
  const updateDraft = (patch: Partial<HiringDecisionDraft>) => {
    const next = { ...activeDraft, ...patch };
    setInternalDraft(next);
    onDraftChange?.(next);
    const saved = writePersistedJson(draftStorageKey, next, 'durable');
    setDraftSaveStatus(saved ? 'saved' : 'unavailable');
  };
  const decision = activeDraft.decision;
  const strengthsText = activeDraft.strengthsText;
  const weaknessesText = activeDraft.weaknessesText;
  const feedbackNote = activeDraft.feedbackNote;
  const internalNotes = activeDraft.internalNotes;
  const nextStageLabel = activeDraft.nextStageLabel;
  const handoffRecipientId = activeDraft.handoffRecipientId;
  const setDecision = (val: 'accepted' | 'rejected') =>
    updateDraft({ decision: val });
  const setStrengthsText = (val: string) => updateDraft({ strengthsText: val });
  const setWeaknessesText = (val: string) =>
    updateDraft({ weaknessesText: val });
  const setFeedbackNote = (val: string) => updateDraft({ feedbackNote: val });
  const setInternalNotes = (val: string) => updateDraft({ internalNotes: val });
  const setNextStageLabel = (val: string) =>
    updateDraft({ nextStageLabel: val });
  const setHandoffRecipientId = (val: string) =>
    updateDraft({ handoffRecipientId: val });

  useEffect(() => {
    if (controlledDraft) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        setInternalDraft(
          restoreHiringDecisionDraft(ctx.sessionId, defaultDraft, isolated),
        );
      } catch {
        // Ignore malformed draft cache
      }
    });
    return () => {
      active = false;
    };
  }, [controlledDraft, ctx.sessionId, defaultDraft, isolated]);

  const isDirtyDraft =
    decision !== defaultDraft.decision ||
    strengthsText !== defaultDraft.strengthsText ||
    weaknessesText !== defaultDraft.weaknessesText ||
    feedbackNote !== defaultDraft.feedbackNote ||
    internalNotes !== defaultDraft.internalNotes ||
    nextStageLabel !== defaultDraft.nextStageLabel ||
    handoffRecipientId !== defaultDraft.handoffRecipientId;

  useEffect(() => {
    if (!isDirtyDraft) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirtyDraft]);

  const [performanceReport, setPerformanceReport] =
    useState<PerformanceFitReport | null>(
      initialContext.decision?.performanceReport ?? null,
    );

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [reportStartedAt, setReportStartedAt] = useState<number | undefined>(
    undefined,
  );
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
    if (!opinionReviewerId || busyAction !== null) return;
    setErrorMsg(null);
    setStatusMsg(null);
    setLastEmailDelivery(null);
    if (isolated) {
      const reviewer = ctx.teamMembers.find(
        (m) => m.principalId === opinionReviewerId,
      );
      const requester = ctx.teamMembers.find(
        (m) => m.principalId === ctx.currentPrincipalId,
      );
      const requestContext = buildRequestContextPayload();
      const simulatedOpinion: SecondOpinionRecord = {
        id: `sim-opinion-${Date.now()}`,
        sessionId: ctx.sessionId,
        requestedByPrincipalId: ctx.currentPrincipalId,
        requestedByName: requester?.displayName ?? 'You',
        requestedReviewerPrincipalId: opinionReviewerId,
        requestedReviewerName: reviewer?.displayName ?? 'Teammate',
        requestNote: opinionRequestNote.trim(),
        ...(requestContext ? { requestContext } : {}),
        responseNote: null,
        verdict: null,
        status: 'pending',
        createdAt: new Date().toISOString(),
        respondedAt: null,
      };
      setCtx({
        ...ctx,
        secondOpinions: [simulatedOpinion, ...ctx.secondOpinions],
      });
      setOpinionRequestNote('');
      setStatusMsg(
        `Sandbox preview: peer review request added for ${simulatedOpinion.requestedReviewerName} (no email sent).`,
      );
      return;
    }
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

      setStatusMsg(
        data?.emailDelivery?.status === 'sent'
          ? `Peer review requested and emailed to ${data.emailDelivery.recipientEmail}.`
          : 'Peer review request saved in the workspace.',
      );
    } catch (err) {
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
    if (isolated) {
      setCtx({
        ...ctx,
        secondOpinions: ctx.secondOpinions.map((op) =>
          op.id === opinionId
            ? {
                ...op,
                status: 'completed',
                responseNote: note,
                verdict,
                respondedAt: new Date().toISOString(),
              }
            : op,
        ),
      });
      setStatusMsg('Sandbox preview: peer review response recorded locally.');
      return;
    }
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
      setOpinionVerdicts((prev) => {
        if (!Object.hasOwn(prev, opinionId)) return prev;
        const next = { ...prev };
        delete next[opinionId];
        return next;
      });

      setStatusMsg(
        data?.emailDelivery?.status === 'sent'
          ? `Peer review submitted and emailed back to ${data.emailDelivery.recipientEmail}.`
          : 'Peer review submitted.',
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to submit peer review.',
      );
    } finally {
      setBusyAction(null);
    }
  };

  const reviewLinkValue =
    typeof window !== 'undefined'
      ? `${window.location.origin}/r27/organizations/${encodeURIComponent(ctx.organizationId)}/sessions/${encodeURIComponent(ctx.sessionId)}?tab=review`
      : `/r27/organizations/${encodeURIComponent(ctx.organizationId)}/sessions/${encodeURIComponent(ctx.sessionId)}?tab=review`;

  const handleGeneratePerformanceReport = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    if (isolated) {
      const customStrengths = splitLines(strengthsText);
      const customWeaknesses = splitLines(weaknessesText);
      const localReport: PerformanceFitReport = {
        ...DEMO_PERFORMANCE_FIT_REPORT,
        strengths:
          customStrengths.length > 0
            ? customStrengths
            : DEMO_PERFORMANCE_FIT_REPORT.strengths,
        weaknessesAndRisks:
          customWeaknesses.length > 0
            ? customWeaknesses
            : DEMO_PERFORMANCE_FIT_REPORT.weaknessesAndRisks,
        provider: {
          ...DEMO_PERFORMANCE_FIT_REPORT.provider,
          generatedAt: new Date().toISOString(),
        },
      };
      setPerformanceReport(localReport);
      setStatusMsg('Sandbox Managerial Fit Report ready.');
      emitToast({
        message: 'Sandbox Managerial Fit Report ready.',
        tone: 'success',
      });
      return;
    }
    setBusyAction('report');
    setReportStartedAt(Date.now());
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

        const readyMessage =
          data.performanceReport.provider.mode === 'live_ai'
            ? 'Fit report ready for the next interviewer.'
            : 'Evidence summary ready. ' +
              (data.performanceReport.provider.fallbackReason ?? '');
        setStatusMsg(readyMessage);
        emitToast({
          message:
            data.performanceReport.provider.mode === 'live_ai'
              ? 'Managerial Fit Report ready.'
              : 'Evidence summary ready.',
          tone: 'success',
        });
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to generate fit report.',
      );
    } finally {
      setBusyAction(null);
      setReportStartedAt(undefined);
    }
  };

  const handlePublishDecision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      busyAction !== null ||
      (decision !== 'accepted' && decision !== 'rejected')
    )
      return;
    setErrorMsg(null);
    setStatusMsg(null);
    if (isolated) {
      const nowIso = new Date().toISOString();
      const recipient = ctx.teamMembers.find(
        (m) => m.principalId === handoffRecipientId,
      );
      const decider = ctx.teamMembers.find(
        (m) => m.principalId === ctx.currentPrincipalId,
      );
      const nextReport =
        decision === 'accepted'
          ? (performanceReport ?? DEMO_PERFORMANCE_FIT_REPORT)
          : performanceReport;
      if (nextReport && !performanceReport) {
        setPerformanceReport(nextReport);
      }
      setCtx({
        ...ctx,
        decision: {
          sessionId: ctx.sessionId,
          organizationId: ctx.organizationId,
          decidedByPrincipalId: ctx.currentPrincipalId,
          decidedByName: decider?.displayName ?? 'Evaluator',
          decision,
          candidateStrengths: splitLines(strengthsText),
          candidateWeaknesses: splitLines(weaknessesText),
          candidateFeedbackNote: feedbackNote,
          internalNotes,
          nextStageLabel: decision === 'accepted' ? nextStageLabel : null,
          handoffRecipientPrincipalId:
            decision === 'accepted' ? handoffRecipientId || null : null,
          handoffRecipientName:
            decision === 'accepted' ? (recipient?.displayName ?? null) : null,
          handoffStatus: decision === 'accepted' ? 'pending' : 'none',
          performanceReport: nextReport,
          publishedAt: nowIso,
          updatedAt: nowIso,
        },
      });
      removePersistedKey(draftStorageKey);
      setDraftSaveStatus(null);
      setStatusMsg(
        decision === 'accepted'
          ? `Sandbox preview: Advancement to ${nextStageLabel.trim() || 'next stage'} simulated. Zero credits used.`
          : 'Sandbox preview: Rejection feedback simulated. Zero credits used.',
      );
      if (onSimulatedPublish) {
        onSimulatedPublish(activeDraft, nextReport);
      } else {
        emitToast({
          message: 'Simulated decision preview ready.',
          tone: 'success',
        });
      }
      return;
    }
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
      removePersistedKey(draftStorageKey);
      removePersistedKey(`hirearchy:eval:decision-draft:v1:${ctx.sessionId}`);
      if (data?.reportError) setErrorMsg(data.reportError);

      setDraftSaveStatus(null);
      const publishedMsg =
        decision === 'accepted'
          ? `Advancement to ${nextStageLabel.trim() || 'next stage'} published. Candidate feedback and team handoff are ready.`
          : 'Rejection decision and candidate feedback published to their Candidate Portal.';
      setStatusMsg(publishedMsg);
      emitToast({
        message:
          decision === 'accepted'
            ? 'Advancement published & handoff ready.'
            : 'Decision published to candidate portal.',
        tone: 'success',
      });
    } catch (err) {
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

  const strengthsPreviewList = splitLines(strengthsText);
  const weaknessesPreviewList = splitLines(weaknessesText);

  return (
    <div className="hiring-page-shell" data-testid="hiring-decision-panel">
      {ctx.decision ? (
        <p className="hiring-filter-result" role="status">
          {ctx.decision.decision === 'accepted'
            ? `Advanced · ${ctx.decision.nextStageLabel ?? 'Handoff ready'}`
            : 'Rejection published'}
        </p>
      ) : null}
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
                <CopyActionButton
                  value={reviewLinkValue}
                  label="Copy review link"
                  copiedLabel="Review link copied"
                  toastMessage="Review link copied."
                  size="sm"
                  variant="secondary"
                />
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
                        {formatLocalDateTime(op.createdAt)}
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

      {ctx.canPublishDecision ? (
        <section
          className="hiring-card software-review-decision"
          aria-labelledby="final-decision-heading"
        >
          <form
            onSubmit={handlePublishDecision}
            className="review-desk-decision-form"
          >
            <div className="review-desk-decision-editor">
              <h3 id="final-decision-heading">Decision</h3>
              {pendingForMe.length > 0 ? (
                <p className="hiring-muted-copy">
                  Publish only if you own the final hiring decision.
                </p>
              ) : null}
              <div
                className="review-desk-outcomes"
                role="group"
                aria-label="Hiring decision"
              >
                <button
                  type="button"
                  data-outcome="accepted"
                  aria-pressed={decision === 'accepted'}
                  onClick={() => setDecision('accepted')}
                >
                  <IconCheck size={17} aria-hidden="true" />
                  Advance candidate
                </button>
                <button
                  type="button"
                  data-outcome="rejected"
                  aria-pressed={decision === 'rejected'}
                  onClick={() => setDecision('rejected')}
                >
                  <IconCheck size={17} aria-hidden="true" />
                  Reject candidate
                </button>
              </div>

              <div
                className="review-desk-handoff-reveal"
                data-open={decision === 'accepted'}
                aria-hidden={decision !== 'accepted'}
                inert={decision !== 'accepted'}
              >
                <div>
                  <section
                    className="review-desk-handoff"
                    aria-label="Interview handoff"
                  >
                    <div className="hiring-two-col">
                      <div className="hiring-field">
                        <label htmlFor="decision-next-stage">Next step</label>
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
                          Interviewer
                        </label>
                        <select
                          id="decision-handoff-recipient"
                          value={handoffRecipientId}
                          onChange={(e) =>
                            setHandoffRecipientId(e.target.value)
                          }
                        >
                          {ctx.teamMembers.map((m) => (
                            <option key={m.principalId} value={m.principalId}>
                              {m.displayName ||
                                (m.isOwner &&
                                m.principalId === ctx.currentPrincipalId
                                  ? 'Workspace owner'
                                  : m.email)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {canGenerateFitReport || performanceReport ? (
                      <div className="hiring-stack-sm hiring-mt-sm">
                        {canGenerateFitReport ? (
                          <div className="hiring-header-actions">
                            <button
                              type="button"
                              className="hiring-btn"
                              disabled={busyAction !== null}
                              onClick={() =>
                                void handleGeneratePerformanceReport()
                              }
                            >
                              <IconFileAnalytics size={15} aria-hidden="true" />{' '}
                              {busyAction === 'report'
                                ? 'Generating Fit Report…'
                                : performanceReport
                                  ? 'Refresh Managerial Fit Report'
                                  : 'Generate Managerial Fit Report'}
                            </button>
                          </div>
                        ) : null}
                        {busyAction === 'report' ? (
                          <HirearchyAiThinking
                            variant="advisory"
                            status="active"
                            badge="Advisory only"
                            headline="Synthesizing Managerial Fit Report…"
                            sublabel="Preparing an advisory summary of the submitted work and requirement coverage."
                            startedAt={reportStartedAt}
                            testId="fit-report-thinking"
                          />
                        ) : null}
                        {performanceReport ? (
                          <div className="hiring-card hiring-card-compact">
                            <span className="hiring-eyebrow">
                              {performanceReport.provider.mode === 'live_ai'
                                ? 'AI advisory'
                                : 'Evidence summary'}
                            </span>
                            <h4>{performanceReport.fitHeadline}</h4>
                            <p className="hiring-dossier-bio">
                              {performanceReport.whyGoodOrBadFit}
                            </p>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </section>
                </div>
              </div>

              <section
                className="review-desk-feedback"
                aria-labelledby="decision-candidate-region-title"
              >
                <h4 id="decision-candidate-region-title">Candidate feedback</h4>
                <fieldset className="hiring-decision-feedback">
                  <legend className="review-desk-hidden">
                    Feedback fields
                  </legend>
                  <div className="hiring-two-col">
                    <div className="hiring-field">
                      <label htmlFor="decision-strengths">
                        Strengths (one per line)
                      </label>
                      <textarea
                        id="decision-strengths"
                        value={strengthsText}
                        onChange={(e) => setStrengthsText(e.target.value)}
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
                    />
                  </div>
                </fieldset>
              </section>

              <details className="evaluator-source-details review-desk-private">
                <summary>
                  <IconLock size={17} aria-hidden="true" /> Private team notes
                </summary>
                <div className="hiring-field">
                  <label
                    className="review-desk-hidden"
                    htmlFor="decision-internal-notes"
                  >
                    Private team notes
                  </label>
                  <textarea
                    id="decision-internal-notes"
                    value={internalNotes}
                    onChange={(e) => setInternalNotes(e.target.value)}
                    placeholder="Only your hiring team can see these notes."
                  />
                </div>
              </details>
            </div>

            <div className="review-desk-candidate-preview">
              <section
                className="review-desk-preview-stage"
                data-testid="decision-publish-preview"
                aria-label="Candidate preview"
              >
                <div className="review-desk-preview-header">
                  <h4>Candidate preview</h4>
                  <p className="hiring-muted-copy">
                    Exact view visible to candidate after publishing.
                  </p>
                </div>
                <div className="review-desk-preview-bezel">
                  <div className="review-desk-preview-chrome">
                    <span
                      className="review-desk-preview-dots"
                      aria-hidden="true"
                    >
                      <span />
                      <span />
                      <span />
                    </span>
                    <span className="review-desk-preview-portal-label">
                      Candidate Portal · Outcome Card
                    </span>
                    <span
                      className={`review-desk-preview-scope ${decision ? 'is-active' : ''}`}
                    >
                      {decision ? 'Visible on publish' : 'Draft preview'}
                    </span>
                  </div>
                  <div className="review-desk-preview-body">
                    {decision ? (
                      <CandidateOutcome
                        outcome={{
                          decision,
                          nextStageLabel: nextStageLabel.trim(),
                          feedbackNote: feedbackNote.trim(),
                          strengths: strengthsPreviewList,
                          weaknesses: weaknessesPreviewList,
                        }}
                      />
                    ) : (
                      <p className="review-desk-preview-empty">
                        Choose an outcome to see the preview.
                      </p>
                    )}
                  </div>
                </div>
              </section>
              {advisory}
              {decision === 'accepted' &&
              !canGenerateFitReport &&
              !performanceReport &&
              hasPlanFeature(ctx.plan.planTier, 'aiCandidateReview') ? (
                <p className="review-desk-advisory-note">
                  Managerial fit report ·{' '}
                  <a href={`${orgBase}/plan`}>Available on Ultra</a>
                </p>
              ) : null}
            </div>

            <div className="review-desk-publish">
              <span
                id="review-desk-publish-state"
                className="review-desk-publish-status"
                data-state={
                  busyAction === 'publish'
                    ? 'publishing'
                    : !decision
                      ? 'pending'
                      : draftSaveStatus === 'unavailable'
                        ? 'warning'
                        : draftSaveStatus === 'saved'
                          ? 'saved'
                          : ctx.decision?.decision === decision && !isDirtyDraft
                            ? 'published'
                            : 'ready'
                }
                role="status"
              >
                <span className="review-desk-publish-dot" aria-hidden="true" />
                {busyAction === 'publish' ? (
                  'Publishing…'
                ) : !decision ? (
                  'Choose an outcome first'
                ) : draftSaveStatus === 'unavailable' ? (
                  'Draft storage unavailable'
                ) : draftSaveStatus === 'saved' ? (
                  <>
                    <IconCheck size={16} aria-hidden="true" /> Draft saved in
                    this tab
                  </>
                ) : ctx.decision?.decision === decision && !isDirtyDraft ? (
                  <>
                    <IconCircleCheck size={16} aria-hidden="true" />{' '}
                    {isolated ? 'Outcome simulated' : 'Outcome published'}
                  </>
                ) : isolated ? (
                  'Ready to simulate'
                ) : (
                  'Ready to publish'
                )}
              </span>
              <div className="hiring-header-actions">
                {!isolated && ctx.decision?.decision === 'accepted' ? (
                  <a
                    className="hiring-btn"
                    href={`${orgBase}/handoffs/${encodeURIComponent(ctx.sessionId)}`}
                  >
                    Open handoff
                  </a>
                ) : null}
                {!isolated && ctx.decision ? (
                  <button
                    type="button"
                    className="hiring-btn"
                    onClick={() => setShareModalOpen(true)}
                  >
                    <IconLink size={15} aria-hidden="true" /> Share executive
                    dossier
                  </button>
                ) : null}
                {isolated && ctx.decision ? (
                  <a className="hiring-btn" href="/dossier/demo">
                    Preview executive dossier
                  </a>
                ) : null}
                {onBackToEvidence ? (
                  <button
                    type="button"
                    className="review-desk-back-code"
                    onClick={onBackToEvidence}
                  >
                    Back to code
                  </button>
                ) : null}
                <button
                  type="submit"
                  className="hiring-btn hiring-btn-primary review-desk-publish-button"
                  aria-describedby="review-desk-publish-state"
                  disabled={busyAction !== null || decision === null}
                >
                  {busyAction === 'publish'
                    ? 'Publishing decision…'
                    : isolated
                      ? 'Simulate decision'
                      : 'Publish decision'}
                </button>
              </div>
            </div>
          </form>
        </section>
      ) : (
        advisory
      )}
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
        {otherTeammates.length > 0 ? (
          <>
            <p className="hiring-muted-copy">
              Invite a teammate for a second review and verdict.
            </p>

            <details
              className="hiring-disclosure hiring-mt-sm"
              open={peerFormOpen}
              onToggle={(event) =>
                setPeerFormOpen(
                  (event.currentTarget as HTMLDetailsElement).open,
                )
              }
            >
              <summary>+ Request peer review</summary>
              <form
                onSubmit={handleRequestOpinion}
                className="hiring-page-shell hiring-mt-sm"
              >
                <div className="hiring-two-col">
                  <div className="hiring-field">
                    <label htmlFor="opinion-colleague">
                      Teammate to review
                    </label>
                    <select
                      id="opinion-colleague"
                      value={opinionReviewerId}
                      onChange={(e) => setPreferredPeerId(e.target.value)}
                    >
                      {otherTeammates.map((m) => (
                        <option key={m.principalId} value={m.principalId}>
                          {m.displayName || m.email} · {formatRoleLabel(m.role)}
                        </option>
                      ))}
                    </select>
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
                      Include my draft notes &amp; advisory AI summary in the
                      email
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
                  <CopyActionButton
                    value={reviewLinkValue}
                    label="Copy review link"
                    copiedLabel="Link copied"
                    toastMessage="Review link copied."
                    size="md"
                    variant="secondary"
                  />
                </div>
              </form>
            </details>
          </>
        ) : (
          <div className="hiring-stack-xs">
            <p className="hiring-muted-copy">
              {ctx.currentRole !== 'cto' && !ctx.isOwner
                ? 'Ask a workspace admin to invite a teammate before requesting a second review.'
                : 'Invite a teammate to request a second review.'}
            </p>
            {ctx.currentRole === 'cto' || ctx.isOwner ? (
              <div>
                <a
                  className="hiring-btn hiring-btn-sm"
                  href={`${orgBase}/settings#team-invitations`}
                >
                  Invite a teammate
                </a>
              </div>
            ) : null}
          </div>
        )}

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
                      {formatLocalDateTime(op.respondedAt ?? op.createdAt)}
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

      {!isolated && shareModalOpen && ctx.decision ? (
        <div
          className="r210-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Share executive dossier"
        >
          <div
            className="r210-modal-dialog"
            style={{ maxWidth: '640px', maxHeight: '90vh', overflowY: 'auto' }}
          >
            <DossierSharePanel
              organizationId={ctx.organizationId}
              sessionId={ctx.sessionId}
              candidateLabel={ctx.candidateName ?? ctx.candidateCode}
              compact
              onClose={() => setShareModalOpen(false)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
