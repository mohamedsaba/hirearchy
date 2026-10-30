import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PYTHON_CHECK_RECIPE,
  R213_APPROVED_RECIPE_ID,
  R213_APPROVED_RECIPE_VERSION,
  R213_DEFAULT_RECIPE_DIGEST,
  R213_DEFAULT_TIMEOUT_MS,
  R213_MAX_EXECUTIONS,
  R213_MAX_STDERR_BYTES,
  R213_MAX_STDOUT_BYTES,
  R213_PROTOCOL_VERSION,
  R213_SYNTHETIC_PROVENANCE,
  computeRecipeDigest,
  type R213ExecutionIntent,
} from '../../apps/web/src/r213-execution/contract';
import {
  SyntheticExecutionAdapter,
  defaultSyntheticExecutionAdapter,
} from '../../apps/web/src/r213-execution/synthetic-adapter';
import { buildR27PresentationSources } from '../../apps/web/src/r27-evidence/presentation';
import {
  buildR27EvidenceSources,
  sourcesForFilter,
  preferredEvidenceSource,
  evidenceFilters,
  type EvidenceSource,
} from '../../apps/web/app/evaluator/sessions/[sessionId]/evidence-workbench';
import type { R27Evidence } from '../../database/postgres/r27/contract.d.mts';

const baseIntent: R213ExecutionIntent = {
  organizationId: '11111111-1111-1111-1111-111111111111',
  sessionId: 'sess_test_123',
  operationId: 'op_exec_test_001',
  requestId: 'req_exec_001',
  assessmentVersion: 'scen_001_v1',
  persistedWorkspaceVersion: '2',
  canonicalWorkspaceSnapshotDigest:
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  approvedRecipeId: R213_APPROVED_RECIPE_ID,
  approvedRecipeVersion: R213_APPROVED_RECIPE_VERSION,
  approvedRecipeDigest: R213_DEFAULT_RECIPE_DIGEST,
  admittedAt: '2026-10-28T00:00:00.000Z',
  sessionDeadline: '2026-10-28T01:00:00.000Z',
  budgets: {
    timeoutMs: R213_DEFAULT_TIMEOUT_MS,
    maxStdoutBytes: R213_MAX_STDOUT_BYTES,
    maxStderrBytes: R213_MAX_STDERR_BYTES,
    maxExecutionCount: R213_MAX_EXECUTIONS,
  },
  generation: 1,
  fence: 5,
  protocolVersion: R213_PROTOCOL_VERSION,
};

describe('R2.13 Execution Contract and Approved Recipe Specifications', () => {
  it('exposes approved python pytest recipe with test lane defaults', () => {
    expect(DEFAULT_PYTHON_CHECK_RECIPE.id).toBe('recipe-python-check-v1');
    expect(DEFAULT_PYTHON_CHECK_RECIPE.version).toBe('1.0.0');
    expect(DEFAULT_PYTHON_CHECK_RECIPE.command).toEqual(['pytest', '-v']);
    expect(DEFAULT_PYTHON_CHECK_RECIPE.timeoutMs).toBe(10_000);
    expect(DEFAULT_PYTHON_CHECK_RECIPE.maxStdoutBytes).toBe(64_000);
    expect(DEFAULT_PYTHON_CHECK_RECIPE.maxStderrBytes).toBe(64_000);
  });

  it('computes deterministic SHA-256 recipe digest matching frozen default', () => {
    const computed = computeRecipeDigest(DEFAULT_PYTHON_CHECK_RECIPE);
    expect(computed).toHaveLength(64);
    expect(computed).toBe(R213_DEFAULT_RECIPE_DIGEST);

    // Altering command alters digest
    const altered = computeRecipeDigest({
      ...DEFAULT_PYTHON_CHECK_RECIPE,
      command: ['pytest', '-q'],
    });
    expect(altered).not.toBe(computed);
  });

  it('defines protocol constants and max execution count budget', () => {
    expect(R213_PROTOCOL_VERSION).toBe('r213-execution-v1');
    expect(R213_SYNTHETIC_PROVENANCE).toBe('synthetic-execution-adapter');
    expect(R213_MAX_EXECUTIONS).toBe(10);
  });
});

