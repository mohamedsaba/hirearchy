// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskAssessmentReport } from '../../apps/web/app/evaluator/sessions/[sessionId]/task-assessment-report';

const report = (status: 'available' | 'unavailable') => ({
  status,
  rubric: {
    version: 'task-rubric-v1',
    criteria: [
      {
        id: 'behavior',
        label: 'Behavior',
        description: 'Implements the required behavior.',
        weight: status === 'available' ? 50 : 100,
        applicability: { kind: 'always', rule: 'Always applies.' },
      },
      ...(status === 'available'
        ? [
            {
              id: 'verification',
              label: 'Verification',
              description: 'Checks the submitted behavior.',
              weight: 50,
              applicability: { kind: 'always', rule: 'Always applies.' },
            },
          ]
        : []),
    ],
  },
  totalScore: status === 'available' ? 78 : null,
  applicableWeight: status === 'available' ? 100 : null,
  scoredWeight: status === 'available' ? 100 : null,
  providerId: null,
  model: null,
  analyzedAt: null,
  criteria:
    status === 'available'
      ? [
          {
            criterionId: 'behavior',
            status: 'scored',
            score: 78,
            reason: 'Recorded evidence supports this assessment.',
            evidenceRefs: ['session:s-1:final-diff'],
          },
          {
            criterionId: 'verification',
            status: 'scored',
            score: 78,
            reason: 'The same source is linked for this separate criterion.',
            evidenceRefs: ['session:s-1:final-diff'],
          },
        ]
      : [],
});

const submittedState = {
  id: 'submitted-scope',
  basis: 'final_state' as const,
  evidenceRefs: ['session:s-1:final-diff'],
  wording: 'submitted_scope' as const,
  text: 'One submitted file.',
  changedPaths: ['src/example.ts'],
  fileCount: 1,
  additions: 3,
  deletions: 1,
  parsing: 'complete' as const,
  classifiedPaths: [],
};

describe('task assessment report', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(() => {
    (
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('shows honest unavailable status without a score and keeps submitted scope available', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => report('unavailable'),
    });
    await act(async () =>
      root.render(
        <TaskAssessmentReport
          sessionId="s-1"
          evidenceEntries={[]}
          submittedDiff=""
          submittedState={submittedState}
        />,
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.textContent).toContain(
      'Analysis is unavailable for this assessment.',
    );
    expect(container.textContent).not.toContain('/ 100');
    expect(container.textContent).not.toContain('78');
    expect(container.textContent).toContain('Submitted scope');
    expect(container.textContent).toContain('src/example.ts');
    expect(container.textContent).toContain(
      'Analysis details and rubric guidance',
    );
    expect(container.querySelector('.task-report-grid-sources')).toBeNull();
    expect(container.querySelector('.task-evidence-inspector')).toBeNull();
    expect(container.querySelector('.task-report-source-note')).not.toBeNull();
  });

  it('renders a score only for an available report and opens a session-authorized source on request', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => report('available'),
    });
    const evidenceEntries = [
      {
        evidenceRef: 'session:s-1:final-diff',
        sessionId: 's-1',
        role: 'final_state' as const,
        kind: 'final_diff' as const,
        chronologyOrder: null,
        firstSequence: null,
        lastSequence: null,
        rawEventIds: [],
        item: null,
      },
      {
        evidenceRef: 'session:s-2:final-diff',
        sessionId: 's-2',
        role: 'final_state' as const,
        kind: 'final_diff' as const,
        chronologyOrder: null,
        firstSequence: null,
        lastSequence: null,
        rawEventIds: [],
        item: null,
      },
    ];
    await act(async () =>
      root.render(
        <TaskAssessmentReport
          sessionId="s-1"
          evidenceEntries={evidenceEntries}
          submittedDiff="diff"
          submittedState={submittedState}
        />,
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.textContent).toContain('78 / 100');
    expect(container.querySelector('.task-total')).not.toBeNull();
    expect(container.querySelectorAll('.task-evidence-link')).toHaveLength(2);
    expect(container.querySelector('.task-report-grid-sources')).toBeNull();
    expect(
      container.querySelector<HTMLElement>('.task-evidence-inspector')?.hidden,
    ).toBe(true);
    await act(async () =>
      container
        .querySelectorAll<HTMLButtonElement>('.task-evidence-link')[1]
        ?.click(),
    );
    expect(
      container.querySelectorAll('.task-criterion-source-selected'),
    ).toHaveLength(1);
    expect(
      container.querySelector('.task-criterion-source-selected h4')
        ?.textContent,
    ).toBe('Verification');
    expect(container.textContent).toContain('Entire submitted diff');
    expect(
      container.querySelector<HTMLElement>('.task-evidence-inspector')?.hidden,
    ).toBe(false);
    expect(container.querySelector('.task-report-grid-sources')).not.toBeNull();
    expect(container.textContent).toContain('Linked to Verification.');
    expect(container.textContent).toContain(
      'Test outcomes are shown only when they were recorded separately.',
    );
    await act(async () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Close source')
        ?.click(),
    );
    expect(
      container.querySelector<HTMLElement>('.task-evidence-inspector')?.hidden,
    ).toBe(true);
    expect(container.querySelector('.task-report-grid-sources')).toBeNull();
  });
});
