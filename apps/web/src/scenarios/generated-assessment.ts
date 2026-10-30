import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { SandboxAdapter } from '../sandbox/sandbox';
import type { ScenarioEvaluationContextSnapshot } from './scenario-evaluation-context';
import type { ScenarioSnapshot } from './slice-one-scenario';

const GENERATED_PYTHON_IMAGE = 'hirearchy-scenario-002:v1.0.0';
const COMPILE_COMMAND = 'python3 -m compileall -q .';
const TEST_COMMAND = 'python3 -m pytest -q --tb=short';
const MAX_FILE_COUNT = 20;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 384 * 1024;
const MAX_PATH_LENGTH = 160;
const PYTHON_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*(?:^|\/)\.)(?!.*(?:^|\/)(?:conftest|setup|sitecustomize|usercustomize)\.py$)[A-Za-z0-9_./-]+\.(?:py|md|json)$/;
const TEST_PATH = /^tests\/test_[A-Za-z0-9_]+\.py$/;

const safePath = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .regex(PYTHON_PATH, 'Use a safe relative Python, Markdown, or JSON path.');

const generatedFile = z
  .object({ path: safePath, content: z.string() })
  .strict();

const boundedText = (min: number, max: number) =>
  z.string().trim().min(min).max(max);

export const GeneratedTaskRubricCriterionSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        'Criterion id must be kebab-case lowercase alphanumeric.',
      ),
    label: boundedText(2, 120),
    description: boundedText(10, 1000),
    weight: z.number().int().min(1).max(100),
    applicability: z
      .object({
        kind: z.enum(['always', 'recorded_integrated_ai_interaction']),
        rule: boundedText(8, 500),
      })
      .strict(),
  })
  .strict();

const generatedTaskRubricSchema = z
  .array(GeneratedTaskRubricCriterionSchema)
  .min(1)
  .max(8);

export const LegacyRubricItemSchema = z
  .object({
    focus: boundedText(1, 120),
    observableEvidence: boundedText(12, 500),
  })
  .strict();

const baseAssessmentShape = {
  title: boundedText(8, 120),
  brief: boundedText(100, 5000),
  durationSeconds: z.number().int().min(900).max(14_400),
  recommendations: z
    .object({
      durationMinutes: z.union([
        z.literal(30),
        z.literal(45),
        z.literal(60),
        z.literal(90),
      ]),
      terminalEnabled: z.boolean(),
      integratedAi: z.boolean(),
    })
    .strict()
    .optional(),
  primaryFilePath: safePath.refine((filePath) => filePath.endsWith('.py')),
  expectedBehavior: z.array(boundedText(8, 400)).min(1).max(8),
  acceptanceCriteria: z.array(boundedText(8, 300)).min(1).max(10),
  evaluatorContext: z
    .object({
      purpose: boundedText(30, 500),
      reviewQuestions: z.array(boundedText(8, 300)).min(1).max(8),
    })
    .strict(),
  starterFiles: z.array(generatedFile).min(1).max(MAX_FILE_COUNT),
  targetTests: z
    .array(
      z
        .object({
          path: z.string().regex(TEST_PATH),
          content: z.string(),
        })
        .strict(),
    )
    .min(1)
    .max(MAX_FILE_COUNT),
  referenceFixFiles: z.array(generatedFile).min(1).max(MAX_FILE_COUNT),
};

