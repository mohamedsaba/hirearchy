// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { R26CandidateClient } from '../../apps/web/app/r26/candidate/[sessionId]/candidate-client';
import {
  EvidenceSourceInspector,
  buildR27EvidenceSources,
  sourcesForFilter,
} from '../../apps/web/app/evaluator/sessions/[sessionId]/evidence-workbench';
import {
  formatExecutionProvenance,
  isRealRestrictedExecution,
} from '../../apps/web/src/r27-evidence/presentation';
import type { R27Evidence } from '../../database/postgres/r27/contract.d.mts';
import type { R26CandidateView } from '../../database/postgres/r26/adapter.mjs';
import type { R213CandidateExecutionView } from '../../apps/web/src/r213-execution/contract';

// @ts-expect-error react act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const validCandidateToken = Buffer.alloc(32, 1).toString('base64url');

const baseMockCandidateView: R26CandidateView = {
  sessionId: 'sess_r214_test',
  organizationId: '11111111-1111-1111-1111-111111111111',
  status: 'ACTIVE',
  scenario: {
    title: 'Booking Engine Recovery',
    brief: 'Implement retry with exponential backoff.',
    acceptanceCriteria: ['All tests pass reliably', 'Handle timeout properly'],
  },
  starterFiles: [
    {
      path: 'booking.py',
      version: '1',
      digest: 'starter_digest_001',
      sizeBytes: 120,
    },
  ],
  files: [
    {
      path: 'booking.py',
      version: '2',
      digest: 'active_digest_002',
      content: 'def send_booking():\n    pass\n',
      sizeBytes: 150,
      updatedAt: '2026-10-28T12:00:00.000Z',
    },
  ],
  activeFilePath: 'booking.py',
  workspaceDigest:
    'a1b2c3d4e5f60000111122223333444455556666777788889999aaaabbbbcccc',
  serverNow: '2026-10-28T12:05:00.000Z',
  activatedAt: '2026-10-28T12:00:00.000Z',
  submittedAt: null,
  durationMinutes: 60,
  deadline: '2026-10-28T13:00:00.000Z',
  closureReason: null,
  events: [],
};

describe('R2.14 Execution Presentation Logic & Provenance Helpers', () => {
  it('correctly identifies real restricted execution vs synthetic simulation', () => {
    // Real restricted executor via provenance
    expect(
      isRealRestrictedExecution({
        provenance: 'restricted-executor-service',
        isSynthetic: false,
      }),
    ).toBe(true);

    // Real restricted executor via isSynthetic flag
    expect(
      isRealRestrictedExecution({
        provenance: 'docker-restricted-executor-worker',
        isSynthetic: false,
      }),
    ).toBe(true);

    // Synthetic execution adapter
    expect(
      isRealRestrictedExecution({
        provenance: 'synthetic-execution-adapter',
        isSynthetic: true,
      }),
    ).toBe(false);

    // Default missing provenance / fallback
    expect(isRealRestrictedExecution({})).toBe(false);
  });

  it('formats factual execution provenance labels accurately', () => {
    expect(
      formatExecutionProvenance({
        provenance: 'restricted-executor-service',
        isSynthetic: false,
      }),
    ).toBe('Restricted Docker Executor (Development)');

    expect(
      formatExecutionProvenance({
        provenance: 'synthetic-execution-adapter',
        isSynthetic: true,
      }),
    ).toBe('Synthetic execution (simulation)');
  });
});

