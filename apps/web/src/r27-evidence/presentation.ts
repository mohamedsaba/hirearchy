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

export type R27WorkflowSignal = Readonly<{
  id: string;
  label: string;
  detail: string;
  eventSequence?: string;
}>;

export type R27VerificationQuestion = Readonly<{
  question: string;
  focus: string;
  sourcePath?: string;
}>;

export type R27Presentation = Readonly<{
  files: readonly R27FileComparison[];
  termsPatternObservation: Readonly<TermsPatternObservation> | null;
  workflowSignals: readonly R27WorkflowSignal[];
  liveVerificationQuestions: readonly R27VerificationQuestion[];
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

function countPatchLines(diff: string | null): {
  additions: number;
  deletions: number;
} {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

function isTestPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes('test') ||
    lower.endsWith('_test.py') ||
    lower.startsWith('tests/')
  );
}

function extractEventFilePath(
  payload: Record<string, unknown> | undefined,
): string | null {
  if (!payload) return null;
  if (typeof payload.path === 'string' && payload.path.trim()) {
    return payload.path.trim();
  }
  if (typeof payload.filePath === 'string' && payload.filePath.trim()) {
    return payload.filePath.trim();
  }
  return null;
}

const TEN_MINUTES_MS = 10 * 60 * 1000;

export function buildWorkflowSignals(
  evidence: R27Evidence,
  files: readonly R27FileComparison[],
): readonly R27WorkflowSignal[] {
  const signals: R27WorkflowSignal[] = [];
  const changedFiles = files.filter(
    (file) => file.starterContent !== file.submittedContent,
  );
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const file of changedFiles) {
    const counts = countPatchLines(file.diff);
    totalAdded += counts.additions;
    totalRemoved += counts.deletions;
  }

  const saveEvents = evidence.events.filter(
    (event) => event.type === 'WORKSPACE_CHANGED',
  );
  const saveCount = saveEvents.length;

  if (
    changedFiles.length > 0 &&
    ((totalAdded >= 40 && saveCount <= 1) ||
      (saveCount > 0 && totalAdded / saveCount >= 45))
  ) {
    signals.push({
      id: 'concentrated-save-footprint',
      label: 'Concentrated save footprint',
      detail: `+${totalAdded} / -${totalRemoved} lines recorded across ${saveCount} save checkpoint${saveCount === 1 ? '' : 's'}.`,
    });
  }

  const sortedEvents = [...evidence.events].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
  let longestGapMs = 0;
  let longestGapEvent: R27Evidence['events'][number] | null = null;
  for (let i = 1; i < sortedEvents.length; i += 1) {
    const prevMs = Date.parse(sortedEvents[i - 1].timestamp);
    const curr = sortedEvents[i];
    const currMs = Date.parse(curr.timestamp);
    if (!Number.isFinite(prevMs) || !Number.isFinite(currMs)) continue;
    const gap = currMs - prevMs;
    if (
      gap >= TEN_MINUTES_MS &&
      (curr.type === 'WORKSPACE_CHANGED' ||
        curr.type === 'SESSION_SUBMITTED') &&
      gap > longestGapMs
    ) {
      longestGapMs = gap;
      longestGapEvent = curr;
    }
  }
  if (longestGapEvent) {
    const minutes = Math.round(longestGapMs / 60_000);
    const filePath = extractEventFilePath(
      longestGapEvent.payload as Record<string, unknown> | undefined,
    );
    signals.push({
      id: 'extended-pause-before-checkpoint',
      label: 'Extended pause before checkpoint',
      detail: `${minutes}m interval recorded before event #${longestGapEvent.sequence}${filePath ? ` (${filePath})` : ''}.`,
      eventSequence: longestGapEvent.sequence,
    });
  }

  if (changedFiles.length > 0 && (evidence.executions ?? []).length === 0) {
    signals.push({
      id: 'no-sandboxed-test-run',
      label: 'No sandboxed test run recorded',
      detail:
        'Changes were submitted without a recorded restricted-executor test run.',
    });
  }

  const aiCount = (evidence.aiInteractions ?? []).length;
  if (aiCount > 0) {
    signals.push({
      id: 'recorded-workspace-ai',
      label: 'Recorded workspace AI usage',
      detail: `${aiCount} workspace AI assistant exchange${aiCount === 1 ? '' : 's'} captured in the session log.`,
    });
  }

  return signals;
}

