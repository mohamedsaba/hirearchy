import type { R27Evidence } from '../../../../database/postgres/r27/contract.mjs';
import {
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

export interface GenerateR27AiReviewOptions {
  preset?: string;
  customModelId?: string;
  forcePreview?: boolean;
  fetchImpl?: typeof fetch;
  providerOverride?: ResolvedAiReviewProvider;
}

const MAX_PROMPT_DIFF_CHARS = 14000;

function extractJsonObject(rawText: string): Record<string, unknown> | null {
  const trimmed = rawText.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const sliced: unknown = JSON.parse(candidate.slice(start, end + 1));
        if (sliced && typeof sliced === 'object' && !Array.isArray(sliced)) {
          return sliced as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
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

function buildReviewPromptPayload(evidence: R27Evidence) {
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

  const executionLines = (evidence.executions ?? []).map((run, index) => {
    const outSnippet = (run.stdout ?? '').slice(0, 400).trim();
    return `${index + 1}. recipe=${run.recipeId} status=${run.status} exitCode=${run.exitCode ?? 'null'} durationMs=${run.durationMs ?? 'null'}${outSnippet ? ` stdout="${outSnippet}"` : ''}`;
  });

  const aiLines = (evidence.aiInteractions ?? []).map((item, index) => {
    const excerpt = item.candidatePrompt
      .replaceAll(GENERATED_TERMS_AND_CONDITIONS_FOOTER, '')
      .slice(0, 240);
    return `${index + 1}. prompt="${excerpt}" status=${item.status}`;
  });

  const systemPrompt = [
    'You are the Hirearchy Software AI Candidate Review Assistant.',
    'Analyze ONLY the observed candidate engineering evidence provided.',
    'Respond strictly with a single JSON object (no markdown outside JSON) with keys:',
    '- "score": integer 0 to 100',
    '- "verdict": "accept" or "reject"',
    '- "confidenceLabel": "High Confidence" | "Moderate Confidence" | "Low Confidence"',
    '- "headline": crisp 1-sentence executive summary (max 140 chars)',
    '- "rationale": 2-4 sentences explaining clearly WHY the candidate should be accepted or rejected, citing observed files, diffs, or verification outcomes',
    '- "strengths": array of 2-5 concise factual bullets citing observed files/evidence',
    '- "weaknesses": array of 1-4 concise factual bullets identifying gaps, missing tests, or edge cases',
    '- "evidenceHighlights": array of { "label": string, "detail": string } (up to 3 items)',
  ].join('\n');

  const brief = summary.brief?.endsWith(GENERATED_TERMS_AND_CONDITIONS_FOOTER)
    ? summary.brief.slice(0, -GENERATED_TERMS_AND_CONDITIONS_FOOTER.length)
    : summary.brief;

  const userPrompt = [
    `Scenario: ${evidence.scenario.title} (v${evidence.scenario.version})`,
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
    'Execution Runs:',
    executionLines.length ? executionLines.join('\n') : '(None recorded)',
    '',
    'AI Assistant Prompts:',
    aiLines.length ? aiLines.join('\n') : '(None recorded)',
    '',
    'Code Diffs:',
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
  const { systemPrompt, userPrompt } = buildReviewPromptPayload(evidence);

  try {
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
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        model: resolved.modelId,
        temperature: 0.2,
        max_tokens: 1200,
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
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return buildDeterministicEvidencePreviewReport(evidence, {
        modelId: resolved.modelId,
        label: `Evidence-Grounded Preview (Empty AI response fallback)`,
        fallbackReason:
          'Upstream model returned an empty completion; showing evidence-grounded preview.',
      });
    }

    const parsed = extractJsonObject(content);
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
        ? parsed.rationale.trim().slice(0, 1600)
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