describe('R2.14 Evidence Workbench Execution Presentation & Provenance', () => {
  const realExecutionItem: NonNullable<R27Evidence['executions']>[number] = {
    organizationId: '11111111-1111-1111-1111-111111111111',
    sessionId: 'sess_r214_test',
    operationId: 'op_real_001',
    requestId: 'req_real_001',
    sequenceStart: '12',
    sequenceCompleted: '13',
    workspaceDigest:
      'a1b2c3d4e5f60000111122223333444455556666777788889999aaaabbbbcccc',
    workspaceVersion: '2',
    recipeId: 'reservation-moves.pytest',
    recipeVersion: '3.0.0',
    recipeDigest: 'digest_recipe_pytest_v3',
    generation: 1,
    fence: 1,
    status: 'COMPLETED',
    exitCode: 0,
    stdout: '================ 4 passed in 1.23s ================',
    stderr: '',
    stdoutDigest: 'stdout_digest_hex_001',
    stderrDigest: 'stderr_digest_hex_001',
    truncatedStdout: false,
    truncatedStderr: false,
    durationMs: 1230,
    failureReason: null,
    errorMessage: null,
    cleanupStatus: 'CLEAN',
    isUnknown: false,
    provenance: 'restricted-executor-service',
    isSynthetic: false as unknown as true,
    createdAt: '2026-10-28T12:02:00.000Z',
    completedAt: '2026-10-28T12:02:01.230Z',
  };

  const syntheticExecutionItem: NonNullable<R27Evidence['executions']>[number] =
    {
      organizationId: '11111111-1111-1111-1111-111111111111',
      sessionId: 'sess_r214_test',
      operationId: 'op_synth_001',
      requestId: 'req_synth_001',
      sequenceStart: '8',
      sequenceCompleted: '9',
      workspaceDigest:
        'a1b2c3d4e5f60000111122223333444455556666777788889999aaaabbbbcccc',
      workspaceVersion: '1',
      recipeId: 'recipe-python-check-v1',
      recipeVersion: '1.0.0',
      recipeDigest: 'digest_recipe_pytest_v1',
      generation: 1,
      fence: 1,
      status: 'COMPLETED',
      exitCode: 0,
      stdout: '3 passed in 0.45s',
      stderr: '',
      stdoutDigest: 'stdout_digest_hex_synth',
      stderrDigest: 'stderr_digest_hex_synth',
      truncatedStdout: false,
      truncatedStderr: false,
      durationMs: 450,
      failureReason: null,
      errorMessage: null,
      cleanupStatus: 'CLEAN',
      isUnknown: false,
      provenance: 'synthetic-execution-adapter',
      isSynthetic: true,
      createdAt: '2026-10-28T12:01:00.000Z',
      completedAt: '2026-10-28T12:01:00.450Z',
    };

  const mockEvidence: R27Evidence = {
    permission: 'assigned_reviewer',
    reviewer: { subjectId: 'rev_1', principalId: 'reviewer@hirearchy.dev' },
    organizationId: '11111111-1111-1111-1111-111111111111',
    sessionId: 'sess_r214_test',
    assignment: {
      id: 'asgn_1',
      version: '1',
      assignedAt: '2026-10-28T12:00:00Z',
    },
    scenario: {
      id: 'reservation-moves',
      version: '3',
      title: 'Reservation Moves Service',
      snapshotText: JSON.stringify({
        scenario: { brief: 'Implement backoff' },
      }),
      snapshotDigest: 'scenario_snapshot_digest',
      starterFiles: { 'booking.py': 'def booking(): pass' },
    },
    status: 'SUBMITTED',
    createdAt: '2026-10-28T12:00:00Z',
    activatedAt: '2026-10-28T12:01:00Z',
    submittedAt: '2026-10-28T12:30:00Z',
    closureReason: 'candidate_submission',
    submission: {
      files: [{ path: 'booking.py', content: 'def booking(): pass' }],
    },
    revisions: [],
    events: [],
    executions: [syntheticExecutionItem, realExecutionItem],
    pagination: { limit: 50, nextAfterSequence: null },
    availability: {
      terminal: 'available',
      ai: 'available',
      verification: 'unavailable',
      history: 'metadata_only',
      limitations: [],
    },
  };

  it('buildR27EvidenceSources distinguishes real restricted executor from synthetic simulation in summary', () => {
    const sources = buildR27EvidenceSources(mockEvidence);
    const execSources = sourcesForFilter(sources, 'Execution runs', []);

    expect(execSources).toHaveLength(2);

    const synthSource = execSources.find(
      (s) => s.execution?.operationId === 'op_synth_001',
    );
    const realSource = execSources.find(
      (s) => s.execution?.operationId === 'op_real_001',
    );

    expect(synthSource).toBeDefined();
    expect(realSource).toBeDefined();

    // Synthetic contains simulation label and preserved test lane marker
    expect(synthSource?.summary).toContain('Synthetic execution (simulation)');
    expect(synthSource?.summary).toContain('[Synthetic Test Result]');

    // Real executor contains real executor label and does NOT contain synthetic marker
    expect(realSource?.summary).toContain(
      'Restricted Docker Executor (Development)',
    );
    expect(realSource?.summary).not.toContain('[Synthetic Test Result]');
  });

  it('renders EvidenceSourceInspector with real restricted executor badge and factual details', () => {
    const sources = buildR27EvidenceSources(mockEvidence);
    const realSource = sources.find(
      (s) => s.execution?.operationId === 'op_real_001',
    )!;

    const markup = renderToStaticMarkup(
      createElement(EvidenceSourceInspector, {
        source: realSource,
        r27Evidence: mockEvidence,
      }),
    );

    // Real executor badge
    expect(markup).toContain('data-testid="real-execution-receipt-badge"');
    expect(markup).toContain('Restricted Docker Executor (Development)');

    // Disclaimer: No automatic hiring decision or ranking
    expect(markup).toContain('data-testid="execution-evaluator-disclaimer"');
    expect(markup).toContain(
      'No automatic hiring decision, score, or ranking is produced',
    );
    expect(markup).toContain('The human evaluator owns all judgment');

    // Factual details in metadata dl
    expect(markup).toContain('data-testid="execution-factual-provenance"');
    expect(markup).toContain('data-testid="execution-exit-code"');
    expect(markup).toContain('data-testid="execution-exit-status"');
    expect(markup).toContain('data-testid="execution-duration"');
    expect(markup).toContain('1230ms');
    expect(markup).toContain('data-testid="execution-cleanup-status"');
    expect(markup).toContain('CLEAN');
    expect(markup).toContain('data-testid="execution-stdout-digest"');
    expect(markup).toContain('stdout_digest_hex_001');
    expect(markup).toContain('data-testid="execution-stderr-digest"');
    expect(markup).toContain('stderr_digest_hex_001');

    // Captured stdout stream
    expect(markup).toContain('data-testid="evaluator-execution-stdout"');
    expect(markup).toContain('4 passed in 1.23s');
  });

  it('renders EvidenceSourceInspector with synthetic simulation badge for synthetic runs', () => {
    const sources = buildR27EvidenceSources(mockEvidence);
    const synthSource = sources.find(
      (s) => s.execution?.operationId === 'op_synth_001',
    )!;

    const markup = renderToStaticMarkup(
      createElement(EvidenceSourceInspector, {
        source: synthSource,
        r27Evidence: mockEvidence,
      }),
    );

    expect(markup).toContain('data-testid="synthetic-execution-receipt-badge"');
    expect(markup).toContain('Synthetic execution (simulation)');
    expect(markup).toContain('[Synthetic Execution Receipt · Test Lane]');
  });

  it('renders UNKNOWN status and truncation indicators truthfully in EvidenceSourceInspector', () => {
    const unknownExecutionItem: NonNullable<R27Evidence['executions']>[number] =
      {
        ...realExecutionItem,
        operationId: 'op_unknown_002',
        status: 'UNKNOWN',
        exitCode: null,
        isUnknown: true,
        truncatedStdout: true,
        truncatedStderr: true,
        failureReason: 'CONTAINER_TERMINATED_ABRUPTLY',
        errorMessage: 'Worker connection dropped during execution run',
        cleanupStatus: 'UNKNOWN',
        stdout: '[Partial standard output before disconnect]',
        stderr: '[Container heartbeat failure]',
      };

    const unknownEvidence: R27Evidence = {
      ...mockEvidence,
      executions: [unknownExecutionItem],
    };

    const sources = buildR27EvidenceSources(unknownEvidence);
    const unknownSource = sources.find(
      (s) => s.execution?.operationId === 'op_unknown_002',
    )!;

    const markup = renderToStaticMarkup(
      createElement(EvidenceSourceInspector, {
        source: unknownSource,
        r27Evidence: unknownEvidence,
      }),
    );

    // UNKNOWN execution badge and status
    expect(markup).toContain('data-testid="unknown-execution-badge"');
    expect(markup).toContain('[UNKNOWN EXECUTION STATE]');
    expect(markup).toContain('data-testid="execution-status-badge"');
    expect(markup).toContain('Unknown');

    // Truncation notices
    expect(markup).toContain('data-testid="stdout-truncated-notice"');
    expect(markup).toContain('data-testid="stderr-truncated-notice"');
    expect(markup).toContain('[Output truncated at limit]');

    // Failure reason & error message
    expect(markup).toContain('data-testid="execution-failure-reason"');
    expect(markup).toContain('CONTAINER_TERMINATED_ABRUPTLY');
    expect(markup).toContain('data-testid="execution-error-message"');
    expect(markup).toContain('Worker connection dropped during execution run');

    // Cleanup status UNKNOWN
    expect(markup).toContain('data-testid="execution-cleanup-status"');
    expect(markup).toContain('UNKNOWN');
  });
});

