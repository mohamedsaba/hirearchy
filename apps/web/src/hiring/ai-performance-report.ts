import type { R27Evidence } from '../../../../database/postgres/r27/contract.mjs';
import {
  callNvidiaKimiChat,
  extractJsonFromLlmText,
  resolveKimiModelId,
} from '../ai/kimi-client';
import { computeEvidenceMetricsAndDiffSummary } from '../r27-evidence/ai-review-contract';
import type { PerformanceFitReport } from './types';

export interface GeneratePerformanceReportInput {
  readonly evidence: R27Evidence;
  readonly targetRole: string;
  readonly experienceLevel: string;
  readonly skills: readonly string[];
  readonly evaluatorStrengths: readonly string[];
  readonly evaluatorWeaknesses: readonly string[];
  readonly evaluatorFeedbackNote: string;
  readonly internalNotes: string;
  readonly nextStageLabel: string;
  readonly allowLiveAi: boolean;
  readonly fetchImpl?: typeof fetch;
}

export function buildDeterministicPerformanceFitReport(
  input: GeneratePerformanceReportInput,
  fallbackReason?: string,
): PerformanceFitReport {
  const summary = computeEvidenceMetricsAndDiffSummary(input.evidence);
  const changedFiles = summary.files.filter((f) => f.changed);
  const clearlyDemonstrated = [
    changedFiles.length > 0
      ? `Submitted changes to ${changedFiles.map((f) => f.path).join(', ')} (+${summary.linesAdded} / -${summary.linesRemoved} lines).`
      : 'No changes were recorded against the starter workspace.',
    `Recorded ${summary.saveEventsCount} save checkpoint${summary.saveEventsCount === 1 ? '' : 's'} across ${summary.elapsedMinutes ?? 'recorded'} minutes.`,
    ...input.evaluatorStrengths.slice(0, 3),
  ].filter(Boolean);

  const unclearOrNotAssessed = [
    summary.modifiedTestFilesCount === 0
      ? 'No direct test file edits were recorded in the submitted repository; verify test thinking verbally in next round.'
      : 'Verify long-term maintainability and production failure modes verbally in the follow-up interview.',
    ...(summary.executionRunsCount === 0
      ? [
          'Live container test execution did not run in this environment; probe debugging workflow.',
        ]
      : []),
    ...input.evaluatorWeaknesses.slice(0, 2),
  ].filter(Boolean);

  const requirementAssessment = [
    ...summary.acceptanceCriteria.slice(0, 4).map((requirement) => ({
      requirement,
      status: 'not_assessed' as const,
      evidence:
        'Inspect the submitted code and recorded checks to establish coverage.',
    })),
    ...input.skills.slice(0, 4).map((skill) => ({
      requirement: `Role skill: ${skill}`,
      status: 'not_assessed' as const,
      evidence: 'This was a target skill for the assessment.',
    })),
  ];

  return {
    overallFitVerdict: 'not_assessed',
    fitHeadline: `Evidence summary for ${input.nextStageLabel}`,
    whyGoodOrBadFit: `The evaluator selected ${input.nextStageLabel}. The submitted workspace has ${changedFiles.length} changed files and ${summary.saveEventsCount} recorded saves. Review the evidence and evaluator feedback before drawing conclusions about fit.`,
    requirementAssessment: requirementAssessment.slice(0, 8),
    strengths:
      input.evaluatorStrengths.length > 0
        ? [...input.evaluatorStrengths]
        : clearlyDemonstrated.slice(0, 3),
    weaknessesAndRisks:
      input.evaluatorWeaknesses.length > 0
        ? [...input.evaluatorWeaknesses]
        : [
            'Verify edge-case depth and scalability trade-offs in the next stage.',
          ],
    clearlyDemonstrated,
    unclearOrNotAssessed,
    suggestedNextInterviewQuestions: [
      `Walk through the trade-offs in ${changedFiles[0]?.path ?? 'your submitted solution'} and how you would test failure modes in production.`,
      'Which edge case gave you the most pause while working on this task, and what would you refactor with more time?',
      `How does your solution scale under concurrent traffic or retries for a ${input.targetRole || 'production'} system?`,
    ],
    provider: {
      modelId: resolveKimiModelId(),
      mode: 'evidence_summary',
      generatedAt: new Date().toISOString(),
      ...(fallbackReason ? { fallbackReason } : {}),
    },
  };
}