describe('R2.13 Synthetic Execution Adapter Deterministic Simulation', () => {
  const adapter = new SyntheticExecutionAdapter();

  it('simulates pytest passing test run when retry with backoff is implemented', async () => {
    const files = {
      'booking.py': `
import time
def send_notification(booking_id):
    for attempt in range(3):
        try:
            return True
        except Exception:
            time.sleep(2 ** attempt)
`,
    };

    const outcome = await adapter.execute(baseIntent, files);

    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.isSynthetic).toBe(true);
    expect(outcome.provenance).toBe('synthetic-execution-adapter');
    expect(outcome.isUnknown).toBe(false);
    expect(outcome.cleanupStatus).toBe('CLEAN');
    expect(outcome.stdout).toContain('3 passed in');
    expect(outcome.stderr).toBe('');
    expect(outcome.outputHashes.stdoutDigest).toHaveLength(64);
    expect(outcome.recipeId).toBe(baseIntent.approvedRecipeId);
    expect(outcome.snapshotDigest).toBe(
      baseIntent.canonicalWorkspaceSnapshotDigest,
    );
  });

  it('simulates pytest failure when retry loop is missing or partial', async () => {
    const partialFiles = {
      'booking.py': `
def send_notification(booking_id):
    # retry loop without backoff
    for attempt in range(3):
        pass
`,
    };

    const outcome = await adapter.execute(baseIntent, partialFiles);

    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain('1 failed, 2 passed');
    expect(outcome.stderr).toContain('Expected backoff delay');
    expect(outcome.outputHashes.stderrDigest).toHaveLength(64);
  });

  it('simulates timeout when SIMULATE_EXECUTION_TIMEOUT marker is in workspace', async () => {
    const timeoutFiles = {
      'service.py': '# SIMULATE_EXECUTION_TIMEOUT test',
    };

    const outcome = await adapter.execute(baseIntent, timeoutFiles);

    expect(outcome.status).toBe('TIMED_OUT');
    expect(outcome.exitCode).toBeNull();
    expect(outcome.stderr).toContain('[COMMAND_TIMEOUT]');
    expect(outcome.resourceUsage.durationMs).toBe(10_000);
    expect(outcome.cleanupStatus).toBe('CLEAN');
  });

  it('simulates unknown execution state when SIMULATE_EXECUTION_UNKNOWN is in workspace', async () => {
    const unknownFiles = {
      'service.py': '# SIMULATE_EXECUTION_UNKNOWN test',
    };

    const outcome = await adapter.execute(baseIntent, unknownFiles);

    expect(outcome.status).toBe('UNKNOWN');
    expect(outcome.exitCode).toBeNull();
    expect(outcome.isUnknown).toBe(true);
    expect(outcome.cleanupStatus).toBe('UNKNOWN');
    expect(outcome.stderr).toContain('[UNKNOWN_STATE]');
  });

  it('simulates runner failure when SIMULATE_EXECUTION_FAILURE is in workspace', async () => {
    const failFiles = {
      'service.py': '# SIMULATE_EXECUTION_FAILURE test',
    };

    const outcome = await adapter.execute(baseIntent, failFiles);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain('container runtime error');
    expect(outcome.isUnknown).toBe(false);
  });

  it('simulates resource leak cleanup state when SIMULATE_RESOURCE_LEAK is in workspace', async () => {
    const leakFiles = {
      'service.py':
        'retry backoff sleep # SIMULATE_RESOURCE_LEAK leaked socket',
    };

    const outcome = await adapter.execute(baseIntent, leakFiles);

    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.cleanupStatus).toBe('RESOURCE_LEAK');
  });

  it('truncates stdout and flags truncation when output exceeds budget limit', async () => {
    const files = {
      'booking.py': 'retry backoff sleep',
    };

    const intentWithSmallBudget: R213ExecutionIntent = {
      ...baseIntent,
      budgets: {
        ...baseIntent.budgets,
        maxStdoutBytes: 80,
      },
    };

    const outcome = await adapter.execute(intentWithSmallBudget, files);

    expect(outcome.truncated.stdout).toBe(true);
    expect(outcome.stdout).toContain('[... STDOUT TRUNCATED ...]');
  });

  it('exports singleton defaultSyntheticExecutionAdapter', () => {
    expect(defaultSyntheticExecutionAdapter).toBeInstanceOf(
      SyntheticExecutionAdapter,
    );
    expect(defaultSyntheticExecutionAdapter.provenance).toBe(
      'synthetic-execution-adapter',
    );
  });
});

