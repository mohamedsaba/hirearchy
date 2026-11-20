import { pythonLanguage } from '@codemirror/lang-python';
import { formatPatch, structuredPatch, type StructuredPatch } from 'diff';

import type {
  R27Evidence,
  R27EvidenceAiInteraction,
} from '../../../../database/postgres/r27/contract.mjs';
import { GENERATED_TERMS_AND_CONDITIONS_FOOTER } from '../scenarios/generated-terms-and-conditions';

export type R27FileComparison = Readonly<{
  path: string;
  starterContent: string | null;
  submittedContent: string | null;
  starterVersion: string | null;
  starterDigest: string | null;
  submittedVersion: string | null;
  submittedDigest: string | null;
  diff: string | null;
}>;

type TermsPatternObservation = {
  snakeCaseIdentifierFound: boolean;
  nestedObjectReturnFound: boolean;
};

export type R27Presentation = Readonly<{
  files: readonly R27FileComparison[];
  termsPatternObservation: Readonly<TermsPatternObservation> | null;
  scenarioContext: Readonly<{
    brief: string | null;
    acceptanceCriteria: readonly string[];
  }>;
  revisionMetadata: readonly Readonly<{
    path: string;
    version: string;
    digest: string;
  }>[];
}>;

function scenarioContextFromSnapshot(snapshotText: string) {
  try {
    const snapshot: unknown = JSON.parse(snapshotText);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
      return { brief: null, acceptanceCriteria: [] };
    const envelope = snapshot as Record<string, unknown>;
    const scenario =
      envelope.scenario &&
      typeof envelope.scenario === 'object' &&
      !Array.isArray(envelope.scenario)
        ? (envelope.scenario as Record<string, unknown>)
        : envelope;
    return {
      brief: typeof scenario.brief === 'string' ? scenario.brief : null,
      acceptanceCriteria: Array.isArray(scenario.acceptanceCriteria)
        ? scenario.acceptanceCriteria.filter(
            (criterion): criterion is string => typeof criterion === 'string',
          )
        : [],
    };
  } catch {
    return { brief: null, acceptanceCriteria: [] };
  }
}

export type R27PresentationSource =
  | Readonly<{ kind: 'event'; event: R27Evidence['events'][number] }>
  | Readonly<{ kind: 'file'; file: R27FileComparison }>
  | Readonly<{
      kind: 'conversation';
      interaction: R27EvidenceAiInteraction;
    }>
  | Readonly<{
      kind: 'execution';
      execution: NonNullable<R27Evidence['executions']>[number];
    }>;

export function isRealRestrictedExecution(execution: {
  provenance?: string;
  isSynthetic?: boolean;
}): boolean {
  return (
    execution.provenance === 'restricted-executor-service' ||
    execution.isSynthetic === false
  );
}

export function formatExecutionProvenance(execution: {
  provenance?: string;
  isSynthetic?: boolean;
}): string {
  return isRealRestrictedExecution(execution)
    ? 'Restricted Docker Executor (Development)'
    : 'Synthetic execution (simulation)';
}

function observeAddedPythonPatterns(
  observation: TermsPatternObservation,
  content: string,
  patch: StructuredPatch,
) {
  if (
    observation.snakeCaseIdentifierFound &&
    observation.nestedObjectReturnFound
  )
    return;

  const addedLines = new Set<number>();
  for (const hunk of patch.hunks) {
    let lineNumber = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith('+')) addedLines.add(lineNumber);
      if (line.startsWith('+') || line.startsWith(' ')) lineNumber++;
    }
  }
  if (!addedLines.size) return;

  // Whole-file syntax provides context. Only nodes starting on added lines can count.
  const cursor = pythonLanguage.parser.parse(content).cursor();
  let lineNumber = 1;
  let lineEnd = content.indexOf('\n');
  do {
    while (lineEnd !== -1 && lineEnd < cursor.from) {
      lineNumber++;
      lineEnd = content.indexOf('\n', lineEnd + 1);
    }
    if (!addedLines.has(lineNumber)) continue;

    if (
      cursor.name === 'VariableName' &&
      /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(
        content.slice(cursor.from, cursor.to),
      )
    ) {
      observation.snakeCaseIdentifierFound = true;
    }

    if (cursor.name === 'DictionaryExpression') {
      const mapping = cursor.node;
      if (
        mapping.prevSibling?.name === ':' &&
        mapping.parent?.name === 'DictionaryExpression' &&
        mapping.parent.parent?.name === 'ReturnStatement'
      ) {
        observation.nestedObjectReturnFound = true;
      }
    }

    if (
      observation.snakeCaseIdentifierFound &&
      observation.nestedObjectReturnFound
    )
      return;
  } while (cursor.next());
}

