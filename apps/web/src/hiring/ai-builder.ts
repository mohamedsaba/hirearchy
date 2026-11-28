import { callNvidiaKimiChat, extractJsonFromLlmText } from '../ai/kimi-client';
import type {
  R211AssessmentDraftInput,
  R211RubricCriterion,
  R211StarterFile,
} from '../r211-builder/contract';
import { validateAssessmentDraft } from '../r211-builder/validation';
import { GENERATED_TERMS_AND_CONDITIONS_FOOTER } from '../scenarios/generated-terms-and-conditions';
import {
  experienceLevelLabel,
  type ExperienceLevelId,
  type ProblemStructureId,
} from './catalogs';

export interface AiAssessmentGenerationRequest {
  readonly targetRole: string;
  readonly experienceLevel: ExperienceLevelId;
  readonly yearsExperience: number;
  readonly skills: readonly string[];
  readonly problemStructure: ProblemStructureId;
  readonly workKind: string;
  readonly domain: string;
  readonly durationMinutes: 30 | 45 | 60 | 90;
  readonly integratedAi: boolean;
  readonly guidance?: string;
}

export interface GeneratedAssessmentResult {
  readonly draft: R211AssessmentDraftInput;
  readonly modelId: string;
}

function sanitizeRelativePythonPath(raw: string, fallback: string): string {
  const cleaned = raw.trim().replace(/^\/+/, '').replace(/\\/g, '/');
  if (
    /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*(?:^|\/)\.)(?!.*(?:^|\/)(?:conftest|setup|sitecustomize|usercustomize)\.py$)[A-Za-z0-9_./-]+\.(?:py|md|json|txt)$/.test(
      cleaned,
    )
  ) {
    return cleaned;
  }
  return fallback;
}

function normalizeRubric(raw: unknown): R211RubricCriterion[] {
  const fallback: R211RubricCriterion[] = [
    {
      id: 'correctness',
      label: 'Core correctness & edge cases',
      description:
        'Resolves the core defect cleanly while handling boundary inputs and invariants.',
      weight: 60,
      applicability: {
        kind: 'always',
        rule: 'Applies to all candidate submissions.',
      },
    },
    {
      id: 'verification',
      label: 'Verification & code clarity',
      description:
        'Keeps implementation idiomatic and verifies behavior with clear tests.',
      weight: 40,
      applicability: {
        kind: 'always',
        rule: 'Applies to all candidate submissions.',
      },
    },
  ];

  if (!Array.isArray(raw) || raw.length === 0) return fallback;

  const parsed: R211RubricCriterion[] = [];
  const usedIds = new Set<string>();
  let totalWeight = 0;

  for (let i = 0; i < Math.min(raw.length, 6); i += 1) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const rawId =
      typeof obj.id === 'string'
        ? obj.id.toLowerCase().trim()
        : `crit-${i + 1}`;
    const safeId =
      rawId.replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') ||
      `crit-${i + 1}`;
    if (usedIds.has(safeId)) continue;
    usedIds.add(safeId);

    const label =
      typeof obj.label === 'string' && obj.label.trim().length >= 2
        ? obj.label.trim().slice(0, 120)
        : `Criterion ${i + 1}`;
    const description =
      typeof obj.description === 'string' && obj.description.trim().length >= 10
        ? obj.description.trim().slice(0, 500)
        : `Evaluates ${label} against task criteria.`;
    const weight =
      typeof obj.weight === 'number' &&
      Number.isInteger(obj.weight) &&
      obj.weight > 0
        ? obj.weight
        : 25;

    parsed.push({
      id: safeId,
      label,
      description,
      weight,
      applicability: {
        kind: 'always',
        rule: 'Applies to all candidate submissions.',
      },
    });
    totalWeight += weight;
  }

  if (parsed.length === 0 || totalWeight <= 0) return fallback;
  if (totalWeight !== 100) {
    // Re-normalize cleanly to exactly 100
    let running = 0;
    for (let i = 0; i < parsed.length; i += 1) {
      if (i === parsed.length - 1) {
        parsed[i] = { ...parsed[i]!, weight: Math.max(1, 100 - running) };
      } else {
        const w = Math.max(
          1,
          Math.round((parsed[i]!.weight / totalWeight) * 100),
        );
        parsed[i] = { ...parsed[i]!, weight: w };
        running += w;
      }
    }
    const finalSum = parsed.reduce((acc, c) => acc + c.weight, 0);
    if (finalSum !== 100) return fallback;
  }

  return parsed;
}

