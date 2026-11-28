import type { R27Evidence } from '../../../../database/postgres/r27/contract.mjs';
import { callNvidiaKimiChat, extractJsonFromLlmText } from '../ai/kimi-client';
import {
  NVIDIA_MODEL_ID,
  resolveAiReviewProviderConfig,
  type ResolvedAiReviewProvider,
} from '../ai/server-ai-configuration';
import { GENERATED_TERMS_AND_CONDITIONS_FOOTER } from '../scenarios/generated-terms-and-conditions';
import {
  buildDeterministicEvidencePreviewReport,
  computeEvidenceMetricsAndDiffSummary,
  type R27AiReviewReport,
  type R27AiReviewVerdict,
} from './ai-review-contract';

export * from './ai-review-contract';

export interface HiringReviewRoleContext {
  readonly targetRole?: string;
  readonly experienceLevel?: string;
  readonly skills?: readonly string[];
}

export interface GenerateR27AiReviewOptions {
  preset?: string;
  customModelId?: string;
  forcePreview?: boolean;
  fetchImpl?: typeof fetch;
  providerOverride?: ResolvedAiReviewProvider;
  hiringContext?: HiringReviewRoleContext;
}

const MAX_PROMPT_DIFF_CHARS = 16000;

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSec = Math.round(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function buildChronologyWithTimingDeltas(evidence: R27Evidence): string[] {
  const startMs = Date.parse(evidence.activatedAt || evidence.createdAt);
  let prevMs = startMs;
  return evidence.events.map((ev) => {
    const ts = Date.parse(ev.timestamp);
    const offsetStr =
      Number.isFinite(ts) && Number.isFinite(startMs)
        ? `+${formatDurationMs(ts - startMs)}`
        : '+?';
    const deltaStr =
      Number.isFinite(ts) && Number.isFinite(prevMs)
        ? `Δ+${formatDurationMs(ts - prevMs)}`
        : 'Δ+?';
    if (Number.isFinite(ts)) prevMs = ts;
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    const filePath =
      typeof payload.path === 'string'
        ? ` file=${payload.path}`
        : typeof payload.filePath === 'string'
          ? ` file=${payload.filePath}`
          : '';
    const version =
      payload.version !== undefined ? ` v${String(payload.version)}` : '';
    const promptChars =
      payload.promptChars !== undefined
        ? ` promptChars=${String(payload.promptChars)}`
        : '';
    return `#${ev.sequence} [${offsetStr} | ${deltaStr}] ${ev.type}${filePath}${version}${promptChars}`;
  });
}

function normalizeStringArray(
  value: unknown,
  fallback: readonly string[],
  limit: number,
): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, limit);
  return items.length > 0 ? items : [...fallback];
}

function normalizeVerdict(value: unknown, score: number): R27AiReviewVerdict {
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (
      lower === 'accept' ||
      lower === 'should_accept' ||
      lower === 'should accept'
    ) {
      return 'accept';
    }
    if (
      lower === 'reject' ||
      lower === 'should_reject' ||
      lower === 'should reject'
    ) {
      return 'reject';
    }
  }
  return score >= 65 ? 'accept' : 'reject';
}

function normalizeConfidenceLabel(
  value: unknown,
  fallback: R27AiReviewReport['confidenceLabel'],
): R27AiReviewReport['confidenceLabel'] {
  if (typeof value !== 'string') return fallback;
  const lower = value.toLowerCase();
  if (lower.includes('high')) return 'High Confidence';
  if (lower.includes('low')) return 'Low Confidence';
  if (lower.includes('moderate') || lower.includes('medium')) {
    return 'Moderate Confidence';
  }
  return fallback;
}

