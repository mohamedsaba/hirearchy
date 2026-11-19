import type { R27Evidence } from '../../../../database/postgres/r27/contract.mjs';
import { buildR27Presentation } from './presentation';

export type R27AiReviewVerdict = 'accept' | 'reject';

export type AiReviewPresetId =
  | 'nvidia:kimi-k2'
  | 'nvidia:nemotron'
  | 'nvidia:qwen3'
  | 'openrouter:gemini-flash'
  | 'openrouter:claude-sonnet'
  | 'preview:evidence-engine';

export interface AiReviewModelOption {
  readonly id: AiReviewPresetId;
  readonly providerId: 'nvidia' | 'openrouter' | 'preview';
  readonly modelId: string;
  readonly label: string;
  readonly description: string;
}

export const AI_REVIEW_MODEL_CATALOG: readonly AiReviewModelOption[] = [
  {
    id: 'nvidia:kimi-k2',
    providerId: 'nvidia',
    modelId: 'moonshotai/kimi-k3.1-pro',
    label: 'NVIDIA NIM · Kimi K3.1 Pro',
    description:
      'High-reasoning Staff Engineer reviewer on NVIDIA NIM (moonshotai/kimi-k3.1-pro).',
  },
  {
    id: 'nvidia:nemotron',
    providerId: 'nvidia',
    modelId: 'nvidia/nemotron-3-super-120b-a12b',
    label: 'NVIDIA NIM · Nemotron Super 120B',
    description: 'NVIDIA Nemotron Super 120B reasoning model via NVIDIA NIM.',
  },
  {
    id: 'nvidia:qwen3',
    providerId: 'nvidia',
    modelId: 'qwen/qwen3-235b-a22b',
    label: 'NVIDIA NIM · Qwen 3 235B',
    description: 'Large coding and debugging specialist on NVIDIA NIM.',
  },
  {
    id: 'openrouter:gemini-flash',
    providerId: 'openrouter',
    modelId: 'google/gemini-2.5-flash',
    label: 'OpenRouter · Gemini 2.5 Flash',
    description: 'Fast evidence synthesis via OpenRouter.',
  },
  {
    id: 'openrouter:claude-sonnet',
    providerId: 'openrouter',
    modelId: 'anthropic/claude-3.7-sonnet',
    label: 'OpenRouter · Claude 3.7 Sonnet',
    description: 'Deep code review analysis via OpenRouter.',
  },
  {
    id: 'preview:evidence-engine',
    providerId: 'preview',
    modelId: 'hirearchy-evidence-preview-v1',
    label: 'Evidence-Grounded Preview (Offline Ready)',
    description:
      'Deterministic preview generated directly from submitted code diffs, saves, and timeline evidence without external API calls.',
  },
] as const;

export interface R27AiReviewReport {
  sessionId: string;
  organizationId: string;
  score: number;
  verdict: R27AiReviewVerdict;
  verdictLabel: 'Should Accept' | 'Should Reject';
  confidenceLabel: 'High Confidence' | 'Moderate Confidence' | 'Low Confidence';
  headline: string;
  rationale: string;
  strengths: string[];
  weaknesses: string[];
  evidenceHighlights: Array<{
    label: string;
    detail: string;
  }>;
  timingInsights?: string[];
  requirementBreakdown?: Array<{
    requirement: string;
    status: 'met' | 'partial' | 'not_observed';
    evidence: string;
  }>;
  metrics: {
    submittedFilesCount: number;
    modifiedFilesCount: number;
    linesAdded: number;
    linesRemoved: number;
    timelineEventsCount: number;
    saveEventsCount: number;
  };
  provider: {
    providerId: 'nvidia' | 'openrouter' | 'preview';
    modelId: string;
    label: string;
    mode: 'live_ai' | 'evidence_preview';
    fallbackReason?: string;
  };
  generatedAt: string;
}

export interface ComputedEvidenceFileDiff {
  readonly path: string;
  readonly changed: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly diff: string | null;
  readonly isTestFile: boolean;
}

export interface ComputedEvidenceSummary {
  readonly submittedFilesCount: number;
  readonly modifiedFilesCount: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly timelineEventsCount: number;
  readonly saveEventsCount: number;
  readonly executionRunsCount: number;
  readonly passedExecutionRunsCount: number;
  readonly failedExecutionRunsCount: number;
  readonly aiInteractionsCount: number;
  readonly elapsedMinutes: number | null;
  readonly modifiedTestFilesCount: number;
  readonly modifiedSourceFilesCount: number;
  readonly files: readonly ComputedEvidenceFileDiff[];
  readonly brief: string | null;
  readonly acceptanceCriteria: readonly string[];
}

