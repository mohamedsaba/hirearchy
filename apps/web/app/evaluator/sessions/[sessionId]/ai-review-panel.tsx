'use client';

import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconCopy, IconRefresh } from '@tabler/icons-react';

import type { R27Evidence } from '../../../../../../database/postgres/r27/contract.mjs';
import {
  AI_REVIEW_MODEL_CATALOG,
  buildDeterministicEvidencePreviewReport,
  type AiReviewPresetId,
  type R27AiReviewReport,
} from '../../../../src/r27-evidence/ai-review-contract';
import { CommonThreadLoader } from '../../../_components/common-thread-loader';
import { CommonThreadToast } from '../../../_components/common-thread-toast';

export type R27AiReviewPanelProps = Readonly<{
  organizationId?: string;
  sessionId: string;
  evidence: R27Evidence;
  report?: R27AiReviewReport | null;
  onReportChange?: (report: R27AiReviewReport | null) => void;
  onLoadingChange?: (loading: boolean) => void;
  defaultPreset?: AiReviewPresetId;
  planLocked?: boolean;
  hiring?: boolean;
  planSettingsHref?: string;
}>;

function readCsrfCookie(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)__Host-r23-csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

export const R27AiReviewPanel = ({
  organizationId,
  sessionId,
  evidence,
  report: controlledReport,
  onReportChange,
  onLoadingChange,
  defaultPreset = 'nvidia:kimi-k2',
  planLocked = false,
  hiring = false,
  planSettingsHref,
}: R27AiReviewPanelProps) => {
  const [internalReport, setInternalReport] =
    useState<R27AiReviewReport | null>(null);
  const report =
    controlledReport !== undefined ? controlledReport : internalReport;
  const evidenceSummary =
    hiring && report?.provider.mode === 'evidence_preview';
  const reportHeading = useRef<HTMLHeadingElement>(null);
  const shouldFocusReport = useRef(false);
  const setReport = (next: R27AiReviewReport) => {
    shouldFocusReport.current = true;
    setInternalReport(next);
    onReportChange?.(next);
  };

  useEffect(() => {
    if (report && shouldFocusReport.current) {
      shouldFocusReport.current = false;
      reportHeading.current?.focus();
    }
  }, [report]);

  const [selectedPreset, setSelectedPreset] =
    useState<AiReviewPresetId>(defaultPreset);
  const [customModelId, setCustomModelId] = useState<string>('');
  const [loading, setLoadingState] = useState<boolean>(false);
  const setLoading = (next: boolean) => {
    setLoadingState(next);
    onLoadingChange?.(next);
  };
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [questionsCopied, setQuestionsCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCopyQuestions = async () => {
    const items = report?.verificationQuestions ?? [];
    if (!items.length) return;
    const text = items
      .map((item, idx) => `${idx + 1}. ${item.question} (${item.focus})`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setQuestionsCopied(true);
      setToastMsg('Verification questions copied.');
      window.setTimeout(() => setQuestionsCopied(false), 2000);
    } catch {
      setError('Copy failed — copy manually from this browser.');
    }
  };

  const selectedOption =
    AI_REVIEW_MODEL_CATALOG.find((item) => item.id === selectedPreset) ??
    AI_REVIEW_MODEL_CATALOG[0];

  const handleGenerate = async (forcePreview = false) => {
    setError(null);
    if (forcePreview || !organizationId) {
      setReport(
        buildDeterministicEvidencePreviewReport(evidence, {
          modelId: forcePreview
            ? 'hirearchy-evidence-preview-v1'
            : selectedOption.modelId,
          label: 'Evidence-Grounded Preview (Offline Ready)',
        }),
      );
      setToastMsg('Evidence summary ready.');
      return;
    }

    try {
      setLoading(true);
      const csrf = readCsrfCookie();
      const response = await fetch(
        `/r27/api/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sessionId)}/ai-review`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(csrf ? { 'x-csrf-token': csrf } : {}),
          },
          body: JSON.stringify({
            preset: selectedPreset,
            ...(customModelId.trim()
              ? { customModelId: customModelId.trim() }
              : {}),
            ...(forcePreview ? { forcePreview: true } : {}),
            ...(csrf ? { csrf } : {}),
          }),
        },
      );

      if (!response.ok) {
        const errPayload = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        if (response.status === 402) {
          throw new Error(
            errPayload?.error?.message ??
              'AI Candidate Review requires the Ultra plan. Upgrade in Team & Plan.',
          );
        }
        throw new Error(
          errPayload?.error?.message ??
            `Unable to generate AI review (HTTP ${response.status})`,
        );
      }

      const data = (await response.json()) as { report?: R27AiReviewReport };
      if (!data.report) {
        throw new Error('AI review endpoint returned no report payload.');
      }
      setReport(data.report);
      setToastMsg('Advisory AI review ready.');
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Unable to generate AI review.',
      );
    } finally {
      setLoading(false);
    }
  };

  if (hiring && planLocked && !report) {
    return (
      <p className="review-desk-advisory-note">
        AI advisory ·{' '}
        {planSettingsHref ? (
          <a href={planSettingsHref}>Available on Ultra</a>
        ) : (
          'Available on Ultra'
        )}
      </p>
    );
  }

  return (
    <details
      className="r27-ai-review-card"
      data-testid="r27-ai-review-panel"
      open={Boolean(report)}
    >
      <summary>
        <span>{hiring ? 'AI advisory' : 'AI Candidate Review'}</span>
        {loading ? (
          <span className="evaluator-tab-weaving-dot" aria-label="Analyzing" />
        ) : null}
      </summary>
      {loading && !report ? (
        <div style={{ padding: '1rem 0' }}>
          <CommonThreadLoader
            stages={[
              'Reading workspace diffs…',
              'Cross-referencing test runs…',
              'Drafting advisory summary…',
            ]}
          />
        </div>
      ) : null}
      {!report && !loading ? (
        <div className="r27-ai-review-launcher">
          <p className="evaluator-muted-copy">
            {hiring
              ? 'Advisory summary from diffs and test runs — final decisions belong to you.'
              : 'Generate an advisory report from the submitted work and recorded evidence. The evaluator owns the final review.'}
          </p>

          {hiring ? null : (
            <div className="r27-ai-review-controls">
              <label className="r27-ai-review-field">
                <span>AI model preset</span>
                <select
                  aria-label="AI review model"
                  value={selectedPreset}
                  onChange={(event) =>
                    setSelectedPreset(event.target.value as AiReviewPresetId)
                  }
                  disabled={loading}
                >
                  {AI_REVIEW_MODEL_CATALOG.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              {selectedOption.providerId !== 'preview' ? (
                <label className="r27-ai-review-field">
                  <span>Custom model slug (optional)</span>
                  <input
                    type="text"
                    aria-label="Custom model slug"
                    placeholder={selectedOption.modelId}
                    value={customModelId}
                    onChange={(event) => setCustomModelId(event.target.value)}
                    disabled={loading}
                  />
                </label>
              ) : null}
            </div>
          )}

          {planLocked ? (
            <div className="hiring-banner hiring-banner-warning" role="status">
              <div>
                <strong>AI Candidate Review is available on Ultra.</strong>
              </div>
              {planSettingsHref ? (
                <a className="hiring-btn hiring-btn-sm" href={planSettingsHref}>
                  Upgrade to Ultra
                </a>
              ) : null}
            </div>
          ) : null}

          <div className="r27-ai-review-actions">
            <button
              type="button"
              className="r27-ai-review-primary-btn"
              onClick={() => void handleGenerate(false)}
              disabled={loading || planLocked}
            >
              {loading ? 'Analyzing candidate evidence…' : 'Generate AI Review'}
            </button>
            <button
              type="button"
              className="r27-ai-review-secondary-btn"
              onClick={() => void handleGenerate(true)}
              disabled={loading || planLocked}
            >
              {hiring ? 'Show evidence summary' : 'Instant Preview'}
            </button>
          </div>
        </div>
      ) : report ? (
        <div
          className="r27-ai-review-report"
          data-testid="r27-ai-review-report"
        >
          <h3
            className="r27-ai-review-headline"
            ref={reportHeading}
            tabIndex={-1}
          >
            {evidenceSummary ? 'Recorded evidence summary' : report.headline}
          </h3>
          <p className="r27-ai-review-context">
            {hiring && report.provider.mode === 'live_ai'
              ? 'AI advisory'
              : report.provider.label}
          </p>
          {evidenceSummary ? null : (
            <>
              <div className="r27-ai-review-result">
                <span>
                  AI rating{' '}
                  <strong data-testid="r27-ai-review-score">
                    {report.score}
                  </strong>{' '}
                  / 100
                </span>
                <span data-testid="r27-ai-review-verdict">
                  {report.verdictLabel}
                </span>
                <span>{report.confidenceLabel}</span>
              </div>
              <p className="r27-ai-review-rationale">{report.rationale}</p>
            </>
          )}

          {report.provider.fallbackReason ? (
            <p className="r27-ai-review-fallback-note" role="status">
              {report.provider.fallbackReason}
            </p>
          ) : null}

          <dl className="r27-ai-review-metrics">
            <div>
              <dt>Modified files</dt>
              <dd>
                {report.metrics.modifiedFilesCount} /{' '}
                {report.metrics.submittedFilesCount}
              </dd>
            </div>
            <div>
              <dt>Net code diff</dt>
              <dd>
                +{report.metrics.linesAdded} / -{report.metrics.linesRemoved}
              </dd>
            </div>
            <div>
              <dt>Save checkpoints</dt>
              <dd>{report.metrics.saveEventsCount}</dd>
            </div>
            <div>
              <dt>Recorded events</dt>
              <dd>{report.metrics.timelineEventsCount}</dd>
            </div>
          </dl>

          {evidenceSummary ? null : (
            <div className="r27-ai-review-columns">
              <div className="r27-ai-review-list-card">
                <h4>Observed Strengths</h4>
                <ul>
                  {report.strengths.map((item, index) => (
                    <li key={`${index}:${item}`}>{item}</li>
                  ))}
                </ul>
              </div>

              <div className="r27-ai-review-list-card">
                <h4>Weaknesses &amp; Verification Risks</h4>
                <ul>
                  {report.weaknesses.map((item, index) => (
                    <li key={`${index}:${item}`}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {report.timingInsights && report.timingInsights.length > 0 ? (
            <div className="hiring-card-subtle">
              <h4>Chronological Timing &amp; Workflow Analysis</h4>
              <ul className="hiring-timing-list">
                {report.timingInsights.map((insight, index) => (
                  <li
                    key={`${index}:${insight}`}
                    className="hiring-timing-item"
                  >
                    {insight}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {report.requirementBreakdown &&
          report.requirementBreakdown.length > 0 ? (
            <div className="hiring-card-subtle">
              <h4>Requirement Evidence Breakdown</h4>
              <ul className="hiring-timing-list">
                {report.requirementBreakdown.map((item, index) => (
                  <li
                    key={`${index}:${item.requirement}`}
                    className="hiring-timing-item"
                  >
                    <strong>{item.requirement}</strong> ·{' '}
                    <span className="hiring-pill">{item.status}</span> —{' '}
                    {item.evidence}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {report.verificationQuestions &&
          report.verificationQuestions.length > 0 ? (
            <div
              className="hiring-card-subtle"
              data-testid="r27-ai-verification-questions"
            >
              <div className="hiring-preview-header">
                <h4>Live verification questions (10-min defense)</h4>
                <button
                  type="button"
                  className="r27-ai-review-secondary-btn"
                  onClick={() => void handleCopyQuestions()}
                >
                  {questionsCopied ? (
                    <IconCheck size={14} aria-hidden="true" />
                  ) : (
                    <IconCopy size={14} aria-hidden="true" />
                  )}
                  {questionsCopied ? 'Copied' : 'Copy questions'}
                </button>
              </div>
              <ol className="hiring-ol-list">
                {report.verificationQuestions.map((item, index) => (
                  <li key={`${index}:${item.question}`}>
                    <span>{item.question}</span>{' '}
                    <span className="evaluator-muted-copy">({item.focus})</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          <div className="r27-ai-review-footer">
            <div className="r27-ai-review-footer-controls">
              {hiring ? null : (
                <select
                  aria-label="Switch AI review model"
                  value={selectedPreset}
                  onChange={(event) =>
                    setSelectedPreset(event.target.value as AiReviewPresetId)
                  }
                  disabled={loading}
                >
                  {AI_REVIEW_MODEL_CATALOG.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="r27-ai-review-secondary-btn"
                onClick={() => void handleGenerate(false)}
                disabled={loading}
              >
                <IconRefresh size={15} aria-hidden="true" />
                {loading ? 'Refreshing…' : 'Regenerate'}
              </button>
            </div>
            <p className="r27-ai-review-disclaimer">
              Advisory only — hiring decisions belong to you.
            </p>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="r27-ai-review-error" role="alert">
          {error}
        </p>
      ) : null}
      <CommonThreadToast
        message={toastMsg}
        tone="success"
        onDismiss={() => setToastMsg(null)}
      />
    </details>
  );
};