export async function generateHiringAssessmentWithKimi(
  input: AiAssessmentGenerationRequest,
  options?: { fetchImpl?: typeof fetch },
): Promise<GeneratedAssessmentResult> {
  const structureInstruction =
    input.problemStructure === 'multi_file'
      ? 'Create a multi-file Python repository (3 to 5 files total, including README.md, 2-3 modular files under src/*.py with realistic interdependent state/logic bugs, and tests/test_*.py with pytest tests that currently fail due to subtle realistic defects).'
      : 'Create a focused single-module Python workspace (3 files total: README.md, src/solution.py containing the buggy/incomplete core module, and tests/test_solution.py with pytest tests).';

  const systemPrompt = [
    'You are a Principal Engineering Assessment Architect for Hirearchy Software.',
    'Design realistic, practical, production-flavored Python coding & debugging assessments — NEVER leetcode trivia.',
    'The candidate works inside an interactive workspace with starter code files and instructions.',
    structureInstruction,
    'Strict path constraints:',
    '- All file paths MUST be clean relative paths ending in .py, .md, .json, or .txt (no leading /, no .., no conftest.py, setup.py, sitecustomize.py, usercustomize.py).',
    '- primaryFilePath MUST end in .py and MUST exist in starterFiles.',
    '- rubric weights MUST be positive integers summing to exactly 100.',
    '- expectedBehavior: 2 to 5 clear strings (12 to 350 chars each).',
    '- acceptanceCriteria: 2 to 6 testable acceptance criteria strings (12 to 280 chars each).',
    'Respond strictly with a single valid JSON object (no prose outside JSON) with keys:',
    '{ "title": string (12-110 chars), "brief": string (120-2500 chars), "primaryFilePath": string, "expectedBehavior": string[], "acceptanceCriteria": string[], "starterFiles": [{ "path": string, "content": string }], "rubric": [{ "id": string, "label": string, "description": string, "weight": integer }] }',
  ].join('\n');

  const userPrompt = [
    `Target Role: ${input.targetRole}`,
    `Experience Level: ${experienceLevelLabel(input.experienceLevel)} (${input.yearsExperience} years)`,
    `Priority Skills: ${input.skills.length > 0 ? input.skills.join(', ') : 'Python, Testing & Debugging'}`,
    `Problem Structure: ${input.problemStructure === 'multi_file' ? 'Multi-file Repository Investigation' : 'Focused Single-Module Problem'}`,
    `Work Type: ${input.workKind}`,
    `Domain: ${input.domain}`,
    `Time Limit: ${input.durationMinutes} minutes`,
    `Candidate Workspace AI Assistant: ${input.integratedAi ? 'Enabled (Kimi K3.1 Pro)' : 'Disabled'}`,
    input.guidance?.trim()
      ? `Hiring Team Guidance: ${input.guidance.trim()}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const { content, modelId } = await callNvidiaKimiChat({
    systemPrompt,
    userPrompt,
    temperature: 0.35,
    maxTokens: input.problemStructure === 'multi_file' ? 6000 : 4000,
    timeoutMs: 90_000,
    responseFormat: 'json_object',
    fetchImpl: options?.fetchImpl,
  });

  const parsed = extractJsonFromLlmText(content);
  if (!parsed) {
    throw new Error(
      'AI generator returned an unstructured response while building the assessment. Please try again.',
    );
  }

  const rawFiles = Array.isArray(parsed.starterFiles)
    ? parsed.starterFiles
    : [];
  const seenPaths = new Set<string>();
  const starterFiles: R211StarterFile[] = [];

  for (let i = 0; i < rawFiles.length; i += 1) {
    const file = rawFiles[i];
    if (!file || typeof file !== 'object') continue;
    const obj = file as Record<string, unknown>;
    if (typeof obj.path !== 'string' || typeof obj.content !== 'string')
      continue;
    const safePath = sanitizeRelativePythonPath(
      obj.path,
      `src/module_${i + 1}.py`,
    );
    if (seenPaths.has(safePath)) continue;
    seenPaths.add(safePath);
    starterFiles.push({ path: safePath, content: obj.content });
  }

  if (starterFiles.length === 0) {
    throw new Error(
      'Generated assessment did not include valid starter workspace files.',
    );
  }

  let primaryFilePath = sanitizeRelativePythonPath(
    typeof parsed.primaryFilePath === 'string' ? parsed.primaryFilePath : '',
    '',
  );
  if (
    !primaryFilePath ||
    !primaryFilePath.endsWith('.py') ||
    !seenPaths.has(primaryFilePath)
  ) {
    const firstPy =
      starterFiles.find(
        (f) => f.path.endsWith('.py') && !f.path.startsWith('tests/'),
      ) ?? starterFiles.find((f) => f.path.endsWith('.py'));
    if (!firstPy) {
      throw new Error(
        'Generated assessment must contain at least one Python (.py) file.',
      );
    }
    primaryFilePath = firstPy.path;
  }

  const title =
    typeof parsed.title === 'string' && parsed.title.trim().length >= 8
      ? parsed.title.trim().slice(0, 120)
      : `${input.targetRole} · ${input.domain} Task`.slice(0, 120);

  const baseBrief =
    typeof parsed.brief === 'string' && parsed.brief.trim().length >= 20
      ? parsed.brief.trim()
      : `Resolve the engineering issue in ${primaryFilePath} for ${input.targetRole} (${input.domain}) and ensure all tests pass.`;

  const brief = baseBrief.endsWith(GENERATED_TERMS_AND_CONDITIONS_FOOTER)
    ? baseBrief
    : baseBrief + GENERATED_TERMS_AND_CONDITIONS_FOOTER;

  if (brief.length > 5000) {
    throw new Error(
      'Generated assessment brief exceeds 5,000 characters after adding Terms and Conditions. Please try again.',
    );
  }

  const expectedBehavior = (
    Array.isArray(parsed.expectedBehavior)
      ? parsed.expectedBehavior.filter(
          (item): item is string =>
            typeof item === 'string' && item.trim().length >= 8,
        )
      : []
  )
    .map((s) => s.trim().slice(0, 380))
    .slice(0, 6);
  if (expectedBehavior.length === 0) {
    expectedBehavior.push(
      `Fixes the core logic in ${primaryFilePath} cleanly without introducing regressions.`,
    );
  }

  const acceptanceCriteria = (
    Array.isArray(parsed.acceptanceCriteria)
      ? parsed.acceptanceCriteria.filter(
          (item): item is string =>
            typeof item === 'string' && item.trim().length >= 8,
        )
      : []
  )
    .map((s) => s.trim().slice(0, 290))
    .slice(0, 8);
  if (acceptanceCriteria.length === 0) {
    acceptanceCriteria.push(
      'All repository unit tests pass and edge cases are handled cleanly.',
    );
  }

  const draft: R211AssessmentDraftInput = {
    templateId: 'ai-generated',
    title,
    brief,
    expectedBehavior,
    acceptanceCriteria,
    primaryFilePath,
    starterFiles,
    durationMinutes: input.durationMinutes,
    terminalEnabled: true,
    integratedAi: input.integratedAi,
    rubric: normalizeRubric(parsed.rubric),
  };

  const validation = validateAssessmentDraft(draft);
  if (!validation.valid) {
    throw new Error(
      `Generated assessment failed structural validation: ${validation.issues[0]?.message ?? 'unknown issue'}`,
    );
  }

  return { draft, modelId };
}