function countDiffLines(diff: string | null): {
  additions: number;
  deletions: number;
} {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

export function computeEvidenceMetricsAndDiffSummary(
  evidence: R27Evidence,
): ComputedEvidenceSummary {
  const presentation = buildR27Presentation(evidence);
  const files: ComputedEvidenceFileDiff[] = presentation.files.map((file) => {
    const { additions, deletions } = countDiffLines(file.diff);
    const changed =
      file.starterContent !== file.submittedContent ||
      additions > 0 ||
      deletions > 0;
    const isTestFile = /(^|\/)(test_.*|.*_test\.[^/]+|tests\/.*)/i.test(
      file.path,
    );
    return {
      path: file.path,
      changed,
      additions,
      deletions,
      diff: file.diff,
      isTestFile,
    };
  });

  const modifiedFiles = files.filter((f) => f.changed);
  const linesAdded = modifiedFiles.reduce((sum, f) => sum + f.additions, 0);
  const linesRemoved = modifiedFiles.reduce((sum, f) => sum + f.deletions, 0);
  const saveEventsCount = evidence.events.filter(
    (event) => event.type === 'WORKSPACE_CHANGED',
  ).length;

  const executions = evidence.executions ?? [];
  const passedExecutionRunsCount = executions.filter(
    (run) => run.status === 'COMPLETED' && run.exitCode === 0,
  ).length;
  const failedExecutionRunsCount = executions.filter(
    (run) =>
      run.status === 'FAILED' ||
      run.status === 'TIMED_OUT' ||
      (run.status === 'COMPLETED' &&
        run.exitCode !== null &&
        run.exitCode !== 0),
  ).length;

  const elapsedMs =
    Date.parse(evidence.submittedAt) - Date.parse(evidence.activatedAt);
  const elapsedMinutes =
    Number.isFinite(elapsedMs) && elapsedMs >= 0
      ? Math.max(1, Math.round(elapsedMs / 60_000))
      : null;

  return {
    submittedFilesCount: evidence.submission.files.length,
    modifiedFilesCount: modifiedFiles.length,
    linesAdded,
    linesRemoved,
    timelineEventsCount: evidence.events.length,
    saveEventsCount,
    executionRunsCount: executions.length,
    passedExecutionRunsCount,
    failedExecutionRunsCount,
    aiInteractionsCount: (evidence.aiInteractions ?? []).length,
    elapsedMinutes,
    modifiedTestFilesCount: modifiedFiles.filter((f) => f.isTestFile).length,
    modifiedSourceFilesCount: modifiedFiles.filter((f) => !f.isTestFile).length,
    files,
    brief: presentation.scenarioContext.brief,
    acceptanceCriteria: presentation.scenarioContext.acceptanceCriteria,
  };
}

export function buildDeterministicEvidencePreviewReport(
  evidence: R27Evidence,
  options?: {
    modelId?: string;
    label?: string;
    fallbackReason?: string;
  },
): R27AiReviewReport {
  const summary = computeEvidenceMetricsAndDiffSummary(evidence);
  const modifiedFiles = summary.files.filter((f) => f.changed);
  const changedPathsLabel = modifiedFiles
    .slice(0, 4)
    .map((f) => `${f.path} (+${f.additions}/-${f.deletions})`)
    .join(', ');

  let score = 32;
  if (summary.modifiedFilesCount > 0) {
    score = 62;
    score += Math.min(14, summary.modifiedSourceFilesCount * 8);
    score += summary.modifiedTestFilesCount > 0 ? 8 : 0;
    score +=
      summary.linesAdded + summary.linesRemoved >= 4
        ? 6
        : summary.linesAdded + summary.linesRemoved > 0
          ? 3
          : 0;
    if (evidence.closureReason === 'candidate_submission') {
      score += 4;
    }
    if (summary.passedExecutionRunsCount > 0) {
      score += 6;
    } else if (
      summary.executionRunsCount > 0 &&
      summary.failedExecutionRunsCount === summary.executionRunsCount
    ) {
      score -= 12;
    }
    if (summary.saveEventsCount >= 2) {
      score += 2;
    }
  } else {
    score = evidence.closureReason === 'candidate_submission' ? 28 : 22;
  }

  score = Math.max(5, Math.min(96, Math.round(score)));
  const verdict: R27AiReviewVerdict = score >= 65 ? 'accept' : 'reject';
  const verdictLabel = verdict === 'accept' ? 'Should Accept' : 'Should Reject';
  const confidenceLabel =
    summary.executionRunsCount > 0 && summary.modifiedFilesCount > 0
      ? 'High Confidence'
      : summary.modifiedFilesCount > 0 || summary.saveEventsCount > 0
        ? 'Moderate Confidence'
        : 'Low Confidence';

  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const evidenceHighlights: Array<{ label: string; detail: string }> = [];

  if (summary.modifiedFilesCount > 0) {
    strengths.push(
      `Modified ${summary.modifiedFilesCount} workspace file${summary.modifiedFilesCount === 1 ? '' : 's'} with +${summary.linesAdded} / -${summary.linesRemoved} net lines (${changedPathsLabel}).`,
    );
  } else {
    weaknesses.push(
      'No code differences detected between starter baseline and submitted workspace files.',
    );
  }

  if (summary.modifiedSourceFilesCount > 0) {
    strengths.push(
      `Applied focused implementation edits across ${summary.modifiedSourceFilesCount} source module${summary.modifiedSourceFilesCount === 1 ? '' : 's'} aligned with ${evidence.scenario.title}.`,
    );
  } else if (summary.modifiedFilesCount === 0) {
    weaknesses.push(
      'Core application modules remain unchanged from initial starter state; scenario issue is unresolved in frozen submission.',
    );
  }

  if (summary.modifiedTestFilesCount > 0) {
    strengths.push(
      `Updated or expanded automated test coverage in ${summary.modifiedTestFilesCount} test file${summary.modifiedTestFilesCount === 1 ? '' : 's'}.`,
    );
  } else {
    weaknesses.push(
      'Did not add or update repository test files to demonstrate regression coverage for the change.',
    );
  }

  if (summary.passedExecutionRunsCount > 0) {
    strengths.push(
      `Recorded ${summary.passedExecutionRunsCount} passing restricted execution run${summary.passedExecutionRunsCount === 1 ? '' : 's'} prior to submission.`,
    );
  } else if (summary.failedExecutionRunsCount > 0) {
    weaknesses.push(
      `${summary.failedExecutionRunsCount} recorded execution run${summary.failedExecutionRunsCount === 1 ? '' : 's'} exited non-zero and require reviewer verification.`,
    );
  } else {
    weaknesses.push(
      'No restricted verification test receipt was recorded in the session chronology; reviewer should inspect final diffs directly.',
    );
  }

  if (evidence.closureReason === 'candidate_submission') {
    strengths.push(
      `Explicitly finalized and submitted the assessment${summary.elapsedMinutes ? ` in ${summary.elapsedMinutes} min` : ''} with ${summary.saveEventsCount} recorded save checkpoint${summary.saveEventsCount === 1 ? '' : 's'}.`,
    );
  } else {
    weaknesses.push(
      'Session closed automatically on timer expiration rather than explicit candidate submission.',
    );
  }

  evidenceHighlights.push({
    label: 'Workspace Diff Footprint',
    detail:
      summary.modifiedFilesCount > 0
        ? `${summary.modifiedFilesCount} of ${summary.submittedFilesCount} files changed (+${summary.linesAdded} / -${summary.linesRemoved} lines).`
        : `0 of ${summary.submittedFilesCount} files modified compared to starter snapshot.`,
  });
  evidenceHighlights.push({
    label: 'Chronology & Checkpoints',
    detail: `${summary.timelineEventsCount} session events (${summary.saveEventsCount} workspace save${summary.saveEventsCount === 1 ? '' : 's'}), closure via ${evidence.closureReason === 'candidate_submission' ? 'candidate submission' : 'timeout'}.`,
  });
  evidenceHighlights.push({
    label: 'Verification & AI Signals',
    detail: `${summary.executionRunsCount} execution run${summary.executionRunsCount === 1 ? '' : 's'} recorded · ${summary.aiInteractionsCount} AI assistant prompt${summary.aiInteractionsCount === 1 ? '' : 's'}.`,
  });

  const headline =
    verdict === 'accept'
      ? `Targeted code changes recorded across ${summary.modifiedFilesCount} file${summary.modifiedFilesCount === 1 ? '' : 's'} for ${evidence.scenario.title}`
      : `Insufficient verified implementation changes in submission for ${evidence.scenario.title}`;

  const rationale =
    verdict === 'accept'
      ? `Based on captured session evidence, the candidate progressed from starter baseline to submission across ${summary.modifiedFilesCount} modified file${summary.modifiedFilesCount === 1 ? '' : 's'} (+${summary.linesAdded} / -${summary.linesRemoved} lines) with ${summary.saveEventsCount} recorded save checkpoint${summary.saveEventsCount === 1 ? '' : 's'}${summary.passedExecutionRunsCount > 0 ? ' and passing execution receipts' : ''}. Recommendation: Should Accept to next engineering review stage while confirming edge-case behavior in the Evidence diff view.`
      : `The frozen submission shows ${summary.modifiedFilesCount === 0 ? 'no measurable edits beyond the starter files' : `${summary.failedExecutionRunsCount} failing verification runs without a passing recovery run`} across ${summary.timelineEventsCount} session events. Recommendation: Should Reject because the recorded evidence does not substantiate a working fix against scenario criteria.`;

  return {
    sessionId: evidence.sessionId,
    organizationId: evidence.organizationId,
    score,
    verdict,
    verdictLabel,
    confidenceLabel,
    headline,
    rationale,
    strengths: strengths.slice(0, 5),
    weaknesses: weaknesses.slice(0, 4),
    evidenceHighlights,
    metrics: {
      submittedFilesCount: summary.submittedFilesCount,
      modifiedFilesCount: summary.modifiedFilesCount,
      linesAdded: summary.linesAdded,
      linesRemoved: summary.linesRemoved,
      timelineEventsCount: summary.timelineEventsCount,
      saveEventsCount: summary.saveEventsCount,
    },
    provider: {
      providerId: 'preview',
      modelId: options?.modelId ?? 'hirearchy-evidence-preview-v1',
      label: options?.label ?? 'Evidence-Grounded Preview (Offline Ready)',
      mode: 'evidence_preview',
      ...(options?.fallbackReason
        ? { fallbackReason: options.fallbackReason }
        : {}),
    },
    generatedAt: new Date().toISOString(),
  };
}
