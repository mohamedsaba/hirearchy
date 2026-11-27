'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  IconExternalLink,
  IconEye,
  IconFileAnalytics,
  IconLink,
  IconLock,
  IconShieldLock,
  IconTrash,
  IconX,
} from '@tabler/icons-react';

import { experienceLevelLabel } from '../../../../../../src/hiring/catalogs';
import type { HandoffDossierItem } from '../../../../../../src/hiring/types';
import {
  hasPlanFeature,
  type OrganizationPlanSummary,
} from '../../../../../../src/plans/entitlements';
import { HirearchyAiThinking } from '../../../../../_components/ai';
import { emitToast } from '../../../../../_components/brand-toast';
import { CommonThreadLoader } from '../../../../../_components/common-thread-loader';
import { CopyActionButton } from '../../../../../_components/copy-action-button';

export interface DossierShareLinkRecord {
  readonly id: string;
  readonly visibilityMode: 'redacted' | 'named';
  readonly includeAiAdvisory: boolean;
  readonly includeVerificationQuestions: boolean;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly viewCount: number;
  readonly lastViewedAt: string | null;
  readonly createdAt: string;
}

export interface DossierSharePanelProps {
  readonly organizationId: string;
  readonly sessionId: string;
  readonly candidateLabel?: string | null;
  readonly onClose?: () => void;
  readonly compact?: boolean;
}

