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

function pythonPatterns(content: string, addedLines?: ReadonlySet<number>) {
  type ReturnShape = { entries: number; added: boolean };
  const nestedReturns = new Map<string, Map<number, ReturnShape>>();
  const scopes: { key: string; end: number }[] = [];
  const definitions = new Map<string, { parent: string; count: number }>();
  const addedSyntaxStarts = new Set<number>();
  let snakeCaseIdentifierFound = false;
  const cursor = pythonLanguage.parser.parse(content).cursor();
  let lineNumber = 1;
  let lineEnd = addedLines ? content.indexOf('\n') : -1;
  do {
    while (scopes.length && scopes[scopes.length - 1].end <= cursor.from) {
      scopes.pop();
    }
    if (
      cursor.name === 'FunctionDefinition' ||
      cursor.name === 'ClassDefinition'
    ) {
      const name = cursor.node.getChild('VariableName');
      const identifier = name ? content.slice(name.from, name.to) : '';
      // Functions with the same name can belong to distinct conditional arms.
      const qualifiers = [cursor.name, identifier];
      for (let node = cursor.node.parent; node; node = node.parent) {
        if (
          node.name === 'ClassDefinition' ||
          node.name === 'FunctionDefinition'
        )
          break;
        if (node.name !== 'Body' || node.parent?.name !== 'IfStatement')
          continue;
        const firstArm = node.parent.getChild('Body');
        const condition = node.prevSibling;
        if (firstArm && condition)
          qualifiers.push(
            content.slice(node.parent.from, firstArm.from),
            content.slice(condition.from, node.from),
          );
      }
      const parent = scopes.at(-1)?.key ?? '';
      const key = `${parent}/${JSON.stringify(qualifiers)}`;
      definitions.set(key, {
        parent,
        count: (definitions.get(key)?.count ?? 0) + 1,
      });
      scopes.push({ key, end: cursor.to });
    }
    while (lineEnd !== -1 && lineEnd < cursor.from) {
      lineNumber++;
      lineEnd = content.indexOf('\n', lineEnd + 1);
    }
    if (addedLines?.has(lineNumber)) {
      addedSyntaxStarts.add(cursor.from);
      if (
        cursor.name === 'VariableName' &&
        /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(
          content.slice(cursor.from, cursor.to),
        )
      ) {
        snakeCaseIdentifierFound = true;
      }
    }
    if (cursor.name !== 'DictionaryExpression') continue;

    let value = cursor.node;
    while (value.parent?.name === 'ParenthesizedExpression') {
      value = value.parent;
    }

    let separator = value.prevSibling;
    while (separator?.name === 'Comment') {
      separator = separator.prevSibling;
    }
    const outer = value.parent;
    if (separator?.name !== ':' || outer?.name !== 'DictionaryExpression')
      continue;

    let result = outer;
    while (result.parent?.name === 'ParenthesizedExpression') {
      result = result.parent;
    }
    const statement = result.parent;
    if (statement?.name !== 'ReturnStatement' || statement.getChild(','))
      continue;

    const scope = scopes.at(-1)?.key ?? '';
    let returns = nestedReturns.get(scope);
    if (!returns) {
      returns = new Map();
      nestedReturns.set(scope, returns);
    }
    const existing = returns.get(statement.from);
    returns.set(statement.from, {
      entries: (existing?.entries ?? 0) + 1,
      added:
        existing?.added === true ||
        [cursor.from, separator.from, outer.from, statement.from].some(
          (offset) => addedSyntaxStarts.has(offset),
        ),
    });
  } while (cursor.next());

  return {
    snakeCaseIdentifierFound,
    nestedReturns,
    definitions,
  };
}

function observeAddedPythonPatterns(
  observation: TermsPatternObservation,
  starterContent: string | null,
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

  const submitted = pythonPatterns(content, addedLines);
  observation.snakeCaseIdentifierFound ||= submitted.snakeCaseIdentifierFound;
  if (observation.nestedObjectReturnFound || !submitted.nestedReturns.size)
    return;

  const starter = starterContent ? pythonPatterns(starterContent) : null;
  const unmatchedStarter = [...(starter?.definitions ?? [])].some(
    ([key, { count }]) => count > (submitted.definitions.get(key)?.count ?? 0),
  );
  const ambiguousScopes = new Set<string>();
  // Definitions are visited parent-first. A missing starter definition may
  // have been renamed, and source order cannot identify repeated definitions.
  for (const [key, { parent, count }] of submitted.definitions) {
    const baseline = starter?.definitions.get(key);
    if (
      ambiguousScopes.has(parent) ||
      (baseline ? baseline.count > 1 || count > 1 : unmatchedStarter)
    )
      ambiguousScopes.add(key);
  }
  for (const [scope, returns] of submitted.nestedReturns) {
    if (ambiguousScopes.has(scope)) continue;
    const shapes = [...returns.values()];
    if (!shapes.some(({ added }) => added)) continue;
    const existing = [...(starter?.nestedReturns.get(scope)?.values() ?? [])];
    existing.sort((a, b) => b.entries - a.entries);
    // Within a function, use larger shapes first and match unchanged ties first.
    shapes.sort(
      (a, b) => b.entries - a.entries || Number(a.added) - Number(b.added),
    );
    if (
      shapes.some(
        ({ entries, added }, i) =>
          added && entries > (existing[i]?.entries ?? 0),
      )
    ) {
      observation.nestedObjectReturnFound = true;
      return;
    }
  }
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
        starterContent,
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
