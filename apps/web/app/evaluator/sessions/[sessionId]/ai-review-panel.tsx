'use client';

import { useEffect, useRef, useState } from 'react';
import { IconRefresh } from '@tabler/icons-react';

import type { R27Evidence } from '../../../../../../database/postgres/r27/contract.mjs';
import {
  AI_REVIEW_MODEL_CATALOG,
  buildDeterministicEvidencePreviewReport,
  type AiReviewPresetId,
  type R27AiReviewReport,
} from '../../../../src/r27-evidence/ai-review-contract';

export type R27AiReviewPanelProps = Readonly<{
  organizationId?: string;
  sessionId: string;
  evidence: R27Evidence;
  report?: R27AiReviewReport | null;
  onReportChange?: (report: R27AiReviewReport | null) => void;
  defaultPreset?: AiReviewPresetId;
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
  defaultPreset = 'nvidia:kimi-k2',
}: R27AiReviewPanelProps) => {
  const [internalReport, setInternalReport] =
    useState<R27AiReviewReport | null>(null);
  const report =
    controlledReport !== undefined ? controlledReport : internalReport;
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
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

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
          error?: { message?: string };
        } | null;
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
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Unable to generate AI review.',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <details
      className="r27-ai-review-card"
      data-testid="r27-ai-review-panel"
      open={Boolean(report)}
    >
      <summary>AI Candidate Review</summary>
      {!report ? (
        <div className="r27-ai-review-launcher">
          <p className="evaluator-muted-copy">
            Generate an advisory report from the submitted work and recorded
            evidence. The evaluator owns the final review.
          </p>

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

          <div className="r27-ai-review-actions">
            <button
              type="button"
              className="r27-ai-review-primary-btn"
              onClick={() => void handleGenerate(false)}
              disabled={loading}
            >
              {loading ? 'Analyzing candidate evidence…' : 'Generate AI Review'}
            </button>
            <button
              type="button"
              className="r27-ai-review-secondary-btn"
              onClick={() => void handleGenerate(true)}
              disabled={loading}
            >
              Instant Preview
            </button>
          </div>
        </div>
      ) : (
        <div
          className="r27-ai-review-report"
          data-testid="r27-ai-review-report"
        >
          <h3
            className="r27-ai-review-headline"
            ref={reportHeading}
            tabIndex={-1}
          >
            {report.headline}
          </h3>
          <p className="r27-ai-review-context">{report.provider.label}</p>
          <div className="r27-ai-review-result">
            <span>
              AI rating{' '}
              <strong data-testid="r27-ai-review-score">{report.score}</strong>{' '}
              / 100
            </span>
            <span data-testid="r27-ai-review-verdict">
              {report.verdictLabel}
            </span>
            <span>{report.confidenceLabel}</span>
          </div>
          <p className="r27-ai-review-rationale">{report.rationale}</p>

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

          <div className="r27-ai-review-footer">
            <div className="r27-ai-review-footer-controls">
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
              Advisory summary only. Human evaluators remain authoritative over
              final review packets.
            </p>
          </div>
        </div>
      )}

      {error ? (
        <p className="r27-ai-review-error" role="alert">
          {error}
        </p>
      ) : null}
    </details>
  );
};