function buildReviewPromptPayload(
  evidence: R27Evidence,
  hiringContext?: HiringReviewRoleContext,
) {
  const summary = computeEvidenceMetricsAndDiffSummary(evidence);
  const diffSections: string[] = [];
  let remaining = MAX_PROMPT_DIFF_CHARS;

  for (const file of summary.files) {
    if (!file.changed || !file.diff) continue;
    const section = `### File: ${file.path} (+${file.additions} / -${file.deletions})\n\`\`\`diff\n${file.diff}\n\`\`\``;
    if (section.length <= remaining) {
      diffSections.push(section);
      remaining -= section.length;
    } else if (remaining > 400) {
      diffSections.push(section.slice(0, remaining) + '\n... [diff truncated]');
      break;
    }
  }

  const timelineLines = buildChronologyWithTimingDeltas(evidence);

  const executionLines = (evidence.executions ?? []).map((run, index) => {
    const outSnippet = (run.stdout ?? '').slice(0, 400).trim();
    return `${index + 1}. recipe=${run.recipeId} status=${run.status} exitCode=${run.exitCode ?? 'null'} durationMs=${run.durationMs ?? 'null'}${outSnippet ? ` stdout="${outSnippet}"` : ''}`;
  });

  const aiLines = (evidence.aiInteractions ?? []).map((item, index) => {
    const excerpt = item.candidatePrompt
      .replaceAll(GENERATED_TERMS_AND_CONDITIONS_FOOTER, '')
      .slice(0, 260);
    const respSnippet = (item.assistantResponse ?? '')
      .replaceAll(GENERATED_TERMS_AND_CONDITIONS_FOOTER, '')
      .slice(0, 180)
      .trim();
    return `${index + 1}. [seq ${item.sequenceStart}] prompt="${excerpt}" status=${item.status}${respSnippet ? ` assistantSummary="${respSnippet}"` : ''}`;
  });

  const systemPrompt = [
    'You are a Principal Staff Engineer performing a deep, forensic, evidence-grounded technical review for Hirearchy Software.',
    'You are given ONLY observable candidate engineering records: chronological session events WITH exact timing deltas between actions, file revisions and unified diffs against starter files, recorded verification runs, recorded workspace AI assistant conversations, and role/acceptance requirements.',
    'Analyze between the lines — rigorously and fairly:',
    '- Look closely at timing cadences & intervals (Δ): Did the candidate explore and save incrementally across modules, pause to think/debug before targeted edits, or make a single abrupt large dump near the end? Note timing observations strictly as observable patterns without asserting unobservable mental states or making fabricated accusations.',
    '- Inspect code correctness, edge-case coverage, invariants, regression safety, and test changes directly from the diffs.',
    '- Note whether AI assistant usage (if present) was structured, focused on clarifying invariants, or superficial — without penalizing neutral AI use.',
    '- Cross-check every single acceptance criterion and role requirement against actual submitted code.',
    'NEVER invent files, symbols, or test passes that are not in the evidence. Cite exact file paths, event sequences, and time offsets.',
    'Respond strictly with a single JSON object (no markdown outside JSON) with keys:',
    '- "score": integer 0 to 100',
    '- "verdict": "accept" or "reject"',
    '- "confidenceLabel": "High Confidence" | "Moderate Confidence" | "Low Confidence"',
    '- "headline": crisp 1-sentence executive engineering summary (max 150 chars)',
    '- "rationale": 3-5 analytical sentences explaining clearly WHY the candidate should be accepted or rejected, citing observed files, diffs, timing progression, and acceptance criteria',
    '- "strengths": array of 2-5 specific factual engineering strengths citing files/diffs/events',
    '- "weaknesses": array of 1-4 specific factual engineering gaps, edge-case risks, or verification omissions',
    '- "timingInsights": array of 1-3 concrete observations about the candidate\'s chronological workflow & time intervals between edits/saves/AI prompts',
    '- "requirementBreakdown": array of { "requirement": string, "status": "met" | "partial" | "not_observed", "evidence": string } checking each acceptance criterion & key role skill',
    '- "evidenceHighlights": array of { "label": string, "detail": string } (up to 4 items)',
    '- "verificationQuestions": array of 3-4 objects { "question": string, "focus": string } — pointed, neutral 10-minute live follow-up questions anchored to exact modified files, code choices, edge cases, or notable edit intervals (Δ) to confirm candidate understanding without accusing them of misconduct',
  ].join('\n');

  const roleHeader = hiringContext
    ? [
        `Target Role: ${hiringContext.targetRole || 'Not specified'}`,
        `Experience Level: ${hiringContext.experienceLevel || 'Not specified'}`,
        `Target Skills: ${hiringContext.skills?.length ? hiringContext.skills.join(', ') : 'Not specified'}`,
      ]
    : [];

  const brief = summary.brief?.endsWith(GENERATED_TERMS_AND_CONDITIONS_FOOTER)
    ? summary.brief.slice(0, -GENERATED_TERMS_AND_CONDITIONS_FOOTER.length)
    : summary.brief;

  const userPrompt = [
    `Scenario: ${evidence.scenario.title} (v${evidence.scenario.version})`,
    ...roleHeader,
    `Session Status: ${evidence.status}, Closure: ${evidence.closureReason}, Elapsed: ${summary.elapsedMinutes ?? 'unknown'} minutes`,
    `Files Submitted: ${summary.submittedFilesCount}, Modified Files: ${summary.modifiedFilesCount}, Net Diff: +${summary.linesAdded} / -${summary.linesRemoved}`,
    `Timeline Events: ${summary.timelineEventsCount}, Save Checkpoints: ${summary.saveEventsCount}`,
    '',
    'Scenario Brief:',
    brief ?? '(Not provided in snapshot)',
    '',
    'Acceptance Criteria:',
    summary.acceptanceCriteria.length
      ? summary.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : '(Not listed)',
    '',
    'Chronological Timeline & Timing Deltas:',
    timelineLines.length ? timelineLines.join('\n') : '(No events)',
    '',
    'Execution Runs:',
    executionLines.length ? executionLines.join('\n') : '(None recorded)',
    '',
    'Recorded Candidate AI Assistant Conversations:',
    aiLines.length ? aiLines.join('\n') : '(None recorded)',
    '',
    'Code Diffs (Starter Baseline vs Submitted):',
    diffSections.length
      ? diffSections.join('\n\n')
      : '(No file changes relative to starter baseline)',
  ].join('\n');

  return { systemPrompt, userPrompt, summary };
}

