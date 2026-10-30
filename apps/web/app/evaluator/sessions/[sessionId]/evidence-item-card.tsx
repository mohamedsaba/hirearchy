'use client';

import { useState } from 'react';
import type { CommandFinishedPayload } from '../../../../src/events/session-event';
import type { ReconstructionItem } from '../../../../src/evidence/chronological-reconstruction';

type EvidenceItemCardProps = Readonly<{
  item: ReconstructionItem;
  elapsedLabel?: string | null;
  compact?: boolean;
  showConfiguredModel?: boolean;
  showTokenTelemetry?: boolean;
  showTechnicalDetails?: boolean;
  defaultExpanded?: boolean;
  sourceInspector?: boolean;
}>;

const EvidenceTime = ({
  elapsedLabel,
  timestamp,
}: Readonly<{ elapsedLabel?: string | null; timestamp: string }>) => (
  <time className="evidence-time" dateTime={timestamp}>
    {elapsedLabel ?? new Date(timestamp).toLocaleTimeString()}
  </time>
);

export const EvidenceItemCard = ({
  item,
  elapsedLabel,
  compact = false,
  showConfiguredModel = true,
  showTokenTelemetry = false,
  showTechnicalDetails = false,
  defaultExpanded = false,
  sourceInspector = false,
}: EvidenceItemCardProps) => {
  const [isExcerptExpanded, setIsExcerptExpanded] = useState(defaultExpanded);
  if (item.kind === 'SESSION_ACTIVATED' || item.kind === 'SESSION_SUBMITTED') {
    const submitted = item.kind === 'SESSION_SUBMITTED';
    return (
      <article className="activity-card activity-boundary-card">
        <div>
          <p className="activity-label">
            {submitted ? 'Session submitted' : 'Session started'}
          </p>
          <p className="activity-copy">
            {submitted
              ? 'The submitted workspace state was frozen for evaluator review.'
              : 'The candidate workspace became available.'}
          </p>
        </div>
        <EvidenceTime elapsedLabel={elapsedLabel} timestamp={item.timestamp} />
      </article>
    );
  }

  if (item.kind === 'COMMAND_EXECUTION') {
    const output = item.rawFinishedEvent.payload as CommandFinishedPayload;
    const result = item.timedOut
      ? 'Timed out'
      : item.exitCode === null
        ? 'No recorded exit status'
        : `Exit status ${item.exitCode}`;
    return (
      <article className="activity-card command-activity-card">
        {!sourceInspector ? (
          <>
            <header className="activity-card-header">
              <div>
                <p className="activity-label">Terminal activity</p>
                <code className="activity-command">$ {item.command}</code>
              </div>
              <EvidenceTime
                elapsedLabel={elapsedLabel}
                timestamp={item.finishedAt}
              />
            </header>
            <div className="activity-result" aria-label={`Command ${result}`}>
              <span>{result}</span>
              <span>{item.durationMs} ms</span>
              <span>{item.cwd}</span>
            </div>
          </>
        ) : null}
        {output.stdoutTruncated ? (
          <p className="activity-limitation">
            Standard output is a captured preview. Additional output was
            omitted.
          </p>
        ) : null}
        {output.stderrTruncated ? (
          <p className="activity-limitation">
            Standard error is a captured preview. Additional output was omitted.
          </p>
        ) : null}
        {!compact && item.stdoutPreview ? (
          <div className="activity-output">
            <p>Standard output</p>
            <pre tabIndex={0} aria-label="Recorded standard output">
              {item.stdoutPreview}
            </pre>
          </div>
        ) : null}
        {!compact && item.stderrPreview ? (
          <div className="activity-output">
            <p>Standard error</p>
            <pre tabIndex={0} aria-label="Recorded standard error">
              {item.stderrPreview}
            </pre>
          </div>
        ) : null}
      </article>
    );
  }

  if (item.kind === 'WORKSPACE_CHANGE') {
    const origin =
      item.origin === 'browser_save'
        ? 'Recorded after an editor save'
        : item.origin === 'command_execution'
          ? 'Recorded across terminal activity'
          : 'Recorded between captured actions';
    return (
      <article className="activity-card workspace-activity-card">
        <header className="activity-card-header">
          <div>
            <p className="activity-label">Workspace change</p>
            <p className="activity-copy">{origin}</p>
          </div>
          <EvidenceTime
            elapsedLabel={elapsedLabel}
            timestamp={item.timestamp}
          />
        </header>
        <div className="activity-file-list">
          {item.files.map((file) => (
            <section className="activity-file" key={file.path}>
              <header>
                <code>{file.path}</code>
                <span
                  aria-label={`${file.additions} additions and ${file.deletions} deletions`}
                >
                  <span className="diff-addition-count">+{file.additions}</span>{' '}
                  <span className="diff-deletion-count">−{file.deletions}</span>
                </span>
              </header>
              {file.patchTruncated ? (
                <p className="activity-limitation">
                  The displayed patch is partial. {file.patchPreviewBytes} of{' '}
                  {file.patchBytes} bytes are shown.
                </p>
              ) : null}
              {!compact && file.patchPreview ? (
                <pre
                  className="activity-patch"
                  tabIndex={0}
                  aria-label={`Recorded patch for ${file.path}`}
                >
                  {file.patchPreview}
                </pre>
              ) : null}
            </section>
          ))}
        </div>
      </article>
    );
  }

  if (item.kind === 'WORKSPACE_GAP') {
    return (
      <article className="activity-card capture-limitation-card">
        <header className="activity-card-header">
          <div>
            <p className="activity-label">Activity capture incomplete</p>
            <p className="activity-copy">
              Hirearchy Software could not establish every intermediate
              workspace change during this interval. Other recorded activity
              remains available.
            </p>
          </div>
          <EvidenceTime
            elapsedLabel={elapsedLabel}
            timestamp={item.timestamp}
          />
        </header>
      </article>
    );
  }

  if (item.kind === 'AI_REQUEST_STARTED') {
    const isTruncated =
      item.candidateInputBytes >
      Buffer.byteLength(item.candidateInputExcerpt, 'utf8');

    return (
      <article className="activity-card ai-request-card">
        <header className="activity-card-header">
          <div>
            <p className="activity-label">AI request</p>
            {showConfiguredModel && item.configuredModelId ? (
              <p className="activity-copy">
                Model:{' '}
                <code className="code-inline">{item.configuredModelId}</code>
              </p>
            ) : (
              <p className="activity-copy">An AI request was recorded.</p>
            )}
          </div>
          <EvidenceTime
            elapsedLabel={elapsedLabel}
            timestamp={item.timestamp}
          />
        </header>

        <div className="activity-meta-line">
          <span>{item.candidateInputBytes.toLocaleString()} bytes</span>
          {item.contextAttachmentsCount > 0 ? (
            <span>
              {item.contextAttachmentsCount} context attachment
              {item.contextAttachmentsCount === 1 ? '' : 's'} included
            </span>
          ) : null}
        </div>

        <button
          type="button"
          className="evidence-toggle-button excerpt-toggle-button"
          aria-expanded={isExcerptExpanded}
          aria-controls={`ai-prompt-excerpt-${item.rawEventId}`}
          onClick={() => setIsExcerptExpanded((prev) => !prev)}
        >
          <span>
            {isExcerptExpanded ? 'Hide prompt excerpt' : 'View prompt excerpt'}
          </span>
          <span className="disclosure-chevron" aria-hidden="true">
            {isExcerptExpanded ? '▾' : '›'}
          </span>
        </button>

        {isExcerptExpanded ? (
          <div
            id={`ai-prompt-excerpt-${item.rawEventId}`}
            className="activity-section-block"
          >
            <p className="activity-sublabel">Recorded prompt input</p>
            <pre
              className="activity-excerpt"
              tabIndex={0}
              aria-label="Recorded AI prompt excerpt"
            >
              {item.candidateInputExcerpt}
            </pre>
            {isTruncated ? (
              <p className="activity-limitation">
                Displayed prompt excerpt is partial (
                {Buffer.byteLength(
                  item.candidateInputExcerpt,
                  'utf8',
                ).toLocaleString()}{' '}
                of {item.candidateInputBytes.toLocaleString()} bytes shown).
              </p>
            ) : null}
          </div>
        ) : null}

        {showTechnicalDetails ? (
          <div className="activity-technical-metadata">
            <span>Provider: {item.configuredProviderId}</span>
            <span>Sequence: #{item.sequence}</span>
            <span>Event ID: {item.rawEventId}</span>
          </div>
        ) : null}
      </article>
    );
  }

  if (item.kind === 'AI_RESPONSE_COMPLETED') {
    const isTruncated =
      item.responseBytes > Buffer.byteLength(item.responseExcerpt, 'utf8');

    return (
      <article className="activity-card ai-response-card">
        <header className="activity-card-header">
          <div>
            <p className="activity-label">AI response</p>
            {showConfiguredModel && item.reportedModelId ? (
              <p className="activity-copy">
                Model:{' '}
                <code className="code-inline">{item.reportedModelId}</code>
              </p>
            ) : (
              <p className="activity-copy">An AI response was recorded.</p>
            )}
          </div>
          <EvidenceTime
            elapsedLabel={elapsedLabel}
            timestamp={item.timestamp}
          />
        </header>

        <div className="activity-meta-line">
          <span>{item.responseBytes.toLocaleString()} bytes</span>
          <span>Duration: {(item.durationMs / 1000).toFixed(1)}s</span>
        </div>

        <button
          type="button"
          className="evidence-toggle-button excerpt-toggle-button"
          aria-expanded={isExcerptExpanded}
          aria-controls={`ai-response-excerpt-${item.rawEventId}`}
          onClick={() => setIsExcerptExpanded((prev) => !prev)}
        >
          <span>
            {isExcerptExpanded
              ? 'Hide response excerpt'
              : 'View response excerpt'}
          </span>
          <span className="disclosure-chevron" aria-hidden="true">
            {isExcerptExpanded ? '▾' : '›'}
          </span>
        </button>

        {isExcerptExpanded ? (
          <div
            id={`ai-response-excerpt-${item.rawEventId}`}
            className="activity-section-block"
          >
            <p className="activity-sublabel">Recorded provider response</p>
            <pre
              className="activity-excerpt"
              tabIndex={0}
              aria-label="Recorded AI response excerpt"
            >
              {item.responseExcerpt}
            </pre>
            {isTruncated ? (
              <p className="activity-limitation">
                Displayed response excerpt is partial (
                {Buffer.byteLength(
                  item.responseExcerpt,
                  'utf8',
                ).toLocaleString()}{' '}
                of {item.responseBytes.toLocaleString()} bytes shown).
              </p>
            ) : null}
          </div>
        ) : null}

        {showTokenTelemetry && item.tokenUsage ? (
          <div className="activity-token-telemetry">
            <span className="telemetry-label">Token usage:</span>
            <span>
              {item.tokenUsage.totalTokens?.toLocaleString() ?? '—'} total (
              {item.tokenUsage.promptTokens?.toLocaleString() ?? '—'} prompt ·{' '}
              {item.tokenUsage.completionTokens?.toLocaleString() ?? '—'}{' '}
              completion)
            </span>
          </div>
        ) : null}

        {showTechnicalDetails ? (
          <div className="activity-technical-metadata">
            <span>Duration: {item.durationMs} ms</span>
            <span>Sequence: #{item.sequence}</span>
            <span>Event ID: {item.rawEventId}</span>
          </div>
        ) : null}
      </article>
    );
  }

  if (item.kind === 'AI_REQUEST_CANCELLED') {
    const isCandidate = item.cancelReason === 'candidate_requested_cancel';
    const isSessionEnded = item.cancelReason === 'session_ended';
    const reasonText = isCandidate
      ? 'Candidate requested cancellation of the AI request.'
      : isSessionEnded
        ? 'An AI request was cancelled when the session ended.'
        : 'An AI request was cancelled.';

    return (
      <article className="activity-card ai-cancellation-card">
        <header className="activity-card-header">
          <div>
            <p className="activity-label">AI cancellation</p>
            <p className="activity-copy">{reasonText}</p>
          </div>
          <EvidenceTime
            elapsedLabel={elapsedLabel}
            timestamp={item.timestamp}
          />
        </header>
        <div className="activity-meta-line">
          <span>
            Elapsed before cancellation: {(item.durationMs / 1000).toFixed(1)}s
          </span>
        </div>
        {showTechnicalDetails ? (
          <div className="activity-technical-metadata">
            <span>Reason: {item.cancelReason}</span>
            <span>Duration: {item.durationMs} ms</span>
            <span>Sequence: #{item.sequence}</span>
            <span>Event ID: {item.rawEventId}</span>
          </div>
        ) : null}
      </article>
    );
  }

  if (item.kind === 'AI_REQUEST_FAILED') {
    const isProvider =
      item.failureReason === 'provider_error' ||
      item.failureReason === 'provider_disconnected';
    const isTimeout =
      item.failureReason === 'timeout' ||
      item.failureReason === 'server_timeout';

    const attributionNotice = isProvider
      ? 'An external AI provider error was recorded during this session.'
      : isTimeout
        ? 'The AI request timed out at the provider boundary.'
        : 'An error occurred during AI request execution.';

    return (
      <article className="activity-card ai-failure-card">
        <header className="activity-card-header">
          <div>
            <p className="activity-label">
              {isProvider
                ? 'AI provider error'
                : isTimeout
                  ? 'AI timeout'
                  : 'AI error'}
            </p>
            <p className="activity-copy">{attributionNotice}</p>
          </div>
          <EvidenceTime
            elapsedLabel={elapsedLabel}
            timestamp={item.timestamp}
          />
        </header>

        {item.errorMessageExcerpt ? (
          <div className="activity-section-block">
            <p className="activity-sublabel">Recorded error detail</p>
            <pre
              className="activity-excerpt error-excerpt"
              tabIndex={0}
              aria-label="Recorded AI error detail"
            >
              {item.errorMessageExcerpt}
            </pre>
          </div>
        ) : null}

        <div className="activity-meta-line">
          <span>
            Elapsed before failure: {(item.durationMs / 1000).toFixed(1)}s
          </span>
        </div>

        {showTechnicalDetails ? (
          <div className="activity-technical-metadata">
            <span>Failure reason: {item.failureReason}</span>
            <span>Duration: {item.durationMs} ms</span>
            <span>Sequence: #{item.sequence}</span>
            <span>Event ID: {item.rawEventId}</span>
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <article className="activity-card platform-notice-card">
      <header className="activity-card-header">
        <div>
          <p className="activity-label">Platform cleanup notice</p>
          <p className="activity-copy">
            The submitted evidence was frozen before sandbox cleanup reported a
            platform error.
          </p>
        </div>
        <EvidenceTime elapsedLabel={elapsedLabel} timestamp={item.timestamp} />
      </header>
    </article>
  );
};