describe('R2.13 Evidence Workbench Execution Run Integration', () => {
  const sampleExecution: NonNullable<R27Evidence['executions']>[number] = {
    organizationId: '11111111-1111-1111-1111-111111111111',
    sessionId: 'sess_test_123',
    operationId: 'op_exec_test_001',
    requestId: 'req_exec_001',
    sequenceStart: '10',
    sequenceCompleted: '11',
    workspaceDigest:
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    workspaceVersion: '2',
    recipeId: 'recipe-python-check-v1',
    recipeVersion: '1.0.0',
    recipeDigest: R213_DEFAULT_RECIPE_DIGEST,
    generation: 1,
    fence: 1,
    status: 'COMPLETED',
    exitCode: 0,
    stdout: '3 passed in 0.42s',
    stderr: '',
    stdoutDigest: 'abc',
    stderrDigest: 'def',
    truncatedStdout: false,
    truncatedStderr: false,
    durationMs: 420,
    failureReason: null,
    errorMessage: null,
    cleanupStatus: 'CLEAN',
    isUnknown: false,
    provenance: 'synthetic-execution-adapter',
    isSynthetic: true,
    createdAt: '2026-10-28T01:00:00.000Z',
    completedAt: '2026-10-28T01:00:01.000Z',
  };

  const sampleEvidence: R27Evidence = {
    organizationId: '11111111-1111-1111-1111-111111111111',
    sessionId: 'sess_test_123',
    submittedAt: '2026-10-28T01:10:00.000Z',
    scenario: {
      id: 'scen_001',
      version: '1',
      title: 'Booking Service',
      snapshotText: JSON.stringify({
        scenario: { brief: 'Implement retry', acceptanceCriteria: ['Passes'] },
      }),
      starterFiles: { 'booking.py': '# starter' },
    },
    submission: {
      files: [{ path: 'booking.py', content: '# submitted' }],
    },
    revisions: [],
    events: [
      {
        sequence: '1',
        type: 'SESSION_ACTIVATED',
        timestamp: '2026-10-28T00:00:00.000Z',
        payload: {},
        provenance: 'hirearchy.candidate_session_events',
      },
    ],
    executions: [sampleExecution],
    pagination: { limit: 50, nextAfterSequence: null },
    availability: {
      terminal: 'available',
      ai: 'available',
      verification: 'unavailable',
      history: 'metadata_only',
      limitations: [],
    },
  };

  it('includes execution runs in R27 presentation sources', () => {
    const sources = buildR27PresentationSources(sampleEvidence);
    const executionSource = sources.find((s) => s.kind === 'execution');

    expect(executionSource).toBeDefined();
    if (executionSource && executionSource.kind === 'execution') {
      expect(executionSource.execution.operationId).toBe('op_exec_test_001');
      expect(executionSource.execution.exitCode).toBe(0);
      expect(executionSource.execution.isSynthetic).toBe(true);
    }
  });

  it('maps execution runs into evidence workbench items with factual provenance', () => {
    const workbenchSources = buildR27EvidenceSources(sampleEvidence);
    const execItem = workbenchSources.find((s) => s.kind === 'execution');

    expect(execItem).toBeDefined();
    expect(execItem?.title).toBe('Execution run · recipe-python-check-v1');
    expect(execItem?.summary).toContain('Passed (Exit 0)');
    expect(execItem?.summary).toContain('[Synthetic Test Result]');
    expect(execItem?.execution).toBeDefined();
    expect(execItem?.execution?.provenance).toBe('synthetic-execution-adapter');
  });

  it('filters execution runs using "Execution runs" and "Tests" tab filters', () => {
    const workbenchSources = buildR27EvidenceSources(sampleEvidence);

    expect(evidenceFilters).toContain('Execution runs');

    const execRuns = sourcesForFilter(workbenchSources, 'Execution runs', []);
    expect(execRuns).toHaveLength(1);
    expect(execRuns[0]?.kind).toBe('execution');

    const testRuns = sourcesForFilter(workbenchSources, 'Tests', []);
    expect(testRuns).toHaveLength(1);
    expect(testRuns[0]?.kind).toBe('execution');

    const codeChanges = sourcesForFilter(workbenchSources, 'Code changes', []);
    expect(codeChanges.every((s) => s.kind === 'record')).toBe(true);
  });

  it('prioritizes execution runs in preferredEvidenceSource fallback', () => {
    const onlyExecSources: readonly EvidenceSource[] = [
      {
        key: 'exec-1',
        evidenceRef: 'ref-1',
        evidenceRefs: ['ref-1'],
        entry: null,
        item: null,
        kind: 'execution',
        title: 'Execution run',
        summary: 'Run',
        timestamp: null,
        chronologyOrder: 1,
        verificationRun: null,
        conversation: null,
        r27: { kind: 'execution', execution: sampleExecution },
      },
    ];

    const preferred = preferredEvidenceSource(onlyExecSources);
    expect(preferred?.key).toBe('exec-1');
  });
});