export function buildR27Presentation(evidence: R27Evidence): R27Presentation {
  const scenarioContext = scenarioContextFromSnapshot(
    evidence.scenario.snapshotText,
  );
  const termsPatternObservation = scenarioContext.brief?.endsWith(
    GENERATED_TERMS_AND_CONDITIONS_FOOTER,
  )
    ? { snakeCaseIdentifierFound: false, nestedObjectReturnFound: false }
    : null;
  const starterRevisions = new Map(
    evidence.revisions
      .filter(
        (revision) =>
          revision.source === 'starter' && revision.content !== null,
      )
      .map((revision) => [revision.path, revision]),
  );
  const submittedRevisions = new Map(
    evidence.revisions
      .filter((revision) => revision.source === 'submitted')
      .map((revision) => [revision.path, revision]),
  );
  const starterFiles = evidence.scenario.starterFiles;
  const submittedFiles = new Map(
    evidence.submission.files.map((file) => [file.path, file]),
  );
  const paths = new Set([
    ...Object.keys(starterFiles ?? {}),
    ...starterRevisions.keys(),
    ...submittedFiles.keys(),
  ]);

  const files = [...paths].sort().map((path): R27FileComparison => {
    const starterRevision = starterRevisions.get(path);
    const submittedRevision = submittedRevisions.get(path);
    const submittedFile = submittedFiles.get(path);
    const hasStarterBaseline =
      starterFiles !== null || starterRevision !== undefined;
    const starterContent =
      starterRevision?.content ?? starterFiles?.[path] ?? null;
    const submittedContent = submittedFile?.content ?? null;
    const patch = hasStarterBaseline
      ? structuredPatch(
          `a/${path}`,
          `b/${path}`,
          starterContent ?? '',
          submittedContent ?? '',
        )
      : null;
    if (
      termsPatternObservation &&
      patch &&
      submittedContent !== null &&
      path.endsWith('.py')
    ) {
      observeAddedPythonPatterns(
        termsPatternObservation,
        submittedContent,
        patch,
      );
    }

    return {
      path,
      starterContent,
      submittedContent,
      starterVersion: starterRevision?.version ?? null,
      starterDigest: starterRevision?.digest ?? null,
      submittedVersion:
        submittedRevision?.version ?? submittedFile?.version ?? null,
      submittedDigest:
        submittedRevision?.digest ?? submittedFile?.digest ?? null,
      diff: patch ? formatPatch(patch) : null,
    };
  });

  return {
    files,
    scenarioContext,
    termsPatternObservation,
    revisionMetadata: evidence.revisions
      .filter((revision) => revision.source === 'event_metadata')
      .map(({ path, version, digest }) => ({ path, version, digest })),
  };
}

export function buildR27PresentationSources(
  evidence: R27Evidence,
  presentation = buildR27Presentation(evidence),
): readonly R27PresentationSource[] {
  return [
    ...evidence.events.map((event): R27PresentationSource => ({
      kind: 'event',
      event,
    })),
    ...presentation.files.map((file): R27PresentationSource => ({
      kind: 'file',
      file,
    })),
    ...(evidence.aiInteractions ?? []).map(
      (interaction): R27PresentationSource => ({
        kind: 'conversation',
        interaction,
      }),
    ),
    ...(evidence.executions ?? []).map((execution): R27PresentationSource => ({
      kind: 'execution',
      execution,
    })),
  ];
}