export function buildDeterministicVerificationQuestions(
  evidence: R27Evidence,
  files: readonly R27FileComparison[],
  workflowSignals: readonly R27WorkflowSignal[],
): readonly R27VerificationQuestion[] {
  const changedWithStats = files
    .filter((file) => file.starterContent !== file.submittedContent)
    .map((file) => {
      const counts = countPatchLines(file.diff);
      return {
        file,
        additions: counts.additions,
        deletions: counts.deletions,
        churn: counts.additions + counts.deletions,
        isTest: isTestPath(file.path),
      };
    })
    .sort(
      (a, b) => b.churn - a.churn || a.file.path.localeCompare(b.file.path),
    );

  if (changedWithStats.length === 0) {
    return [
      {
        question:
          'Walk through how you diagnosed the starter repository and what blocked committing a fix within the session window.',
        focus: 'Starter diagnosis and blocker assessment',
      },
    ];
  }

  const questions: R27VerificationQuestion[] = [];
  const sourceChanges = changedWithStats.filter((item) => !item.isTest);
  const testChanges = changedWithStats.filter((item) => item.isTest);
  const primary = sourceChanges[0] ?? changedWithStats[0];

  questions.push({
    question: `Walk through your changes in ${primary.file.path} (+${primary.additions}/-${primary.deletions}) — why did you choose this approach and what edge case or failure mode does it guard against?`,
    focus: `Implementation trade-offs and edge-case reasoning in ${primary.file.path}`,
    sourcePath: primary.file.path,
  });

  const secondary = sourceChanges[1];
  if (secondary) {
    questions.push({
      question: `How do the changes in ${primary.file.path} and ${secondary.file.path} interact, and what contract between them would break if one changed?`,
      focus: `Cross-file contract between ${primary.file.path} and ${secondary.file.path}`,
      sourcePath: secondary.file.path,
    });
  }

  const hasExecution = (evidence.executions ?? []).length > 0;
  if (testChanges.length === 0 || !hasExecution) {
    questions.push({
      question: `What specific regression test would you add first for ${primary.file.path}, and how did you verify boundary inputs without a recorded test run?`,
      focus: 'Verification strategy and missing regression coverage',
      sourcePath: primary.file.path,
    });
  } else {
    const primaryTest = testChanges[0];
    questions.push({
      question: `In ${primaryTest.file.path}, which failure scenario is still unverified if inputs arrive out of order or concurrently?`,
      focus: `Test depth and concurrency edge cases in ${primaryTest.file.path}`,
      sourcePath: primaryTest.file.path,
    });
  }

  const hasBurstOrPause = workflowSignals.some(
    (signal) =>
      signal.id === 'concentrated-save-footprint' ||
      signal.id === 'extended-pause-before-checkpoint',
  );
  if (hasBurstOrPause) {
    questions.push({
      question: `Explain how your solution in ${primary.file.path} evolved before the final checkpoint — what alternative designs did you rule out?`,
      focus: 'Design iteration and independent authorship verification',
      sourcePath: primary.file.path,
    });
  }

  return questions.slice(0, 4);
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

  const workflowSignals = buildWorkflowSignals(evidence, files);
  const liveVerificationQuestions = buildDeterministicVerificationQuestions(
    evidence,
    files,
    workflowSignals,
  );

  return {
    files,
    scenarioContext,
    termsPatternObservation,
    workflowSignals,
    liveVerificationQuestions,
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