export const GeneratedAssessmentSchema = z
  .object({
    ...baseAssessmentShape,
    rubric: generatedTaskRubricSchema,
  })
  .strict()
  .superRefine((assessment, ctx) => {
    if (
      assessment.recommendations &&
      assessment.durationSeconds !==
        assessment.recommendations.durationMinutes * 60
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['durationSeconds'],
        message: 'Duration must match the recommended duration.',
      });
    }
    const starterPaths = new Set<string>();
    const testPaths = new Set<string>();
    const allPaths = new Set<string>();
    let totalBytes = 0;
    const checkFiles = (
      files: readonly { path: string; content: string }[],
      key: 'starterFiles' | 'targetTests' | 'referenceFixFiles',
      paths: Set<string>,
    ) => {
      files.forEach((file, index) => {
        if (paths.has(file.path)) {
          ctx.addIssue({
            code: 'custom',
            path: [key, index, 'path'],
            message: 'File paths must be unique within their group.',
          });
        }
        paths.add(file.path);
        totalBytes += Buffer.byteLength(file.content, 'utf8');
        if (Buffer.byteLength(file.content, 'utf8') > MAX_FILE_BYTES) {
          ctx.addIssue({
            code: 'custom',
            path: [key, index, 'content'],
            message: `File exceeds ${MAX_FILE_BYTES} UTF-8 bytes.`,
          });
        }
      });
    };
    checkFiles(assessment.starterFiles, 'starterFiles', starterPaths);
    checkFiles(assessment.targetTests, 'targetTests', testPaths);
    const referencePaths = new Set<string>();
    checkFiles(
      assessment.referenceFixFiles,
      'referenceFixFiles',
      referencePaths,
    );
    if (
      assessment.starterFiles.length + assessment.targetTests.length >
      MAX_FILE_COUNT
    ) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: `Starter files and target tests exceed ${MAX_FILE_COUNT} files.`,
      });
    }
    for (const file of assessment.starterFiles) allPaths.add(file.path);
    assessment.starterFiles.forEach((file, index) => {
      if (TEST_PATH.test(file.path)) {
        ctx.addIssue({
          code: 'custom',
          path: ['starterFiles', index, 'path'],
          message: 'Target tests must be supplied in targetTests.',
        });
      }
    });
    for (const file of assessment.targetTests) {
      if (allPaths.has(file.path)) {
        ctx.addIssue({
          code: 'custom',
          path: ['targetTests'],
          message: 'Starter files and target tests must have distinct paths.',
        });
      }
      allPaths.add(file.path);
    }
    if (!starterPaths.has(assessment.primaryFilePath)) {
      ctx.addIssue({
        code: 'custom',
        path: ['primaryFilePath'],
        message: 'The primary file must be present in starterFiles.',
      });
    }
    assessment.referenceFixFiles.forEach((file, index) => {
      if (
        !starterPaths.has(file.path) ||
        !file.path.endsWith('.py') ||
        file.path.startsWith('tests/') ||
        !referencePaths.has(file.path)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['referenceFixFiles', index, 'path'],
          message:
            'Reference fixes must uniquely replace existing non-test Python source files only.',
        });
      }
    });
    if (totalBytes > MAX_TOTAL_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: `Assessment files exceed ${MAX_TOTAL_BYTES} UTF-8 bytes.`,
      });
    }

    const criterionIds = new Set<string>();
    let totalWeight = 0;
    assessment.rubric.forEach((item, index) => {
      if (criterionIds.has(item.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rubric', index, 'id'],
          message: 'Criterion IDs must be unique.',
        });
      }
      criterionIds.add(item.id);
      totalWeight += item.weight;
    });
    if (totalWeight !== 100) {
      ctx.addIssue({
        code: 'custom',
        path: ['rubric'],
        message: `Task rubric criterion weights must sum to exactly 100 (got ${totalWeight}).`,
      });
    }
  });

export type GeneratedAssessment = z.infer<typeof GeneratedAssessmentSchema>;
export type GeneratedAssessmentPreview = Omit<
  GeneratedAssessment,
  'referenceFixFiles'
>;

export const LegacyStoredAssessmentSchema = z
  .object({
    ...baseAssessmentShape,
    rubric: z.array(LegacyRubricItemSchema).min(1).max(8),
  })
  .strict();

export const StoredAssessmentSchema = z.union([
  GeneratedAssessmentSchema,
  LegacyStoredAssessmentSchema,
]);

export type StoredAssessment = z.infer<typeof StoredAssessmentSchema>;

const ValidationReceiptSchema = z
  .object({
    runtimeImage: z.literal(GENERATED_PYTHON_IMAGE),
    compilePassed: z.literal(true),
    starterTestsFailed: z.literal(true),
    referenceTestsPassed: z.literal(true),
    validatedAt: z.number().int().nonnegative(),
  })
  .strict();

const StoredEnvelopeSchema = z
  .object({
    formatVersion: z.literal(1),
    id: z.string().regex(/^generated-[a-f0-9]{64}$/),
    assessmentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    assessment: StoredAssessmentSchema,
    validation: ValidationReceiptSchema,
  })
  .strict();

export type StoredGeneratedAssessment = Readonly<{
  id: string;
  assessment: StoredAssessment;
  validation: z.infer<typeof ValidationReceiptSchema>;
}>;

export type GeneratedAssessmentResult =
  | Readonly<{
      status: 'VALIDATED';
      id: string;
      preview: GeneratedAssessmentPreview;
    }>
  | Readonly<{
      status: 'UNAVAILABLE_DRAFT';
      reason:
        | 'SANDBOX_UNAVAILABLE'
        | 'STARTER_SETUP_FAILED'
        | 'STARTER_TESTS_DID_NOT_FAIL'
        | 'STARTER_TEST_FAILURE_UNCLEAR'
        | 'REFERENCE_TESTS_FAILED'
        | 'VALIDATED_ARTIFACT_PERSISTENCE_FAILED';
      validationFeedback?: string;
    }>;

export const parseGeneratedAssessment = (value: unknown) =>
  GeneratedAssessmentSchema.parse(value);

export const parseNewGeneratedAssessmentDraft = (value: unknown) => {
  const assessment = parseGeneratedAssessment(value);
  return {
    ...assessment,
    rubric: generatedTaskRubricSchema.parse(assessment.rubric),
  };
};

