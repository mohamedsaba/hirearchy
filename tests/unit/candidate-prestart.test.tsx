import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { CandidatePrestart } from '../../apps/web/app/candidate/[token]/candidate-prestart';
import type { CandidateSessionView } from '../../apps/web/src/sessions/candidate-session-view';

describe('C2 — Candidate Pre-Start Unit Tests', () => {
  const dummySessionView: CandidateSessionView = {
    id: 'session-c2-test',
    scenario: {
      id: 'scenario-001',
      title: 'Distributed Inventory Cache',
      version: '1.0.0',
      durationSeconds: 3600,
      type: 'multi_file',
      // Scenario-specific details omitted during pre-start
    },
    status: 'CREATED',
    workingContent: '',
    createdAt: '2026-09-21T10:00:00.000Z',
    activatedAt: null,
    submittedAt: null,
    durationSeconds: 3600,
    deadline: null,
    serverTime: '2026-09-21T10:00:05.000Z',
    closureReason: null,
    scenarioType: 'multi_file',
    terminalEnabled: true,
    aiCapability: { enabled: true },
  };

  // Requirement 1: CREATED initially renders pre-start entry state
  it('1. CREATED initially renders pre-start entry state', () => {
    const html = renderToStaticMarkup(
      <CandidatePrestart
        session={dummySessionView}
        uiMode="entry"
        setUiMode={() => {}}
        onStartAssessment={() => {}}
        isActivating={false}
        provisioningError={null}
        onRetryProvisioning={() => {}}
      />,
    );

    expect(html).toContain('Distributed Inventory Cache');
    expect(html).toContain('Technical Evaluation');
    expect(html).toContain('Pre-start');
    expect(html).toContain('Continue to orientation');
  });

  it('keeps pre-start copy truthful when command execution is disabled', () => {
    const session = { ...dummySessionView, terminalEnabled: false };
    const entry = renderToStaticMarkup(
      <CandidatePrestart
        session={session}
        uiMode="entry"
        setUiMode={() => {}}
        onStartAssessment={() => {}}
        isActivating={false}
        provisioningError={null}
        onRetryProvisioning={() => {}}
      />,
    );
    const orientation = renderToStaticMarkup(
      <CandidatePrestart
        session={session}
        uiMode="orientation"
        setUiMode={() => {}}
        onStartAssessment={() => {}}
        isActivating={false}
        provisioningError={null}
        onRetryProvisioning={() => {}}
      />,
    );

    expect(entry).toContain('tools available for this assessment');
    expect(entry).not.toContain('command execution console');
    expect(orientation).toContain('Commands:</strong> Not enabled');
    expect(orientation).not.toContain('Run commands and tests');
  });

  // Requirement 2: Scenario-specific assessment content is not exposed before activation
  it('2. scenario-specific assessment content is not exposed before activation', () => {
    const html = renderToStaticMarkup(
      <CandidatePrestart
        session={dummySessionView}
        uiMode="entry"
        setUiMode={() => {}}
        onStartAssessment={() => {}}
        isActivating={false}
        provisioningError={null}
        onRetryProvisioning={() => {}}
      />,
    );

    // Ensure no scenario brief, acceptance criteria, or code content leaked
    expect(html).not.toContain('Fix cache invalidation bug');
    expect(html).not.toContain('inventory/service.py');
    expect(html).not.toContain('acceptanceCriteria');
    expect(html).not.toContain('def process_order');
  });

  // Requirement 3: Duration is shown from authoritative session projection
  it('3. duration is shown from authoritative session projection', () => {
    const html = renderToStaticMarkup(
      <CandidatePrestart
        session={dummySessionView}
        uiMode="entry"
        setUiMode={() => {}}
        onStartAssessment={() => {}}
        isActivating={false}
        provisioningError={null}
        onRetryProvisioning={() => {}}
      />,
    );

    expect(html).toContain('60 minutes');
    expect(html).toContain('1 hour (60 minutes) once the assessment begins');
  });

  // Requirement 4: Orientation exposes truthful AI/tool/recording/save/submission/expiry policy
  it('4. orientation exposes truthful AI/tool/recording/save/submission/expiry policy', () => {
    const html = renderToStaticMarkup(
      <CandidatePrestart
        session={dummySessionView}
        uiMode="orientation"
        setUiMode={() => {}}
        onStartAssessment={() => {}}
        isActivating={false}
        provisioningError={null}
        onRetryProvisioning={() => {}}
      />,
    );

    // 1. Duration
    expect(html).toContain('Assessment Duration');
    expect(html).toContain('60 minutes');

    // 2. Tools
    expect(html).toContain('Available Tools');
    expect(html).toContain('File Editor');
    expect(html).toContain('Commands');
    expect(html).toContain(
      'Run commands and tests inside the assessment environment',
    );
    expect(html).toContain('Integrated AI Assistant');
    expect(html).toContain('Scenario Brief');

    // 3. AI policy
    expect(html).toContain('AI Policy');
    expect(html).toContain(
      'The integrated AI assistant is available for this assessment',
    );
    expect(html).toContain(
      'this does not establish how submitted code was written',
    );
    expect(html).toContain('responsible for the accuracy, design, and quality');
    expect(html).not.toContain('cheating');
    expect(html).not.toContain('surveillance');

    // 4. Observable activity
    expect(html).toContain('Observable Activity');
    expect(html).toContain(
      'Work performed inside the assessment environment is recorded as part of the technical assessment',
    );

    // 5. Persistence
    expect(html).toContain('Workspace Persistence');
    expect(html).toContain('Save failures are reported immediately');

    // 6. Submission & 7. Expiry
    expect(html).toContain('Submission &amp; Expiry');
    expect(html).toContain(
      'You can submit your assessment before time ends. You’ll review your submission before final confirmation',
    );
    expect(html).toContain(
      'modifications stop automatically and the assessment finalizes',
    );

    // Navigation
    expect(html).toContain('Continue to start');
    expect(html).toContain('Back to overview');
  });

  it('describes an unavailable integrated assistant without implying an AI policy', () => {
    const html = renderToStaticMarkup(
      <CandidatePrestart
        session={{ ...dummySessionView, aiCapability: { enabled: false } }}
        uiMode="orientation"
        setUiMode={() => {}}
        onStartAssessment={() => {}}
        isActivating={false}
        provisioningError={null}
        onRetryProvisioning={() => {}}
      />,
    );

    expect(html).toContain(
      'The integrated AI assistant is not available for this assessment',
    );
    expect(html).not.toContain('AI assistance is permitted');
  });

  // Requirement 6: Ready-to-start confirmation view does not start timer
  it('6. ready-to-start does not start timer', () => {
    const html = renderToStaticMarkup(
      <CandidatePrestart
        session={dummySessionView}
        uiMode="ready_to_start"
        setUiMode={() => {}}
        onStartAssessment={() => {}}
        isActivating={false}
        provisioningError={null}
        onRetryProvisioning={() => {}}
      />,
    );

    expect(html).toContain('Ready to Begin Assessment');
    expect(html).toContain('Start Assessment');
    expect(html).toContain(
      'Your assessment clock begins only when the workspace has been successfully prepared and verified',
    );
    // Ensure no running countdown or deadline exists
    expect(html).not.toContain('Time remaining');
  });

  // Requirement 7: Start cannot be double-triggered while request is in flight
  it('7. start cannot be double-triggered while request is in flight', () => {
    const html = renderToStaticMarkup(
      <CandidatePrestart
        session={dummySessionView}
        uiMode="ready_to_start"
        setUiMode={() => {}}
        onStartAssessment={() => {}}
        isActivating={true}
        provisioningError={null}
        onRetryProvisioning={() => {}}
      />,
    );

    expect(html).toContain('disabled=""');
    expect(html).toContain('Preparing environment…');
  });

  // Requirement 8: Provisioning state shows no countdown before activatedAt exists
  it('8. provisioning state shows no countdown before activatedAt exists', () => {
    const html = renderToStaticMarkup(
      <CandidatePrestart
        session={dummySessionView}
        uiMode="provisioning"
        setUiMode={() => {}}
        onStartAssessment={() => {}}
        isActivating={false}
        provisioningError={null}
        onRetryProvisioning={() => {}}
      />,
    );

    expect(html).toContain('Preparing your assessment environment…');
    expect(html).toContain('Your assessment timer has not started');
    expect(html).not.toContain('Time remaining');
    expect(html).not.toContain('00:');
  });

  // Requirement 12: Provisioning failure is presented as platform failure
  it('12. provisioning failure is presented as platform failure', () => {
    const html = renderToStaticMarkup(
      <CandidatePrestart
        session={dummySessionView}
        uiMode="ready_to_start"
        setUiMode={() => {}}
        onStartAssessment={() => {}}
        isActivating={false}
        provisioningError="Failed to create session workspace volume."
        onRetryProvisioning={() => {}}
      />,
    );

    expect(html).toContain('Environment Setup Incomplete');
    expect(html).toContain(
      'The assessment environment could not be prepared at this time',
    );
    expect(html).toContain('Your assessment timer has not started');
    expect(html).toContain('Failed to create session workspace volume.');
    expect(html).toContain('Retry preparation');
    // Never blames candidate
    expect(html).not.toContain('You failed');
    expect(html).not.toContain('Candidate error');
  });

  // Requirement 22: Primary pre-start flow is keyboard-operable
  it('22. primary pre-start flow is keyboard-operable', () => {
    const onSetMode = vi.fn();
    const onStart = vi.fn();

    const entryHtml = renderToStaticMarkup(
      <CandidatePrestart
        session={dummySessionView}
        uiMode="entry"
        setUiMode={onSetMode}
        onStartAssessment={onStart}
        isActivating={false}
        provisioningError={null}
        onRetryProvisioning={() => {}}
      />,
    );
    expect(entryHtml).toContain(
      '<button type="button" class="button button-primary">Continue to orientation</button>',
    );

    const orientationHtml = renderToStaticMarkup(
      <CandidatePrestart
        session={dummySessionView}
        uiMode="orientation"
        setUiMode={onSetMode}
        onStartAssessment={onStart}
        isActivating={false}
        provisioningError={null}
        onRetryProvisioning={() => {}}
      />,
    );
    expect(orientationHtml).toContain(
      '<button type="button" class="button button-primary">Continue to start</button>',
    );
    expect(orientationHtml).toContain(
      '<button type="button" class="button button-secondary">Back to overview</button>',
    );

    const readyHtml = renderToStaticMarkup(
      <CandidatePrestart
        session={dummySessionView}
        uiMode="ready_to_start"
        setUiMode={onSetMode}
        onStartAssessment={onStart}
        isActivating={false}
        provisioningError={null}
        onRetryProvisioning={() => {}}
      />,
    );
    expect(readyHtml).toContain(
      '<button type="button" class="button button-primary">Start Assessment</button>',
    );
    expect(readyHtml).toContain(
      '<button type="button" class="button button-secondary">Back to orientation</button>',
    );
  });

  // Requirement 23: Provisioning state has meaningful accessible status semantics
  it('23. provisioning state has meaningful accessible status semantics', () => {
    const html = renderToStaticMarkup(
      <CandidatePrestart
        session={dummySessionView}
        uiMode="provisioning"
        setUiMode={() => {}}
        onStartAssessment={() => {}}
        isActivating={true}
        provisioningError={null}
        onRetryProvisioning={() => {}}
      />,
    );

    // Live region and semantic markup
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-labelledby="prestart-title"');
    expect(html).toContain('id="prestart-title"');
  });
});
