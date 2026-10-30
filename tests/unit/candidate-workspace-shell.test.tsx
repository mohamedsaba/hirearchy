import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CandidateWorkspace } from '../../apps/web/app/candidate/[token]/candidate-workspace';
import type { CandidateSessionView } from '../../apps/web/src/sessions/candidate-session-view';

const activeSession: CandidateSessionView = {
  id: 'session-c3-test',
  scenario: {
    id: 'scenario-001',
    title: 'Distributed Inventory Cache',
    version: '1.0.0',
    type: 'single_file',
    brief: 'Correct stale inventory reads.',
    acceptanceCriteria: ['Keep cache entries current.'],
    filePath: 'inventory/service.py',
  },
  status: 'ACTIVE',
  workingContent: 'def get_inventory():\n    return []\n',
  createdAt: '2026-09-22T10:00:00.000Z',
  activatedAt: '2026-09-22T10:01:00.000Z',
  submittedAt: null,
  durationSeconds: 3600,
  deadline: '2026-09-23T10:01:00.000Z',
  serverTime: '2026-09-22T10:01:00.000Z',
  closureReason: null,
  scenarioType: 'single_file',
  terminalEnabled: true,
  aiCapability: { enabled: true },
};

describe('C3 — Candidate workspace shell', () => {
  it('renders active workspace navigation and all existing work surfaces', () => {
    const html = renderToStaticMarkup(
      <CandidateWorkspace initialSession={activeSession} token="c3-token" />,
    );

    expect(html).toContain('data-workspace-state="ACTIVE_WORKSPACE"');
    expect(html).toContain('aria-label="Workspace views"');
    expect(html).toContain('data-mobile-view="code"');
    expect(html).toContain('aria-label="Task and AI panel"');
    expect(html).toContain('Task');
    expect(html).toContain('Files');
    expect(html).toContain('Terminal');
    expect(html).toContain('AI');
    expect(html).toContain(
      'Run commands and tests inside the assessment environment.',
    );
    expect(html).toContain('Weft');
    expect(html).toContain('Time remaining');
    expect(html).toContain('Review submission');
    expect(html).not.toContain('class="workspace-timer" aria-live');
  });

  it('renders semantic command controls without terminal chrome or output live regions', () => {
    const html = renderToStaticMarkup(
      <CandidateWorkspace initialSession={activeSession} token="c5-token" />,
    );

    expect(html).toContain('aria-label="Command"');
    expect(html).toContain('>Run</button>');
    expect(html).not.toContain('Sandbox shell command');
    expect(html).not.toContain('role="log"');
  });

  it('represents current workspace destination and active file accessibly', () => {
    const html = renderToStaticMarkup(
      <CandidateWorkspace initialSession={activeSession} token="c3-token" />,
    );

    expect(html).toContain('inventory/service.py');
    expect(html).not.toContain('aria-label="Edit inventory/service.py"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-label="Workspace files"');
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain('role="status"');
    expect(html).toContain('Saved');
  });

  it('fails safely without inventing a file path when no multi-file workspace file is selected', () => {
    const scenarioWithoutFilePath = {
      ...activeSession.scenario,
      filePath: undefined,
    };
    const html = renderToStaticMarkup(
      <CandidateWorkspace
        initialSession={{
          ...activeSession,
          scenario: {
            ...scenarioWithoutFilePath,
            type: 'multi_file',
          },
          scenarioType: 'multi_file',
        }}
        token="c3-no-file-token"
      />,
    );

    expect(html).toContain('No workspace file available');
    expect(html).not.toContain('aria-label="Edit No workspace file available"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('inventory/service.py');
  });

  it('does not expose active workspace navigation after authoritative submission', () => {
    const html = renderToStaticMarkup(
      <CandidateWorkspace
        initialSession={{
          ...activeSession,
          status: 'SUBMITTED',
          submittedAt: '2026-09-22T10:30:00.000Z',
          closureReason: 'candidate_submission',
        }}
        token="c3-token"
      />,
    );

    expect(html).toContain('Assessment submitted</h1>');
    expect(html).toContain(
      'Your assessment has been submitted. Your work is final.',
    );
    expect(html).not.toContain('aria-label="Task and AI panel"');
    expect(html).not.toContain('aria-label="Workspace views"');
    expect(html).not.toContain('Review submission</button>');
    expect(html).not.toContain('class="workspace-timer');
    expect(html).not.toContain('aria-label="Command"');
    expect(html).not.toContain('candidate-ai-prompt');
  });

  it('presents projected deadline expiry without fabricating submission or clearing work surfaces', () => {
    const html = renderToStaticMarkup(
      <CandidateWorkspace
        initialSession={{
          ...activeSession,
          deadline: '2026-09-22T10:01:00.000Z',
          serverTime: '2026-09-22T10:01:00.000Z',
        }}
        token="c7-token"
      />,
    );

    expect(html).toContain('data-workspace-state="TIME_LIMIT_REACHED"');
    expect(html).toContain(
      'Time limit reached. New work is no longer accepted.',
    );
    expect(html).toContain('Time limit reached.</span>');
    expect(html).toContain('Commands');
    expect(html).toContain('Weft');
    expect(html).toContain('placeholder="Commands are unavailable"');
    expect(html).toContain('AI is unavailable.');
    expect(html).not.toContain('>Save</button>');
    expect(html).not.toContain('>Review submission</button>');
    expect(html).not.toContain('Your assessment has been submitted.');
    expect(html).not.toContain('aria-live="polite" class="workspace-timer');
  });

  it('presents durable ACTIVE finalization without reopening workspace controls', () => {
    const html = renderToStaticMarkup(
      <CandidateWorkspace
        initialSession={{
          ...activeSession,
          closureReason: 'candidate_submission',
        }}
        token="c8a-token"
      />,
    );

    expect(html).toContain('Finalizing your assessment…');
    expect(html).toContain(
      'Submission has begun. No more changes can be accepted',
    );
    expect(html).not.toContain('aria-label="Task and AI panel"');
    expect(html).not.toContain('aria-label="Workspace views"');
    expect(html).not.toContain('>Save</button>');
    expect(html).not.toContain('>Review submission</button>');
    expect(html).not.toContain('class="workspace-timer');
    expect(html).not.toContain('aria-label="Command"');
    expect(html).not.toContain('candidate-ai-prompt');
  });

  it('presents timeout completion without claiming candidate submission', () => {
    const html = renderToStaticMarkup(
      <CandidateWorkspace
        initialSession={{
          ...activeSession,
          status: 'SUBMITTED',
          submittedAt: '2026-09-22T10:30:00.000Z',
          closureReason: 'timeout',
        }}
        token="c8-timeout-token"
      />,
    );

    expect(html).toContain('Assessment time ended</h1>');
    expect(html).toContain(
      'Your assessment time ended. Your work was finalized automatically.',
    );
    expect(html).not.toContain('Assessment submitted</h1>');
    expect(html).not.toContain('aria-label="Workspace views"');
    expect(html).not.toContain('aria-label="Command"');
    expect(html).not.toContain('candidate-ai-prompt');
  });
});