const filesForRun = (assessment: GeneratedAssessment) =>
  Object.fromEntries(
    [...assessment.starterFiles, ...assessment.targetTests].map((file) => [
      file.path,
      file.content,
    ]),
  );

const outputOf = (result: Awaited<ReturnType<SandboxAdapter['exec']>>) =>
  `${result.stdoutPreview}\n${result.stderrPreview}`;

const hasOrdinaryTestFailure = (
  result: Awaited<ReturnType<SandboxAdapter['exec']>>,
) => {
  const output = outputOf(result);
  return (
    !result.timedOut &&
    result.exitCode !== null &&
    result.exitCode !== 0 &&
    !result.stdoutTruncated &&
    !result.stderrTruncated &&
    /(?:^|\n)\s*\d+ failed(?:,| in\b)/i.test(output) &&
    !/\b\d+ errors?\b|ERROR collecting|ModuleNotFoundError|ImportError/i.test(
      output,
    )
  );
};

const artifactDirectory = (privateDataDirectory: string) =>
  path.join(path.resolve(privateDataDirectory), 'generated-assessments');

const preparePrivateDirectory = async (directory: string) => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(
      'Generated assessment storage must be a private directory.',
    );
  }
  await chmod(directory, 0o700);
};

const assessmentDigest = (assessment: StoredAssessment) =>
  createHash('sha256').update(JSON.stringify(assessment)).digest('hex');

