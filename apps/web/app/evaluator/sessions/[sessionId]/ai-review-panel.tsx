'use client';

import { useState } from 'react';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCheck,
  IconCircleCheck,
  IconRefresh,
  IconSparkles,
} from '@tabler/icons-react';

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
  compact?: boolean;
}>;

function readCsrfCookie(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)__Host-r23-csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function scoreToneClass(report: R27AiReviewReport): string {
  if (report.verdict === 'accept' && report.score >= 75) return 'is-accept';
  if (report.score >= 55) return 'is-borderline';
  return 'is-reject';
}

export const R27AiReviewPanel = ({
  organizationId,
  sessionId,
  evidence,
  report: controlledReport,
  onReportChange,
  defaultPreset = 'nvidia:kimi-k2',
  compact = false,
}: R27AiReviewPanelProps) => {
  const [internalReport, setInternalReport] =
    useState<R27AiReviewReport | null>(null);
  const report =
    controlledReport !== undefined ? controlledReport : internalReport;
  const setReport = (next: R27AiReviewReport | null) => {
    setInternalReport(next);
    onReportChange?.(next);
  };

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
    <section
      className={`evaluator-review-card r27-ai-review-card${compact ? ' is-compact' : ''}`}
      aria-labelledby="r27-ai-review-heading"
      data-testid="r27-ai-review-panel"
    >
      <header className="r27-ai-review-header">
        <div className="r27-ai-review-title-group">
          <span className="evaluator-review-title-icon" aria-hidden="true">
            <IconSparkles size={20} stroke={1.8} />
          </span>
          <div>
            <p className="section-kicker">Hirearchy Platform Assistant</p>
            <h2 id="r27-ai-review-heading">AI Candidate Review</h2>
          </div>
        </div>
        {report ? (
          <span
            className={`r27-ai-review-mode-pill ${report.provider.mode === 'live_ai' ? 'is-live' : 'is-preview'}`}
          >
            {report.provider.label}
          </span>
        ) : (
          <span className="r27-ai-review-mode-pill is-idle">
            NVIDIA NIM &amp; OpenRouter Ready
          </span>
        )}
      </header>

      {!report ? (
        <div className="r27-ai-review-launcher">
          <p className="evaluator-muted-copy">
            Synthesize submitted diffs, saved workspace milestones, and recorded
            verification receipts into an AI review report with a 0–100 rating,
            accept/reject recommendation, strengths, and risks.
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
              <IconSparkles size={16} aria-hidden="true" />
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
          <div className="r27-ai-review-hero">
            <div
              className={`r27-ai-review-score-ring ${scoreToneClass(report)}`}
              aria-label={`AI rating ${report.score} out of 100`}
            >
              <strong data-testid="r27-ai-review-score">{report.score}</strong>
              <span>/ 100</span>
            </div>

            <div className="r27-ai-review-verdict-block">
              <div className="r27-ai-review-badges">
                <span
                  className={`r27-ai-review-verdict-pill ${report.verdict === 'accept' ? 'is-accept' : 'is-reject'}`}
                  data-testid="r27-ai-review-verdict"
                >
                  {report.verdict === 'accept' ? (
                    <IconCircleCheck size={16} aria-hidden="true" />
                  ) : (
                    <IconAlertTriangle size={16} aria-hidden="true" />
                  )}
                  {report.verdictLabel}
                </span>
                <span className="r27-ai-review-confidence">
                  {report.confidenceLabel}
                </span>
              </div>
              <h3 className="r27-ai-review-headline">{report.headline}</h3>
              <p className="r27-ai-review-rationale">{report.rationale}</p>
            </div>
          </div>

          {report.provider.fallbackReason ? (
            <p className="r27-ai-review-fallback-note" role="status">
              {report.provider.fallbackReason} Add an active key in{' '}
              <code>.env</code> (<code>NVIDIA_API_KEY</code> or{' '}
              <code>OPENROUTER_KEY</code>) to switch seamlessly to live model
              inference.
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
            <div className="r27-ai-review-list-card is-strengths">
              <h4>
                <IconCheck size={16} aria-hidden="true" />
                Observed Strengths
              </h4>
              <ul>
                {report.strengths.map((item, index) => (
                  <li key={`${index}:${item}`}>{item}</li>
                ))}
              </ul>
            </div>

            <div className="r27-ai-review-list-card is-weaknesses">
              <h4>
                <IconAlertCircle size={16} aria-hidden="true" />
                Weaknesses &amp; Verification Risks
              </h4>
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
    </section>
  );
};