function formatShortDate(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function DossierSharePanel({
  organizationId,
  sessionId,
  candidateLabel,
  onClose,
  compact = false,
}: DossierSharePanelProps) {
  const [links, setLinks] = useState<readonly DossierShareLinkRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedAtMs, setLoadedAtMs] = useState<number>(0);
  const [submitting, setSubmitting] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [visibilityMode, setVisibilityMode] = useState<'redacted' | 'named'>(
    'redacted',
  );
  const [includeAiAdvisory, setIncludeAiAdvisory] = useState(true);
  const [includeVerificationQuestions, setIncludeVerificationQuestions] =
    useState(true);
  const [expiresDays, setExpiresDays] = useState<number>(14);
  const [createdShareUrl, setCreatedShareUrl] = useState<string | null>(null);

  const dossiersApiUrl = `/r23/api/organizations/${encodeURIComponent(organizationId)}/hiring/dossiers`;

  const loadLinks = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch(
        `${dossiersApiUrl}?sessionId=${encodeURIComponent(sessionId)}`,
        {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        },
      );
      const data = (await res.json().catch(() => null)) as {
        links?: DossierShareLinkRecord[];
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        throw new Error(
          data?.error?.message ?? `Unable to load share links (${res.status})`,
        );
      }
      setLinks(Array.isArray(data?.links) ? data.links : []);
      setLoadedAtMs(Date.now());
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to load share links.',
      );
    } finally {
      setLoading(false);
    }
  }, [dossiersApiUrl, sessionId]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetch(`${dossiersApiUrl}?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as {
          links?: DossierShareLinkRecord[];
          error?: { message?: string };
        } | null;
        if (!res.ok) {
          throw new Error(
            data?.error?.message ??
              `Unable to load share links (${res.status})`,
          );
        }
        return Array.isArray(data?.links) ? data.links : [];
      })
      .then((nextLinks) => {
        if (!active) return;
        setLinks(nextLinks);
        setLoadedAtMs(Date.now());
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!active) return;
        setErrorMsg(
          err instanceof Error ? err.message : 'Unable to load share links.',
        );
        setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [dossiersApiUrl, sessionId]);

  const copyShareUrlQuietly = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      emitToast({
        message: 'Executive dossier link created and copied.',
        tone: 'success',
      });
    } catch {
      emitToast({
        message: 'Executive dossier link created — copy it below.',
        tone: 'info',
      });
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const csrf = readCsrfCookie();
      const res = await fetch(dossiersApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'create',
          sessionId,
          visibilityMode,
          includeAiAdvisory,
          includeVerificationQuestions,
          expiresDays,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        link?: DossierShareLinkRecord;
        shareUrl?: string;
        shareToken?: string;
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        throw new Error(
          data?.error?.message ?? `Unable to create share link (${res.status})`,
        );
      }
      const nextUrl =
        data?.shareUrl ??
        (data?.shareToken && typeof window !== 'undefined'
          ? `${window.location.origin}/dossier/${encodeURIComponent(data.shareToken)}`
          : null);
      if (nextUrl) {
        setCreatedShareUrl(nextUrl);
        void copyShareUrlQuietly(nextUrl);
      }
      if (data?.link) {
        setLinks((prev) => [data.link!, ...prev]);
      } else {
        await loadLinks();
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to create share link.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevoke = async (shareId: string) => {
    if (revokingId) return;
    setRevokingId(shareId);
    setErrorMsg(null);
    try {
      const csrf = readCsrfCookie();
      const res = await fetch(dossiersApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'revoke',
          shareId,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        throw new Error(
          data?.error?.message ?? `Unable to revoke link (${res.status})`,
        );
      }
      setLinks((prev) =>
        prev.map((item) =>
          item.id === shareId
            ? { ...item, revokedAt: new Date().toISOString() }
            : item,
        ),
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to revoke share link.',
      );
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div
      className={compact ? 'hiring-stack-sm' : 'hiring-card hiring-stack-sm'}
      data-testid="share-executive-dossier-panel"
    >
      <div className="hiring-preview-header">
        <div>
          <span className="hiring-eyebrow">
            <IconShieldLock size={13} aria-hidden="true" /> Executive Dossier
            Link
          </span>
          <h3 className="hiring-mt-xs">
            Share executive dossier
            {candidateLabel ? ` · ${candidateLabel}` : ''}
          </h3>
          <p className="hiring-muted-copy">
            Read-only brief for CTOs and hiring committees. Never exposes
            candidate email, phone, ID documents, or private internal notes.
          </p>
        </div>
        {onClose ? (
          <button
            type="button"
            className="hiring-btn hiring-btn-sm"
            onClick={onClose}
            aria-label="Close share dossier dialog"
          >
            <IconX size={15} aria-hidden="true" /> Close
          </button>
        ) : null}
      </div>

      {errorMsg ? (
        <div className="hiring-banner hiring-banner-danger" role="alert">
          {errorMsg}
        </div>
      ) : null}

      <form onSubmit={handleCreate} className="hiring-stack-sm">
        <div className="hiring-two-col">
          <div className="hiring-field">
            <label htmlFor={`dossier-visibility-${sessionId}`}>
              Identity visibility
            </label>
            <select
              id={`dossier-visibility-${sessionId}`}
              value={visibilityMode}
              onChange={(e) =>
                setVisibilityMode(
                  e.target.value === 'named' ? 'named' : 'redacted',
                )
              }
            >
              <option value="redacted">
                Redacted (Recommended — first name + initial &amp; code)
              </option>
              <option value="named">
                Named (Full name, headline role &amp; city)
              </option>
            </select>
          </div>
          <div className="hiring-field">
            <label htmlFor={`dossier-expiry-${sessionId}`}>Link expiry</label>
            <select
              id={`dossier-expiry-${sessionId}`}
              value={expiresDays}
              onChange={(e) => setExpiresDays(Number(e.target.value))}
            >
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </div>
        </div>

        <div className="hiring-chip-group">
          <label className="hiring-peer-checkbox">
            <input
              type="checkbox"
              checked={includeAiAdvisory}
              onChange={(e) => setIncludeAiAdvisory(e.target.checked)}
            />
            <span>Include advisory fit summary</span>
          </label>
          <label className="hiring-peer-checkbox">
            <input
              type="checkbox"
              checked={includeVerificationQuestions}
              onChange={(e) =>
                setIncludeVerificationQuestions(e.target.checked)
              }
            />
            <span>Include live verification questions</span>
          </label>
        </div>

        <div className="hiring-header-actions">
          <button
            type="submit"
            className="hiring-btn hiring-btn-primary"
            disabled={submitting}
          >
            <IconLink size={15} aria-hidden="true" />
            {submitting
              ? 'Creating share link…'
              : 'Create & copy executive link'}
          </button>
        </div>
      </form>

      {createdShareUrl ? (
        <div className="hiring-banner hiring-banner-success" role="status">
          <div className="hiring-stack-xs" style={{ width: '100%' }}>
            <strong>Share link created (shown once)</strong>
            <code style={{ overflowWrap: 'anywhere', fontSize: '0.8rem' }}>
              {createdShareUrl}
            </code>
            <div className="hiring-header-actions">
              <CopyActionButton
                value={createdShareUrl}
                label="Copy link"
                copiedLabel="Copied link"
                toastMessage="Executive dossier link copied."
                size="sm"
                variant="secondary"
              />
              <a
                className="hiring-btn hiring-btn-sm"
                href={createdShareUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <IconExternalLink size={14} aria-hidden="true" /> Open dossier
              </a>
            </div>
          </div>
        </div>
      ) : null}

      <div className="hiring-stack-xs">
        <strong className="hiring-sublabel">Active &amp; past links</strong>
        {loading ? (
          <CommonThreadLoader compact label="Loading share links…" />
        ) : links.length === 0 ? (
          <p className="hiring-muted-copy">
            No executive share links created for this session yet.
          </p>
        ) : (
          <ul
            className="hiring-opinion-list"
            style={{ listStyle: 'none', padding: 0, margin: 0 }}
          >
            {links.map((link) => {
              const revoked = Boolean(link.revokedAt);
              const expired =
                loadedAtMs > 0 && Date.parse(link.expiresAt) <= loadedAtMs;
              return (
                <li key={link.id} className="hiring-opinion-card">
                  <div className="hiring-preview-header">
                    <div className="hiring-chip-group">
                      <span
                        className={`hiring-pill ${link.visibilityMode === 'redacted' ? 'hiring-pill-plum' : 'hiring-pill-warning'}`}
                      >
                        {link.visibilityMode === 'redacted'
                          ? 'Redacted'
                          : 'Named'}
                      </span>
                      <span
                        className={`hiring-pill ${revoked || expired ? 'hiring-pill-danger' : 'hiring-pill-success'}`}
                      >
                        {revoked ? 'Revoked' : expired ? 'Expired' : 'Active'}
                      </span>
                      <span className="hiring-muted-copy">
                        {link.viewCount}{' '}
                        {link.viewCount === 1 ? 'view' : 'views'} · Expires{' '}
                        {formatShortDate(link.expiresAt)}
                      </span>
                    </div>
                    {!revoked && !expired ? (
                      <button
                        type="button"
                        className="hiring-btn hiring-btn-sm hiring-btn-danger"
                        disabled={revokingId === link.id}
                        onClick={() => void handleRevoke(link.id)}
                      >
                        <IconTrash size={14} aria-hidden="true" />
                        {revokingId === link.id ? 'Revoking…' : 'Revoke'}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

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

function handoffStatusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'Needs review';
    case 'reviewed':
      return 'Reviewed';
    case 'completed':
      return 'Interview done';
    default:
      return status;
  }
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
  const [shareModalOpen, setShareModalOpen] = useState(false);

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

      emitToast({
        message: `Handoff updated: ${handoffStatusLabel(nextStatus)}.`,
        tone: 'success',
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Update failed.');
    } finally {
      setBusy(null);
    }
  };

  const regenerateFitReport = async () => {
    setErrorMsg(null);
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

      emitToast({
        message: 'Updated Managerial Fit Report.',
        tone: 'success',
      });
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

      <div className="software-handoff-layout">
        <aside
          className="hiring-card software-handoff-next"
          aria-labelledby="handoff-next-step"
        >
          <h2 id="handoff-next-step">Next interview</h2>
          <div className="hiring-stack-xs">
            <strong>
              {dossier.decision.nextStageLabel ?? 'Managerial Interview'}
            </strong>
            <span className="hiring-muted-copy">
              {dossier.decision.handoffRecipientName ?? 'Team manager'}
            </span>
          </div>
          <dl className="software-handoff-facts">
            <div>
              <dt>Decided by</dt>
              <dd>{dossier.decision.decidedByName}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <span className="hiring-pill hiring-pill-plum">
                  {handoffStatusLabel(dossier.decision.handoffStatus)}
                </span>
              </dd>
            </div>
          </dl>
          <div
            className="hiring-segmented-control hiring-mt-md"
            role="group"
            aria-label="Interview handoff status"
          >
            {(['pending', 'reviewed', 'completed'] as const).map(
              (statusOpt) => {
                const active = dossier.decision.handoffStatus === statusOpt;
                return (
                  <button
                    key={statusOpt}
                    type="button"
                    className={`hiring-segmented-btn${active ? ' is-active' : ''}`}
                    aria-pressed={active}
                    disabled={busy !== null}
                    onClick={() => void updateStatus(statusOpt)}
                  >
                    {handoffStatusLabel(statusOpt)}
                  </button>
                );
              },
            )}
          </div>
          <div
            className="hiring-mt-md"
            style={{
              borderTop: '1px solid var(--software-border)',
              paddingTop: '0.85rem',
            }}
          >
            <button
              type="button"
              className="hiring-btn hiring-btn-primary hiring-btn-sm"
              style={{ width: '100%' }}
              onClick={() => setShareModalOpen(true)}
            >
              <IconLink size={14} aria-hidden="true" /> Share executive dossier
            </button>
            <p
              className="hiring-muted-copy hiring-mt-xs"
              style={{ fontSize: '0.78rem' }}
            >
              Create an expiring, redacted or named brief for CTOs &amp; hiring
              panels.
            </p>
          </div>
        </aside>
        <div className="hiring-page-shell">
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
                    {dossier.candidateProfile.headlineRole ||
                      dossier.targetRole}{' '}
                    · {experienceLevelLabel(dossier.experienceLevel)}
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
            <h2>Feedback and private notes</h2>
            <div className="hiring-two-col hiring-mt-sm">
              <div className="hiring-card-subtle hiring-dossier-panel--shared">
                <div className="hiring-dossier-panel-head">
                  <span className="hiring-pill hiring-pill-mint">
                    <IconEye size={13} aria-hidden="true" /> Shared with
                    candidate
                  </span>
                </div>
                <strong>Strengths</strong>
                <ul className="hiring-bullet-list">
                  {dossier.decision.candidateStrengths.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
                <strong className="hiring-sublabel">Areas to explore</strong>
                <ul className="hiring-bullet-list">
                  {dossier.decision.candidateWeaknesses.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
                <strong className="hiring-sublabel">
                  Published candidate note
                </strong>
                <p className="hiring-prewrap hiring-mt-xs">
                  {dossier.decision.candidateFeedbackNote || '—'}
                </p>
              </div>
              <div className="hiring-card-subtle hiring-dossier-panel--private">
                <div className="hiring-dossier-panel-head">
                  <span className="hiring-pill hiring-pill-plum">
                    <IconLock size={13} aria-hidden="true" /> Private — Hiring
                    Team Only
                  </span>
                </div>
                <strong>Internal interview notes</strong>
                <p className="hiring-prewrap hiring-mt-xs">
                  {dossier.decision.internalNotes ||
                    'No internal notes recorded.'}
                </p>
              </div>
            </div>
          </section>

          {dossier.secondOpinions.length > 0 ? (
            <section className="hiring-card hiring-card-animated">
              <span className="hiring-eyebrow">Team Peer Reviews</span>
              <div className="hiring-opinion-list hiring-mt-sm">
                {dossier.secondOpinions.map((op) => {
                  const verdictPill =
                    op.status !== 'completed'
                      ? { label: 'Awaiting review', cls: 'hiring-pill-warning' }
                      : op.verdict === 'approve'
                        ? { label: 'Approved', cls: 'hiring-pill-success' }
                        : op.verdict === 'request_changes'
                          ? {
                              label: 'Concerns flagged',
                              cls: 'hiring-pill-danger',
                            }
                          : { label: 'Commented', cls: 'hiring-pill-plum' };
                  return (
                    <div key={op.id} className="hiring-opinion-card">
                      <div className="hiring-candidate-name">
                        <strong>
                          {op.requestedByName} → {op.requestedReviewerName}
                        </strong>
                        <span className={`hiring-pill ${verdictPill.cls}`}>
                          {verdictPill.label}
                        </span>
                      </div>
                      {op.requestNote ? (
                        <p className="hiring-dossier-bio hiring-mt-xs">
                          <strong>Asked:</strong> {op.requestNote}
                        </p>
                      ) : null}
                      {op.responseNote ? (
                        <blockquote className="hiring-peer-response-quote">
                          {op.responseNote}
                        </blockquote>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          <section className="hiring-card hiring-card-animated">
            <div className="hiring-preview-header">
              <div>
                <h2>Evidence for the next interview</h2>
              </div>
              {canGenerateFitReport ? (
                <button
                  type="button"
                  className="hiring-btn"
                  disabled={busy !== null}
                  onClick={() => void regenerateFitReport()}
                >
                  <IconFileAnalytics size={15} aria-hidden="true" />{' '}
                  {busy === 'regen'
                    ? 'Generating fit report…'
                    : report
                      ? 'Refresh Fit Report'
                      : 'Generate Fit Report'}
                </button>
              ) : (
                <a
                  className="hiring-btn hiring-btn-sm"
                  href={`${orgBase}/plan`}
                >
                  Upgrade to Ultra
                </a>
              )}
            </div>

            {busy === 'regen' ? (
              <div className="hiring-mt-sm">
                <HirearchyAiThinking
                  variant="advisory"
                  status="active"
                  badge="Advisory only"
                  headline="Synthesizing Managerial Fit Report…"
                  steps={[
                    {
                      id: 'evidence',
                      label: 'Correlating submission & rubric evidence…',
                    },
                    {
                      id: 'questions',
                      label: 'Drafting live verification probes…',
                    },
                  ]}
                />
              </div>
            ) : !report ? (
              <p className="hiring-muted-copy hiring-mt-sm">
                No automated Performance &amp; Fit Report has been generated for
                this handoff yet.
              </p>
            ) : (
              <div className="hiring-page-shell hiring-mt-md">
                <div className="hiring-card-subtle">
                  <span className="hiring-pill hiring-pill-plum">
                    {report.provider.mode === 'live_ai'
                      ? 'AI advisory'
                      : 'Evidence summary'}
                  </span>
                  <h3 className="hiring-mt-sm">{report.fitHeadline}</h3>
                  {report.provider.fallbackReason ? (
                    <p className="hiring-muted-copy">
                      {report.provider.fallbackReason}
                    </p>
                  ) : null}
                  <p className="hiring-dossier-bio hiring-mt-xs">
                    {report.whyGoodOrBadFit}
                  </p>
                </div>

                <div className="hiring-two-col">
                  <div className="hiring-card-subtle">
                    <strong>Observed evidence</strong>
                    <ul className="hiring-bullet-list">
                      {report.clearlyDemonstrated.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="hiring-card-subtle">
                    <strong>Not yet verified (open areas)</strong>
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
                    <div className="hiring-preview-header">
                      <strong>
                        Live verification questions (10-min defense)
                      </strong>
                      <CopyActionButton
                        value={report.suggestedNextInterviewQuestions
                          .map((q, idx) => `${idx + 1}. ${q}`)
                          .join('\n')}
                        label="Copy questions"
                        copiedLabel="Copied"
                        toastMessage="Verification questions copied."
                        size="sm"
                        variant="secondary"
                      />
                    </div>
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
      </div>
      {shareModalOpen ? (
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
              organizationId={organizationId}
              sessionId={dossier.sessionId}
              candidateLabel={dossier.candidateName}
              compact
              onClose={() => setShareModalOpen(false)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