const persistValidated = async (
  privateDataDirectory: string,
  assessment: GeneratedAssessment,
): Promise<string> => {
  const digest = assessmentDigest(assessment);
  const id = `generated-${digest}`;
  const directory = artifactDirectory(privateDataDirectory);
  await preparePrivateDirectory(directory);
  const finalPath = path.join(directory, `${id}.json`);
  const temporaryPath = path.join(directory, `.${randomUUID()}.tmp`);
  const envelope = {
    formatVersion: 1 as const,
    id,
    assessmentSha256: digest,
    assessment,
    validation: {
      runtimeImage: GENERATED_PYTHON_IMAGE,
      compilePassed: true as const,
      starterTestsFailed: true as const,
      referenceTestsPassed: true as const,
      validatedAt: Date.now(),
    },
  };
  const body = JSON.stringify(envelope);
  if (Buffer.byteLength(body, 'utf8') > MAX_ARTIFACT_BYTES) {
    throw new Error(
      'Validated generated assessment exceeded its storage limit.',
    );
  }
  const file = await open(temporaryPath, 'wx', 0o600);
  try {
    try {
      await file.writeFile(body, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, finalPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
  return id;
};

export async function loadValidatedGeneratedAssessment(
  privateDataDirectory: string,
  id: string,
): Promise<StoredGeneratedAssessment | null> {
  if (!/^generated-[a-f0-9]{64}$/.test(id)) return null;
  const directory = artifactDirectory(privateDataDirectory);
  await preparePrivateDirectory(directory);
  const filePath = path.join(directory, `${id}.json`);
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > MAX_ARTIFACT_BYTES ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(
      'Generated assessment artifact failed storage safety checks.',
    );
  }
  const parsed = StoredEnvelopeSchema.parse(
    JSON.parse(await readFile(filePath, 'utf8')) as unknown,
  );
  const digest = assessmentDigest(parsed.assessment);
  if (
    parsed.id !== id ||
    parsed.assessmentSha256 !== digest ||
    parsed.id !== `generated-${digest}`
  ) {
    throw new Error('Generated assessment artifact integrity check failed.');
  }
  return {
    id: parsed.id,
    assessment: parsed.assessment,
    validation: parsed.validation,
  };
}

export async function validateAndPersistGeneratedAssessment(
  sandbox: SandboxAdapter,
  privateDataDirectory: string,
  value: unknown,
): Promise<GeneratedAssessmentResult> {
  const assessment = parseGeneratedAssessment(value);
  const sessionId = `generated-validation-${randomUUID()}`;
  let reason:
    | Extract<
        GeneratedAssessmentResult,
        { status: 'UNAVAILABLE_DRAFT' }
      >['reason']
    | null = null;
  let validationFeedback: string | undefined;
  let attemptedCreation = false;

  try {
    attemptedCreation = true;
    await sandbox.createAndVerify(sessionId, {
      imageName: GENERATED_PYTHON_IMAGE,
      scenarioType: 'multi_file',
      generatedWorkspace: true,
      initialFiles: filesForRun(assessment),
    });

    const compile = await sandbox.exec(
      sessionId,
      'generated_compile',
      COMPILE_COMMAND,
      '/workspace',
      20_000,
    );
    if (compile.exitCode !== 0 || compile.timedOut) {
      reason = 'STARTER_SETUP_FAILED';
      validationFeedback = outputOf(compile).trim().slice(-6_000) || undefined;
    } else {
      const starterTests = await sandbox.exec(
        sessionId,
        'generated_starter_tests',
        TEST_COMMAND,
        '/workspace',
        30_000,
      );
      if (starterTests.exitCode === 0) {
        reason = 'STARTER_TESTS_DID_NOT_FAIL';
      } else if (!hasOrdinaryTestFailure(starterTests)) {
        reason = 'STARTER_TEST_FAILURE_UNCLEAR';
      } else {
        for (const file of assessment.referenceFixFiles) {
          await sandbox.writeFile(sessionId, file.path, file.content);
        }
        const referenceTests = await sandbox.exec(
          sessionId,
          'generated_reference_tests',
          TEST_COMMAND,
          '/workspace',
          30_000,
        );
        if (
          referenceTests.exitCode !== 0 ||
          referenceTests.timedOut ||
          referenceTests.stdoutTruncated ||
          referenceTests.stderrTruncated
        ) {
          reason = 'REFERENCE_TESTS_FAILED';
          validationFeedback =
            outputOf(referenceTests).trim().slice(-6_000) || undefined;
        }
      }
    }
  } catch {
    reason = 'SANDBOX_UNAVAILABLE';
  }

  if (attemptedCreation) {
    try {
      await sandbox.teardown(sessionId);
    } catch {
      reason = 'SANDBOX_UNAVAILABLE';
    }
  }
  if (reason) {
    return {
      status: 'UNAVAILABLE_DRAFT',
      reason,
      ...(validationFeedback ? { validationFeedback } : {}),
    };
  }

  let id: string;
  try {
    id = await persistValidated(privateDataDirectory, assessment);
  } catch {
    return {
      status: 'UNAVAILABLE_DRAFT',
      reason: 'VALIDATED_ARTIFACT_PERSISTENCE_FAILED',
    };
  }

  const preview: GeneratedAssessmentPreview = {
    title: assessment.title,
    brief: assessment.brief,
    durationSeconds: assessment.durationSeconds,
    primaryFilePath: assessment.primaryFilePath,
    expectedBehavior: assessment.expectedBehavior,
    acceptanceCriteria: assessment.acceptanceCriteria,
    evaluatorContext: assessment.evaluatorContext,
    rubric: assessment.rubric,
    starterFiles: assessment.starterFiles,
    targetTests: assessment.targetTests,
  };
  return { status: 'VALIDATED', id, preview };
}

export function toGeneratedScenarioSnapshot(
  stored: StoredGeneratedAssessment,
): ScenarioSnapshot {
  const assessment = stored.assessment;
  const primaryFile = assessment.starterFiles.find(
    (file) => file.path === assessment.primaryFilePath,
  )!;
  const evaluationContext: ScenarioEvaluationContextSnapshot = {
    schemaVersion: 1,
    version: 'generated-assessment-v1',
    purpose: assessment.evaluatorContext.purpose,
    evidenceAreas: [
      {
        id: 'generated-workspace',
        title: 'Workspace changes',
        description: 'Recorded changes in the generated assessment workspace.',
        selectors: [
          {
            kind: 'workspace_path_prefix',
            prefixes: [
              ...assessment.starterFiles,
              ...assessment.targetTests,
            ].map((file) => file.path),
          },
          {
            kind: 'submitted_path_prefix',
            prefixes: [
              ...assessment.starterFiles,
              ...assessment.targetTests,
            ].map((file) => file.path),
          },
        ],
      },
      {
        id: 'generated-verification',
        title: 'Recorded verification',
        description:
          'Test runs and results recorded in the controlled workspace.',
        selectors: [{ kind: 'verification_result' }],
      },
    ],
    systemInvariants: [
      'The evaluator owns all interpretation and hiring decisions.',
      'Recorded activity does not establish competence or intent.',
    ],
    verificationTargets: [
      ...assessment.expectedBehavior,
      ...assessment.evaluatorContext.reviewQuestions,
    ],
    interpretationWarnings: [
      'A passing or failing automated check is evidence about recorded task behavior, not a hiring decision.',
      'Do not infer candidate intent, competence, or the origin of code from recorded activity.',
    ],
    reviewPolicy: [
      'Human evaluator review is required; automated checks do not issue a verdict.',
    ],
  };

  return {
    id: stored.id,
    version: '1.0.0',
    title: assessment.title,
    brief: assessment.brief,
    acceptanceCriteria: assessment.acceptanceCriteria,
    filePath: primaryFile.path,
    originalContent: primaryFile.content,
    durationSeconds: assessment.durationSeconds,
    type: 'multi_file',
    imageName: GENERATED_PYTHON_IMAGE,
    evaluationContext,
  };
}