describe('R2.14 Candidate Client Execution Panel UI Rendering', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    window.sessionStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  const setupMockFetch = (executionView: R213CandidateExecutionView) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string | URL) => {
        const urlStr = String(url);
        if (urlStr.includes('/execution')) {
          return Promise.resolve(
            new Response(JSON.stringify(executionView), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        if (urlStr.includes('/ai')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                enabled: false,
                interactions: [],
                remainingInteractions: 0,
                totalInteractionsAllowed: 5,
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify(baseMockCandidateView), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }),
    );
  };

  it('renders Real Restricted Executor (Dev) badge and factual receipt when operation is real executor', async () => {
    const realExecutionView: R213CandidateExecutionView = {
      terminalEnabled: true,
      remainingExecutions: 8,
      maxExecutions: 10,
      currentWorkspaceDigest: baseMockCandidateView.workspaceDigest,
      operations: [
        {
          organizationId: '11111111-1111-1111-1111-111111111111',
          sessionId: 'sess_r214_test',
          operationId: 'op_real_candidate_001',
          requestId: 'req_real_candidate_001',
          sequenceStart: 10,
          sequenceCompleted: 11,
          workspaceDigest: baseMockCandidateView.workspaceDigest,
          workspaceVersion: '2',
          recipeId: 'reservation-moves.pytest',
          recipeVersion: '3.0.0',
          recipeDigest: 'digest_recipe_v3',
          generation: 1,
          fence: 1,
          status: 'COMPLETED',
          exitCode: 0,
          stdout: '3 passed in 0.88s',
          stderr: '',
          stdoutDigest: 'stdout_hash_123',
          stderrDigest: 'stderr_hash_123',
          truncatedStdout: false,
          truncatedStderr: false,
          durationMs: 880,
          failureReason: null,
          errorMessage: null,
          cleanupStatus: 'CLEAN',
          isUnknown: false,
          provenance: 'restricted-executor-service',
          isSynthetic: false as unknown as true,
          createdAt: '2026-10-28T12:04:00.000Z',
          completedAt: '2026-10-28T12:04:00.880Z',
        },
      ],
    };

    window.sessionStorage.setItem(
      'hirearchy:r26:candidate-token:v1:sess_r214_test',
      validCandidateToken,
    );
    setupMockFetch(realExecutionView);

    await act(async () => {
      root?.render(
        createElement(R26CandidateClient, { sessionId: 'sess_r214_test' }),
      );
    });

    // Wait for microtasks & fetch effects
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Explicit Development-mode badge for real restricted executor
    const realBadge = container?.querySelector(
      '[data-testid="real-executor-badge"]',
    );
    expect(realBadge).not.toBeNull();
    expect(realBadge?.textContent).toContain('Real Restricted Executor (Dev)');

    // Status badge: Passed (Exit 0)
    const stateBadge = container?.querySelector(
      '[data-testid="execution-state-badge"]',
    );
    expect(stateBadge?.textContent).toContain('Passed (Exit 0)');

    // Cleanup status pill: CLEAN
    const cleanupPill = container?.querySelector(
      '[data-testid="execution-cleanup-pill"]',
    );
    expect(cleanupPill?.textContent).toContain('Cleanup: CLEAN');
    expect(cleanupPill?.className).toContain('cleanup-clean');

    // Duration
    const duration = container?.querySelector(
      '[data-testid="execution-duration"]',
    );
    expect(duration?.textContent).toContain('Duration: 880ms');

    // Factual receipt details
    const receipt = container?.querySelector(
      '[data-testid="execution-receipt"]',
    );
    expect(receipt).not.toBeNull();
    expect(receipt?.querySelector('summary')?.textContent).toContain(
      'View stored restricted executor receipt',
    );
    expect(
      receipt?.querySelector('[data-testid="receipt-execution-mode"]')
        ?.textContent,
    ).toContain('Real Restricted Executor (Dev)');
    expect(
      receipt?.querySelector('[data-testid="receipt-cleanup-status"]')
        ?.textContent,
    ).toBe('CLEAN');
    expect(
      receipt?.querySelector('[data-testid="receipt-provenance"]')?.textContent,
    ).toBe('restricted-executor-service');
  });

  it('renders Synthetic Execution Adapter badge when operation is simulated', async () => {
    const syntheticExecutionView: R213CandidateExecutionView = {
      terminalEnabled: true,
      remainingExecutions: 9,
      maxExecutions: 10,
      currentWorkspaceDigest: baseMockCandidateView.workspaceDigest,
      operations: [
        {
          organizationId: '11111111-1111-1111-1111-111111111111',
          sessionId: 'sess_r214_test',
          operationId: 'op_synth_candidate_001',
          requestId: 'req_synth_candidate_001',
          sequenceStart: 5,
          sequenceCompleted: 6,
          workspaceDigest: baseMockCandidateView.workspaceDigest,
          workspaceVersion: '1',
          recipeId: 'recipe-python-check-v1',
          recipeVersion: '1.0.0',
          recipeDigest: 'digest_recipe_v1',
          generation: 1,
          fence: 1,
          status: 'COMPLETED',
          exitCode: 1,
          stdout: '1 failed, 2 passed',
          stderr: 'AssertionError: assert False',
          stdoutDigest: 'stdout_hash_synth',
          stderrDigest: 'stderr_hash_synth',
          truncatedStdout: false,
          truncatedStderr: false,
          durationMs: 320,
          failureReason: null,
          errorMessage: null,
          cleanupStatus: 'CLEAN',
          isUnknown: false,
          provenance: 'synthetic-execution-adapter',
          isSynthetic: true,
          createdAt: '2026-10-28T12:02:00.000Z',
          completedAt: '2026-10-28T12:02:00.320Z',
        },
      ],
    };

    window.sessionStorage.setItem(
      'hirearchy:r26:candidate-token:v1:sess_r214_test',
      validCandidateToken,
    );
    setupMockFetch(syntheticExecutionView);

    await act(async () => {
      root?.render(
        createElement(R26CandidateClient, { sessionId: 'sess_r214_test' }),
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Synthetic badge
    const synthBadge = container?.querySelector(
      '[data-testid="synthetic-execution-badge"]',
    );
    expect(synthBadge).not.toBeNull();
    expect(synthBadge?.textContent).toContain('Synthetic Execution Adapter');
    expect(synthBadge?.textContent).toContain(
      '[Synthetic Test Result · Test Lane]',
    );

    // Status: Failed (Exit 1)
    const stateBadge = container?.querySelector(
      '[data-testid="execution-state-badge"]',
    );
    expect(stateBadge?.textContent).toContain('Failed (Exit 1)');

    // Receipt details
    const receipt = container?.querySelector(
      '[data-testid="execution-receipt"]',
    );
    expect(receipt?.querySelector('summary')?.textContent).toContain(
      'View stored synthetic execution receipt',
    );
    expect(
      receipt?.querySelector('[data-testid="receipt-execution-mode"]')
        ?.textContent,
    ).toContain('Synthetic Execution Adapter');
  });

  it('truthfully presents UNKNOWN execution status, failure reason, and truncation notice in Candidate Client', async () => {
    const unknownExecutionView: R213CandidateExecutionView = {
      terminalEnabled: true,
      remainingExecutions: 7,
      maxExecutions: 10,
      currentWorkspaceDigest: baseMockCandidateView.workspaceDigest,
      operations: [
        {
          organizationId: '11111111-1111-1111-1111-111111111111',
          sessionId: 'sess_r214_test',
          operationId: 'op_unknown_candidate_001',
          requestId: 'req_unknown_candidate_001',
          sequenceStart: 14,
          sequenceCompleted: null,
          workspaceDigest: baseMockCandidateView.workspaceDigest,
          workspaceVersion: '2',
          recipeId: 'reservation-moves.pytest',
          recipeVersion: '3.0.0',
          recipeDigest: 'digest_recipe_v3',
          generation: 1,
          fence: 1,
          status: 'UNKNOWN',
          exitCode: null,
          stdout: 'Processing tests...',
          stderr: 'Connection reset by executor proxy',
          stdoutDigest: null,
          stderrDigest: null,
          truncatedStdout: true,
          truncatedStderr: false,
          durationMs: 10000,
          failureReason: 'WORKER_HEARTBEAT_TIMEOUT',
          errorMessage: 'Restricted execution backend became unreachable',
          cleanupStatus: 'UNKNOWN',
          isUnknown: true,
          provenance: 'restricted-executor-service',
          isSynthetic: false as unknown as true,
          createdAt: '2026-10-28T12:10:00.000Z',
          completedAt: null,
        },
      ],
    };

    window.sessionStorage.setItem(
      'hirearchy:r26:candidate-token:v1:sess_r214_test',
      validCandidateToken,
    );
    setupMockFetch(unknownExecutionView);

    await act(async () => {
      root?.render(
        createElement(R26CandidateClient, { sessionId: 'sess_r214_test' }),
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // UNKNOWN state badge and warning pill
    const stateBadge = container?.querySelector(
      '[data-testid="execution-state-badge"]',
    );
    expect(stateBadge?.textContent).toContain('Unknown execution status');

    const unknownWarning = container?.querySelector(
      '[data-testid="execution-unknown-warning"]',
    );
    expect(unknownWarning).not.toBeNull();
    expect(unknownWarning?.textContent).toContain('[UNKNOWN EXECUTION STATE]');

    // Failure reason pill
    const failurePill = container?.querySelector(
      '[data-testid="execution-failure-reason-pill"]',
    );
    expect(failurePill?.textContent).toContain(
      'Reason: WORKER_HEARTBEAT_TIMEOUT',
    );

    // Cleanup status: UNKNOWN
    const cleanupPill = container?.querySelector(
      '[data-testid="execution-cleanup-pill"]',
    );
    expect(cleanupPill?.textContent).toContain('Cleanup: UNKNOWN');
    expect(cleanupPill?.className).toContain('cleanup-unknown');

    // Truncated stdout indicator in console header
    const truncationNotice = container?.querySelector(
      '[data-testid="execution-truncated-notice"]',
    );
    expect(truncationNotice).not.toBeNull();
    expect(truncationNotice?.textContent).toContain(
      '[Output truncated at limit]',
    );

    // Receipt details preserve failure reason, error message, and UNKNOWN cleanup
    const receipt = container?.querySelector(
      '[data-testid="execution-receipt"]',
    );
    expect(
      receipt?.querySelector('[data-testid="receipt-failure-reason"]')
        ?.textContent,
    ).toBe('WORKER_HEARTBEAT_TIMEOUT');
    expect(
      receipt?.querySelector('[data-testid="receipt-error-message"]')
        ?.textContent,
    ).toBe('Restricted execution backend became unreachable');
    expect(
      receipt?.querySelector('[data-testid="receipt-cleanup-status"]')
        ?.textContent,
    ).toBe('UNKNOWN');
  });
});