export async function generateR27AiCandidateReview(
  evidence: R27Evidence,
  options: GenerateR27AiReviewOptions = {},
): Promise<R27AiReviewReport> {
  const resolved =
    options.providerOverride ??
    resolveAiReviewProviderConfig({
      preset: options.preset,
      customModelId: options.customModelId,
      forcePreview: options.forcePreview,
    });

  const baselineReport = buildDeterministicEvidencePreviewReport(evidence, {
    modelId: resolved.modelId,
    label: resolved.label,
    fallbackReason: resolved.fallbackReason,
  });

  if (resolved.mode !== 'live_ai' || !resolved.endpoint || !resolved.apiKey) {
    return baselineReport;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const { systemPrompt, userPrompt } = buildReviewPromptPayload(
    evidence,
    options.hiringContext,
  );

  try {
    let content: string | null | undefined;
    if (
      resolved.providerId === 'nvidia' &&
      resolved.modelId === NVIDIA_MODEL_ID
    ) {
      ({ content } = await callNvidiaKimiChat({
        systemPrompt,
        userPrompt,
        maxTokens: 2800,
        timeoutMs: 65_000,
        fetchImpl,
      }));
    } else {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.apiKey}`,
      };
      if (resolved.providerId === 'openrouter') {
        headers['HTTP-Referer'] = 'https://hirearchy.io';
        headers['X-Title'] = 'Hirearchy Software AI Candidate Review';
      }

      const response = await fetchImpl(resolved.endpoint, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(35_000),
        body: JSON.stringify({
          model: resolved.modelId,
          temperature: 0.2,
          max_tokens: 1800,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      });

      if (!response.ok) {
        return buildDeterministicEvidencePreviewReport(evidence, {
          modelId: resolved.modelId,
          label: `Evidence-Grounded Preview (${resolved.label} HTTP ${response.status})`,
          fallbackReason: `Provider ${resolved.providerId} returned HTTP ${response.status}; showing evidence-grounded preview.`,
        });
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      content = payload.choices?.[0]?.message?.content;
    }
    if (typeof content !== 'string' || !content.trim()) {
      return buildDeterministicEvidencePreviewReport(evidence, {
        modelId: resolved.modelId,
        label: `Evidence-Grounded Preview (Empty AI response fallback)`,
        fallbackReason:
          'Upstream model returned an empty completion; showing evidence-grounded preview.',
      });
    }

    const parsed = extractJsonFromLlmText(content);
    if (!parsed) {
      return buildDeterministicEvidencePreviewReport(evidence, {
        modelId: resolved.modelId,
        label: `Evidence-Grounded Preview (Structured parse fallback)`,
        fallbackReason:
          'Upstream model response was not valid JSON; showing evidence-grounded preview.',
      });
    }

    const rawScore = Number(parsed.score);
    const score = Number.isFinite(rawScore)
      ? Math.max(0, Math.min(100, Math.round(rawScore)))
      : baselineReport.score;
    const verdict = normalizeVerdict(parsed.verdict, score);
    const verdictLabel =
      verdict === 'accept' ? 'Should Accept' : 'Should Reject';
    const headline =
      typeof parsed.headline === 'string' && parsed.headline.trim()
        ? parsed.headline.trim().slice(0, 220)
        : baselineReport.headline;
    const rationale =
      typeof parsed.rationale === 'string' && parsed.rationale.trim()
        ? parsed.rationale.trim().slice(0, 2000)
        : baselineReport.rationale;

    const evidenceHighlights = Array.isArray(parsed.evidenceHighlights)
      ? parsed.evidenceHighlights
          .filter(
            (item): item is { label: string; detail: string } =>
              Boolean(item) &&
              typeof item === 'object' &&
              typeof (item as { label?: unknown }).label === 'string' &&
              typeof (item as { detail?: unknown }).detail === 'string',
          )
          .slice(0, 4)
      : baselineReport.evidenceHighlights;

    const timingInsights = Array.isArray(parsed.timingInsights)
      ? parsed.timingInsights
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
          .slice(0, 4)
      : undefined;

    const requirementBreakdown = Array.isArray(parsed.requirementBreakdown)
      ? parsed.requirementBreakdown
          .filter(
            (
              item,
            ): item is {
              requirement: string;
              status: 'met' | 'partial' | 'not_observed';
              evidence: string;
            } =>
              Boolean(item) &&
              typeof item === 'object' &&
              typeof (item as { requirement?: unknown }).requirement ===
                'string' &&
              ['met', 'partial', 'not_observed'].includes(
                String((item as { status?: unknown }).status),
              ) &&
              typeof (item as { evidence?: unknown }).evidence === 'string',
          )
          .slice(0, 10)
      : undefined;

    const verificationQuestions = Array.isArray(parsed.verificationQuestions)
      ? parsed.verificationQuestions
          .filter(
            (item): item is { question: string; focus: string } =>
              Boolean(item) &&
              typeof item === 'object' &&
              typeof (item as { question?: unknown }).question === 'string' &&
              typeof (item as { focus?: unknown }).focus === 'string',
          )
          .map((item) => ({
            question: item.question.trim().slice(0, 400),
            focus: item.focus.trim().slice(0, 220),
          }))
          .filter((item) => item.question.length > 0 && item.focus.length > 0)
          .slice(0, 4)
      : undefined;

    return {
      ...baselineReport,
      score,
      verdict,
      verdictLabel,
      confidenceLabel: normalizeConfidenceLabel(
        parsed.confidenceLabel,
        baselineReport.confidenceLabel,
      ),
      headline,
      rationale,
      strengths: normalizeStringArray(
        parsed.strengths,
        baselineReport.strengths,
        5,
      ),
      weaknesses: normalizeStringArray(
        parsed.weaknesses,
        baselineReport.weaknesses,
        4,
      ),
      evidenceHighlights:
        evidenceHighlights.length > 0
          ? evidenceHighlights
          : baselineReport.evidenceHighlights,
      ...(timingInsights?.length ? { timingInsights } : {}),
      ...(requirementBreakdown?.length ? { requirementBreakdown } : {}),
      verificationQuestions:
        verificationQuestions && verificationQuestions.length > 0
          ? verificationQuestions
          : baselineReport.verificationQuestions,
      provider: {
        providerId: resolved.providerId === 'nvidia' ? 'nvidia' : 'openrouter',
        modelId: resolved.modelId,
        label: resolved.label,
        mode: 'live_ai',
      },
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unexpected provider error';
    return buildDeterministicEvidencePreviewReport(evidence, {
      modelId: resolved.modelId,
      label: `Evidence-Grounded Preview (Provider fallback)`,
      fallbackReason: `${message}; showing evidence-grounded preview.`,
    });
  }
}