export async function generateAcceptancePerformanceReport(
  input: GeneratePerformanceReportInput,
): Promise<PerformanceFitReport> {
  if (!input.allowLiveAi) {
    return buildDeterministicPerformanceFitReport(
      input,
      'AI Managerial Fit Reports are generated automatically on the Ultra plan.',
    );
  }

  const summary = computeEvidenceMetricsAndDiffSummary(input.evidence);
  const diffs = summary.files
    .filter((f) => f.changed && f.diff)
    .map((f) => `### ${f.path} (+${f.additions}/-${f.deletions})\n${f.diff}`)
    .join('\n\n')
    .slice(0, 12000);

  const systemPrompt = [
    'You are preparing a Managerial & Second-Interview Handoff Performance Report for an ACCEPTED engineering candidate at Hirearchy.',
    'Synthesize ONLY the observed assessment evidence, evaluator notes, and target role requirements.',
    'Clearly distinguish what was decisively demonstrated in the assessment vs what remains unclear or was not assessed yet.',
    'Analyze role and requirement coverage. Cite recorded evidence for each judgment. Treat edit counts, timing gaps, and file size as context. Use not_assessed when the evidence is insufficient.',
    'Respond strictly with a single JSON object (no prose outside JSON) with keys:',
    '- "overallFitVerdict": "strong_fit" | "good_fit_with_probes" | "conditional_fit" | "not_assessed"',
    '- "fitHeadline": crisp 1-sentence executive summary for the next-stage manager/interviewer',
    '- "whyGoodOrBadFit": 3-5 sentences analyzing role & requirements fit',
    '- "requirementAssessment": array of { "requirement": string, "status": "demonstrated" | "partial" | "gap" | "not_assessed", "evidence": string }',
    '- "strengths": array of 2-5 concise strings',
    '- "weaknessesAndRisks": array of 1-4 concise strings',
    '- "clearlyDemonstrated": array of 2-5 concise strings describing what was proven in the assessment',
    '- "unclearOrNotAssessed": array of 1-4 concise strings describing what was NOT covered or remains to verify',
    '- "suggestedNextInterviewQuestions": array of 3-5 tailored technical/architectural probing questions for the next-round interviewer',
  ].join('\n');

  const userPrompt = [
    `Target Role: ${input.targetRole || 'Software Engineer'} (${input.experienceLevel})`,
    `Requested Skills: ${input.skills.join(', ') || 'Not specified'}`,
    `Next Interview Stage: ${input.nextStageLabel}`,
    `Assessment Scenario: ${input.evidence.scenario.title}`,
    `Acceptance Criteria:\n${summary.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
    `Evaluator Strengths:\n${input.evaluatorStrengths.join('\n') || '(none)'}`,
    `Evaluator Weaknesses / Watch-outs:\n${input.evaluatorWeaknesses.join('\n') || '(none)'}`,
    `Evaluator Candidate Feedback: ${input.evaluatorFeedbackNote || '(none)'}`,
    `Session Metrics: elapsed=${summary.elapsedMinutes ?? '?'}min, saves=${summary.saveEventsCount}, modifiedFiles=${summary.modifiedFilesCount}, +${summary.linesAdded}/-${summary.linesRemoved}`,
    `Submitted Diffs:\n${diffs || '(no diffs)'}`,
  ].join('\n\n');

  try {
    const { content, modelId } = await callNvidiaKimiChat({
      systemPrompt,
      userPrompt,
      temperature: 0.2,
      maxTokens: 2000,
      timeoutMs: 40_000,
      fetchImpl: input.fetchImpl,
    });
    const parsed = extractJsonFromLlmText(content);
    if (!parsed) {
      return buildDeterministicPerformanceFitReport(
        input,
        'Kimi K3.1 Pro response could not be parsed as JSON; showing structured summary.',
      );
    }

    const fallback = buildDeterministicPerformanceFitReport(input);
    const verdict = [
      'strong_fit',
      'good_fit_with_probes',
      'conditional_fit',
      'not_assessed',
    ].includes(String(parsed.overallFitVerdict))
      ? (parsed.overallFitVerdict as PerformanceFitReport['overallFitVerdict'])
      : fallback.overallFitVerdict;

    const strArr = (v: unknown, fb: readonly string[], limit: number) => {
      if (!Array.isArray(v)) return [...fb];
      const cleaned = v
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, limit);
      return cleaned.length > 0 ? cleaned : [...fb];
    };

    const reqs = Array.isArray(parsed.requirementAssessment)
      ? parsed.requirementAssessment
          .filter(
            (r): r is PerformanceFitReport['requirementAssessment'][number] =>
              Boolean(r) &&
              typeof r === 'object' &&
              typeof (r as { requirement?: unknown }).requirement ===
                'string' &&
              ['demonstrated', 'partial', 'gap', 'not_assessed'].includes(
                String((r as { status?: unknown }).status),
              ) &&
              typeof (r as { evidence?: unknown }).evidence === 'string',
          )
          .slice(0, 10)
      : fallback.requirementAssessment;

    return {
      overallFitVerdict: verdict,
      fitHeadline:
        typeof parsed.fitHeadline === 'string' && parsed.fitHeadline.trim()
          ? parsed.fitHeadline.trim().slice(0, 240)
          : fallback.fitHeadline,
      whyGoodOrBadFit:
        typeof parsed.whyGoodOrBadFit === 'string' &&
        parsed.whyGoodOrBadFit.trim()
          ? parsed.whyGoodOrBadFit.trim().slice(0, 2500)
          : fallback.whyGoodOrBadFit,
      requirementAssessment:
        reqs.length > 0 ? reqs : fallback.requirementAssessment,
      strengths: strArr(parsed.strengths, fallback.strengths, 5),
      weaknessesAndRisks: strArr(
        parsed.weaknessesAndRisks,
        fallback.weaknessesAndRisks,
        4,
      ),
      clearlyDemonstrated: strArr(
        parsed.clearlyDemonstrated,
        fallback.clearlyDemonstrated,
        5,
      ),
      unclearOrNotAssessed: strArr(
        parsed.unclearOrNotAssessed,
        fallback.unclearOrNotAssessed,
        4,
      ),
      suggestedNextInterviewQuestions: strArr(
        parsed.suggestedNextInterviewQuestions,
        fallback.suggestedNextInterviewQuestions,
        5,
      ),
      provider: {
        modelId,
        mode: 'live_ai',
        generatedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Provider error';
    return buildDeterministicPerformanceFitReport(input, message);
  }
}
