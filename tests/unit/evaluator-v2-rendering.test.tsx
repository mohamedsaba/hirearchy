import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EvaluatorHeader } from '../../apps/web/app/evaluator/sessions/[sessionId]/evaluator-header';
import { PlatformNotice } from '../../apps/web/app/evaluator/sessions/[sessionId]/platform-notice';
import { TaskBrief } from '../../apps/web/app/evaluator/sessions/[sessionId]/task-brief';
import { RecordedActivity } from '../../apps/web/app/evaluator/sessions/[sessionId]/recorded-activity';
import { SubmittedWork } from '../../apps/web/app/evaluator/sessions/[sessionId]/submitted-work';
import {
  buildEvidenceSources,
  EvidenceSourceInspector,
} from '../../apps/web/app/evaluator/sessions/[sessionId]/evidence-workbench';
import { ReviewGuidance } from '../../apps/web/app/evaluator/sessions/[sessionId]/review-guidance';
import { ArtifactAvailabilityCard } from '../../apps/web/app/evaluator/sessions/[sessionId]/artifact-availability-card';
import { EvaluatorExperience } from '../../apps/web/app/evaluator/sessions/[sessionId]/evaluator-experience';
import { projectBriefing } from '../../apps/web/src/evaluator/project-evaluator-briefing';
import type { EvaluatorBriefing } from '../../apps/web/src/evaluator/evaluator-briefing';
import type { EvaluatorReviewPresentation } from '../../apps/web/src/evaluator/evaluator-review-presentation';
import type { EvidenceCatalogEntry } from '../../apps/web/src/reconstruction/evidence-reference-catalog';

const mockBriefing: EvaluatorBriefing = {
  schemaVersion: 1,
  sessionId: 'session-c-12345678',
  scenarioVersion: '1.0.0',
  builderVersion: 'evaluator-briefing-v2',
  provenance: {
    sessionId: 'session-c-12345678',
    scenarioVersion: '1.0.0',
    authoritativeEvidenceSha256: 'a'.repeat(64),
    finalDiffSha256: 'b'.repeat(64),
    scenarioSnapshotSha256: 'c'.repeat(64),
    evaluationContextSha256: 'd'.repeat(64),
    evaluationContextVersion: '1.0.0',
    mapperVersion: 'evaluator-mapper-v2',
    wordingVersion: 'evaluator-wording-v2',
    builderVersion: 'evaluator-briefing-v2',
    projectionVersion: 'briefing-depth-v2',
    reconstruction: {
      artifactId: 'recon-1',
      generatorVersion: 'deterministic-v3',
    },
    semanticSnapshot: {
      status: 'available',
      sha256: 'e'.repeat(64),
    },
  },
  sessionDuration: {
    status: 'available',
    elapsedMs: 754000,
    text: '12m 34s',
    source: {
      authority: 'session_timestamps',
      fieldRef: 'session:session-c-12345678:duration',
      activatedAt: '2026-09-16T17:00:00.000Z',
      submittedAt: '2026-09-16T17:12:34.000Z',
    },
  },
  taskContext: [
    {
      id: 'task-brief',
      category: 'task_context',
      kind: 'task_brief',
      source: {
        authority: 'scenario_snapshot',
        fieldRef: 'brief',
        version: '1.0.0',
        sessionId: 'session-c-12345678',
      },
      authoredText: 'Investigate and resolve stale inventory cache reads.',
    },
    {
      id: 'context:systemInvariants:0',
      category: 'task_context',
      kind: 'system_invariant',
      source: {
        authority: 'evaluation_context',
        fieldRef: 'evaluationContext.systemInvariants[0]',
        version: '1.0.0',
        sessionId: 'session-c-12345678',
      },
      authoredText: 'Stock reads must reflect committed DB transactions.',
    },
    {
      id: 'context:verificationTargets:0',
      category: 'task_context',
      kind: 'verification_area',
      source: {
        authority: 'evaluation_context',
        fieldRef: 'evaluationContext.verificationTargets[0]',
        version: '1.0.0',
        sessionId: 'session-c-12345678',
      },
      authoredText: 'Storefront cache write-through or invalidation.',
    },
  ],
  observedActivity: [
    {
      id: 'act-1',
      basis: 'chronology',
      evidenceRefs: ['session:session-c-12345678:cmd-1'],
      factRef: 'fact:1',
      kind: 'recorded_verification_execution',
      scope: 'recorded_execution',
      chronologyOrder: 1,
      wording: {
        template: 'Test run: 0 passed, 3 failed.',
        variables: {},
      },
      text: 'A test execution was recorded.',
      mapping: {
        status: 'bound',
        ruleId: 'pytest_run',
        subjectId: 'pytest',
      },
    },
    {
      id: 'act-2',
      basis: 'chronology',
      evidenceRefs: ['session:session-c-12345678:edit-1'],
      factRef: 'fact:2',
      kind: 'recorded_workspace_edit',
      scope: 'recorded_workspace_transition',
      chronologyOrder: 2,
      wording: {
        template: 'Edited inventory/service.py.',
        variables: {},
      },
      text: 'Edited inventory/service.py.',
      mapping: {
        status: 'bound',
        ruleId: 'file_edit',
        subjectId: 'inventory/service.py',
      },
      paths: ['inventory/service.py'],
    },
    {
      id: 'act-3',
      basis: 'chronology',
      evidenceRefs: ['session:session-c-12345678:cmd-2'],
      factRef: 'fact:3',
      kind: 'recorded_verification_execution',
      scope: 'recorded_execution',
      chronologyOrder: 3,
      wording: {
        template: 'Test run: 0 passed, 3 failed.',
        variables: {},
      },
      text: 'A test execution was recorded.',
      mapping: {
        status: 'bound',
        ruleId: 'pytest_run',
        subjectId: 'pytest',
      },
    },
  ],
  recordedVerification: {
    runs: [
      {
        id: 'run-1',
        evidenceRefs: ['session:session-c-12345678:cmd-1'],
        chronologyOrder: 1,
        exitCode: 1,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        result: {
          id: 'res-1',
          basis: 'chronology',
          evidenceRefs: ['session:session-c-12345678:cmd-1'],
          text: 'The first recorded test run reported 3 failures.',
          wording: {
            template: '0 passed, 3 failed',
            variables: {},
          },
          kind: 'recorded_verification_result',
        },
        counts: { passed: 0, failed: 3 },
        laterWorkspaceEdits: true,
        laterCaptureGaps: false,
        testIdentity: 'unknown',
      },
      {
        id: 'run-2',
        evidenceRefs: ['session:session-c-12345678:cmd-2'],
        chronologyOrder: 3,
        exitCode: 1,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        result: {
          id: 'res-2',
          basis: 'chronology',
          evidenceRefs: ['session:session-c-12345678:cmd-2'],
          text: 'The final recorded test run reported 3 failures.',
          wording: {
            template: '0 passed, 3 failed',
            variables: {},
          },
          kind: 'recorded_verification_result',
        },
        counts: { passed: 0, failed: 3 },
        laterWorkspaceEdits: false,
        laterCaptureGaps: false,
        testIdentity: 'unknown',
      },
    ],
    scope: 'recognized_recorded_executions_only',
  },
  submittedState: {
    id: 'sub-1',
    basis: 'final_state',
    evidenceRefs: ['session:session-c-12345678:final-diff'],
    wording: {
      template: 'Modified 1 file with 5 additions and 1 deletion.',
      variables: {},
    },
    text: 'Modified 1 file with 5 additions and 1 deletion.',
    changedPaths: ['inventory/service.py'],
    fileCount: 1,
    additions: 5,
    deletions: 1,
    parsing: 'complete',
    classifiedPaths: [
      {
        path: 'inventory/service.py',
        classification: 'application',
        ruleId: 'python_service',
      },
    ],
  },
  evidenceLimitations: [],
  artifactAvailability: {
    reconstruction: 'AVAILABLE',
    briefing: 'available',
    submittedDiff: {
      status: 'available',
      evidenceRefs: ['session:session-c-12345678:final-diff'],
    },
    context: 'available',
    semantics: 'available',
    source: {
      authority: 'artifact_status',
      fieldRef: 'status',
      version: null,
    },
  },
  reviewGuidance: [
    {
      id: 'policy:0',
      category: 'static_policy_context',
      source: {
        authority: 'evaluation_context',
        fieldRef: 'evaluationContext.reviewPolicy[0]',
        version: '1.0.0',
      },
      authoredText:
        'Final automated verification alone is not a hiring decision.',
    },
  ],
  evidenceIndex: [
    {
      evidenceRef: 'session:session-c-12345678:cmd-1',
      sessionId: 'session-c-12345678',
      basis: 'chronology',
      kind: 'test_run',
      rawEventIds: ['evt_1'],
      chronologyOrder: 1,
      sourceLocator: 'events/1',
      fact: null,
      sourceData: {
        kind: 'chronology',
        item: {
          kind: 'COMMAND_EXECUTION',
          commandId: 'cmd_1',
          command: 'pytest',
          cwd: '/workspace',
          startedAt: '2026-09-16T17:01:00Z',
          finishedAt: '2026-09-16T17:01:05Z',
          durationMs: 5000,
          exitCode: 1,
          timedOut: false,
          stdoutPreview: '3 failed',
          stderrPreview: '',
          rawStartedEventId: 'evt_1',
          rawFinishedEventId: 'evt_2',
          sequence: 1,
          rawFinishedEvent: {
            id: 'evt_2',
            sessionId: 'session-c-12345678',
            sequence: 2,
            type: 'COMMAND_FINISHED',
            timestamp: '2026-09-16T17:01:05Z',
            source: 'server',
            payload: {
              commandId: 'cmd_1',
              exitCode: 1,
              timedOut: false,
              durationMs: 5000,
              stdoutPreview: '3 failed',
              stdoutBytes: 100,
              stdoutTruncated: false,
              stderrPreview: '',
              stderrBytes: 0,
              stderrTruncated: false,
            },
          },
        },
      },
    },
    {
      evidenceRef: 'session:session-c-12345678:final-diff',
      sessionId: 'session-c-12345678',
      basis: 'final_state',
      kind: 'final_diff',
      rawEventIds: [],
      chronologyOrder: null,
      sourceLocator: 'diff',
      fact: null,
      sourceData: {
        kind: 'submitted_diff',
        diff: '--- a/inventory/service.py\n+++ b/inventory/service.py\n@@ -10,3 +10,7 @@\n+    invalidate_cached_stock(product_id)\n',
      },
    },
  ],
  aiSummary: {
    capabilityState: 'active',
    configuredModelId: 'claude-3-5-sonnet',
    configuredProviderId: 'mock-provider',
    totalInteractions: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    providerInterruptionNotice: null,
    interleaved: false,
    summaryText:
      'AI capability was active for this assessment. No integrated AI interactions were recorded.',
  },
};

const mockReview: EvaluatorReviewPresentation = {
  session: {
    id: 'session-c-12345678',
    assessment: 'scenario · v1',
    scenarioTitle: 'Cache Staleness Investigation',
    scenarioVersion: '1.0.0',
    status: 'Submitted',
    duration: '12m 34s',
    submittedAt: '2026-09-16T17:12:34.000Z',
    closureReason: 'candidate_submission',
  },
  scenario: {
    context: {
      schemaVersion: 1,
      version: '1.0.0',
      purpose: 'Investigate and resolve stale inventory cache reads.',
      evidenceAreas: [],
      systemInvariants: ['Stock reads must reflect committed DB transactions.'],
      verificationTargets: ['Storefront cache write-through or invalidation.'],
      interpretationWarnings: [],
      reviewPolicy: [
        'Final automated verification alone is not a hiring decision.',
      ],
    },
    relatedEvidence: [],
  },
  notices: [],
  summary: {
    status: 'available',
    retryAllowed: false,
    milestones: [],
  },
  chronology: [],
  evidenceEntries: [
    {
      evidenceRef: 'session:session-c-12345678:cmd-1',
      sessionId: 'session-c-12345678',
      role: 'chronology',
      kind: 'command',
      chronologyOrder: 1,
      firstSequence: 1,
      lastSequence: 2,
      rawEventIds: ['evt_1', 'evt_2'],
      item: {
        kind: 'COMMAND_EXECUTION',
        commandId: 'cmd_1',
        command: 'pytest',
        cwd: '/workspace',
        startedAt: '2026-09-16T17:01:00Z',
        finishedAt: '2026-09-16T17:01:05Z',
        durationMs: 5000,
        exitCode: 1,
        timedOut: false,
        stdoutPreview: '3 failed',
        stderrPreview: '',
        rawStartedEventId: 'evt_1',
        rawFinishedEventId: 'evt_2',
        sequence: 1,
        rawFinishedEvent: {
          id: 'evt_2',
          sessionId: 'session-c-12345678',
          sequence: 2,
          type: 'COMMAND_FINISHED',
          timestamp: '2026-09-16T17:01:05Z',
          source: 'server',
          payload: {
            commandId: 'cmd_1',
            exitCode: 1,
            timedOut: false,
            durationMs: 5000,
            stdoutPreview: '3 failed',
            stdoutBytes: 100,
            stdoutTruncated: false,
            stderrPreview: '',
            stderrBytes: 0,
            stderrTruncated: false,
          },
        },
      },
    },
  ],
  submittedDiff:
    '--- a/inventory/service.py\n+++ b/inventory/service.py\n@@ -10,3 +10,7 @@\n+    invalidate_cached_stock(product_id)\n',
};

describe('Evaluator Experience V2 Component & Projection Suite', () => {
  describe('EvaluatorHeader', () => {
    it('renders the back link, session reference, scenario title, and duration without role controls', () => {
      const html = renderToStaticMarkup(
        <EvaluatorHeader
          sessionId="session-c-12345678"
          scenarioTitle="Cache Staleness Investigation"
          sessionDuration={mockBriefing.sessionDuration}
          submittedAt="2026-09-16T17:12:34.000Z"
          closureReason="candidate_submission"
        />,
      );

      expect(html).toContain('Back to reviews');
      expect(html).not.toContain('Evaluator perspective');
      expect(html).toContain('Cache Staleness Investigation');
      expect(html).toContain('12m 34s recorded');
      expect(html).toContain('Session session-…');
      expect(html).toContain('Submitted');
      expect(html).toContain('Submitted by candidate');
      // Must NOT contain scorecard, score numbers, or grade
      expect(html).not.toContain('/ 100');
      expect(html).not.toContain('Score:');
      expect(html).not.toContain('Pass/Fail');
    });

    it('renders timeout closure as a factual submission condition', () => {
      const html = renderToStaticMarkup(
        <EvaluatorHeader
          sessionId="session-c-12345678"
          scenarioTitle="Cache Staleness Investigation"
          submittedAt="2026-09-16T17:12:34.000Z"
          closureReason="timeout"
        />,
      );

      expect(html).toContain('Assessment time ended');
      expect(html).not.toContain('Submitted by candidate');
    });
  });

  describe('TaskBrief', () => {
    it('renders scenario context without capability claims', () => {
      const html = renderToStaticMarkup(
        <TaskBrief
          taskContext={mockBriefing.taskContext}
          showScenarioReference={true}
          contextAvailable={true}
        />,
      );

      expect(html).toContain('What this task was about');
      expect(html).toContain(
        'Investigate and resolve stale inventory cache reads.',
      );
      expect(html).toContain('Relevant system context');
      expect(html).toContain(
        'Stock reads must reflect committed DB transactions.',
      );
      expect(html).toContain('Relevant verification areas');
      expect(html).toContain('Storefront cache write-through or invalidation.');
    });

    it('renders Case G legacy context fallback message when context is absent', () => {
      const html = renderToStaticMarkup(
        <TaskBrief
          taskContext={mockBriefing.taskContext}
          showScenarioReference={true}
          contextAvailable={false}
        />,
      );

      expect(html).toContain(
        'Scenario evaluation context is not available for this earlier session.',
      );
      expect(html).toContain(
        'Recorded activity and submitted changes remain available.',
      );
    });
  });

  describe('PlatformNotice & Case F Coverage', () => {
    it('renders Case F platform-owned capture gap notice with authoritative copy and heading', () => {
      const limitations: EvaluatorBriefing['evidenceLimitations'] = [
        {
          id: 'lim-1',
          authority: 'evidence',
          kind: 'workspace_capture_gap',
          basis: 'chronology',
          evidenceRefs: ['session:session-c:gap'],
          wording: {
            key: 'workspace_gap',
          },
          text: 'Hirearchy Software did not capture part of the workspace history during this interval. Later recorded activity and the frozen submitted diff remain available.',
        },
      ];

      const html = renderToStaticMarkup(
        <PlatformNotice limitations={limitations} />,
      );

      expect(html).toContain('Platform and observation notices');
      expect(html).toContain('Platform recording limitation');
      expect(html).toContain('Activity capture incomplete');
      expect(html).toContain(
        'Hirearchy Software did not capture part of the workspace history during this interval. Later recorded activity and the frozen submitted diff remain available.',
      );
    });
  });

  describe('RecordedActivity', () => {
    it('renders activity feed with timeline role and items', () => {
      const html = renderToStaticMarkup(
        <RecordedActivity
          activities={mockBriefing.observedActivity}
          verification={mockBriefing.recordedVerification}
          evidenceEntries={mockReview.evidenceEntries}
          showDetailedTechnical={true}
        />,
      );

      expect(html).toContain('Session timeline');
      expect(html).toContain('What happened');
      expect(html).toContain('<ol');
      expect(html).toContain(
        'The first recorded test run reported 3 failures.',
      );
      expect(html).toContain('Edited inventory/service.py.');
      expect(html).toContain(
        'The final recorded test run reported 3 failures.',
      );
      expect(
        html.indexOf('The first recorded test run reported 3 failures.'),
      ).toBeLessThan(html.indexOf('Edited inventory/service.py.'));
      expect(html.indexOf('Edited inventory/service.py.')).toBeLessThan(
        html.indexOf('The final recorded test run reported 3 failures.'),
      );
      expect(html).not.toContain('correct solution');
    });
  });

  describe('SubmittedWork', () => {
    it('renders submitted changes header with anchor, line counts, and files', () => {
      const html = renderToStaticMarkup(
        <SubmittedWork
          submittedState={mockBriefing.submittedState}
          diff={mockReview.submittedDiff}
        />,
      );

      expect(html).toContain('id="submitted-changes"');
      expect(html).not.toContain('submitted-changes-embedded');
      expect(html).toContain('Submitted changes');
      expect(html).toContain('+5 lines');
      expect(html).toContain('−1 lines');
      expect(html).toContain('inventory/service.py');
    });

    it('renders diff behind progressive disclosure toggle when prominentDiff is false', () => {
      const html = renderToStaticMarkup(
        <SubmittedWork
          submittedState={mockBriefing.submittedState}
          diff={mockReview.submittedDiff}
          prominentDiff={false}
        />,
      );

      expect(html).toContain('submitted-diff-disclosure');
      expect(html).toContain('View submitted changes');
    });

    it('renders diff directly when prominentDiff is true', () => {
      const html = renderToStaticMarkup(
        <SubmittedWork
          submittedState={mockBriefing.submittedState}
          diff={mockReview.submittedDiff}
          prominentDiff={true}
        />,
      );

      expect(html).not.toContain('submitted-diff-disclosure');
      expect(html).not.toContain('View submitted changes');
      expect(html).toContain('submitted-diff-container');
    });
  });

  describe('ReviewGuidance', () => {
    it('renders factual policy text without a non-operational handoff action', () => {
      const html = renderToStaticMarkup(
        <ReviewGuidance guidance={mockBriefing.reviewGuidance} />,
      );

      expect(html).toContain('Review guidance');
      expect(html).toContain(
        'Final automated verification alone is not a hiring decision.',
      );
      expect(html).toContain(
        'Technical judgment remains a human evaluator decision.',
      );
      expect(html).not.toContain('Request engineering review');
      expect(html).not.toContain('disabled');
    });
  });

  describe('ArtifactAvailabilityCard', () => {
    it('renders clean status badges for Generalist Recruiter without SHA hashes', () => {
      const html = renderToStaticMarkup(
        <ArtifactAvailabilityCard
          availability={mockBriefing.artifactAvailability}
          provenance={mockBriefing.provenance}
          showTechnicalDetails={false}
        />,
      );

      expect(html).toContain('Artifact availability');
      expect(html).toContain('available');
      // No SHA-256 hashes
      expect(html).not.toContain(
        mockBriefing.provenance.authoritativeEvidenceSha256!,
      );
    });

    it('renders cryptographic SHA-256 and version provenance for Engineer', () => {
      const html = renderToStaticMarkup(
        <ArtifactAvailabilityCard
          availability={mockBriefing.artifactAvailability}
          provenance={mockBriefing.provenance}
          showTechnicalDetails={true}
        />,
      );

      expect(html).toContain('Artifact availability');
      expect(html).toContain('Evidence SHA-256');
      expect(html).toContain(
        mockBriefing.provenance.authoritativeEvidenceSha256!,
      );
      expect(html).toContain('deterministic-v3');
    });
  });

  describe('Role Projections via EvaluatorExperience', () => {
    const projectedGeneralist = projectBriefing(
      mockBriefing,
      'GENERALIST_RECRUITER',
    );
    const projectedTechnicalRecruiter = projectBriefing(
      mockBriefing,
      'TECHNICAL_RECRUITER',
    );
    const projectedEngineer = projectBriefing(mockBriefing, 'ENGINEER');
    const projectedEM = projectBriefing(mockBriefing, 'ENGINEERING_MANAGER');

    const evidence = {
      sessionId: 'session-c-12345678',
      activatedAt: '2026-09-16T17:00:00.000Z',
      submittedAt: '2026-09-16T17:12:34.000Z',
      closureReason: 'candidate_submission' as const,
      diff: mockReview.submittedDiff,
      events: [],
      scenario: {
        id: '001',
        title: 'Cache Staleness Investigation',
        version: '1.0.0',
        brief: 'Investigate and resolve stale inventory cache reads.',
        evaluationContext: {
          version: '1.0.0',
          purpose: 'Context',
          systemInvariants: ['Invariant 1'],
          verificationTargets: ['Target 1'],
          interpretationWarnings: [],
          reviewPolicy: ['Policy 1'],
        },
      },
    };

    it('embeds the full submitted diff without redundant section chrome or false missing-state claims', () => {
      const finalDiffEntry: EvidenceCatalogEntry = {
        evidenceRef: 'session:session-c-12345678:final-diff',
        sessionId: 'session-c-12345678',
        role: 'final_state',
        kind: 'final_diff',
        chronologyOrder: null,
        firstSequence: null,
        lastSequence: null,
        rawEventIds: [],
        item: null,
      };
      const reviewWithFinalDiff = {
        ...mockReview,
        evidenceEntries: [...mockReview.evidenceEntries, finalDiffEntry],
      };
      const submittedSource = buildEvidenceSources(
        reviewWithFinalDiff,
        projectedEngineer,
        [],
      ).find((source) => source.entry?.kind === 'final_diff')!;
      const embeddedHtml = renderToStaticMarkup(
        <EvidenceSourceInspector
          source={submittedSource}
          evidence={evidence}
          review={reviewWithFinalDiff}
          projection={projectedEngineer}
        />,
      );

      expect(embeddedHtml).toContain('submitted-changes-embedded');
      expect(embeddedHtml).not.toContain('id="submitted-changes-title"');
      expect(embeddedHtml).toContain('+5 lines');
      expect(embeddedHtml).toContain('−1 lines');
      expect(embeddedHtml).toContain('inventory/service.py');
      expect(embeddedHtml).toContain(
        'Server-derived changes against the immutable scenario baseline.',
      );
      expect(embeddedHtml).toContain(
        '+    invalidate_cached_stock(product_id)',
      );

      const unsupportedProjection = {
        ...projectedEngineer,
        briefing: {
          ...projectedEngineer.briefing,
          submittedState: {
            ...projectedEngineer.briefing.submittedState,
            changedPaths: [],
            fileCount: null,
            additions: null,
            deletions: null,
            parsing: 'unsupported' as const,
            text: 'The frozen submission diff is available; its file summary is unsupported.',
          },
        },
      };
      const unsupportedHtml = renderToStaticMarkup(
        <EvidenceSourceInspector
          source={submittedSource}
          evidence={evidence}
          review={reviewWithFinalDiff}
          projection={unsupportedProjection}
        />,
      );

      expect(unsupportedHtml).toContain('Submitted state available');
      expect(unsupportedHtml).toContain(
        'The frozen submission diff is available; its file summary is unsupported.',
      );
      expect(unsupportedHtml).toContain('File count unavailable');
      expect(unsupportedHtml).not.toContain('0 files');
      expect(unsupportedHtml).toContain(
        '+    invalidate_cached_stock(product_id)',
      );
    });

    it('generalist summary uses the three-mode navigation without exposing raw event IDs or hashes', () => {
      const html = renderToStaticMarkup(
        <EvaluatorExperience
          sessionId="session-c-12345678"
          projection={projectedGeneralist}
          review={mockReview}
          evidence={evidence}
        />,
      );

      expect(html).toContain('Verification progression');
      expect(html).toContain('Evidence coverage');
      expect(html).not.toContain('Evaluator perspective');
      expect(html).toContain('role="tabpanel"');
      expect(html).toContain('role="tablist"');
      expect(html).toContain('role="tab"');
      expect(html).toContain('workbench-mode-summary');
      expect(html).toContain('workbench-mode-evidence');
      expect(html).toContain('workbench-mode-review');
      // Progressive disclosure: diff behind toggle
      expect(html).toContain('Open submitted diff');
      // Technical record must NOT be mounted
      expect(html).not.toContain('Open technical chronology');
      expect(html).not.toContain('technical-record-prominent');
      // No raw event IDs
      expect(html).not.toContain('evt_');
      // No raw SHA-256 hashes
      expect(html).not.toContain(
        mockBriefing.provenance.authoritativeEvidenceSha256!,
      );
      // No synthetic invariant checks
      expect(html).not.toContain('Additional invariant checks passed');
    });

    it('Engineer: summary retains deep technical inspection behind a disclosure', () => {
      const html = renderToStaticMarkup(
        <EvaluatorExperience
          sessionId="session-c-12345678"
          activeRole="ENGINEER"
          projection={projectedEngineer}
          review={mockReview}
          evidence={evidence}
        />,
      );

      expect(html).toContain('role="tablist"');
      expect(html).toContain('workbench-mode-evidence');
      expect(html).toContain('Open submitted diff');
      expect(html).not.toContain('engineer-evidence-workspace');
      expect(html).toContain('Evidence SHA-256');
    });

    it('Technical Recruiter: technical footprint and integrated verification', () => {
      const html = renderToStaticMarkup(
        <EvaluatorExperience
          sessionId="session-c-12345678"
          activeRole="TECHNICAL_RECRUITER"
          projection={projectedTechnicalRecruiter}
          review={mockReview}
          evidence={evidence}
        />,
      );

      expect(html).toContain('Verification progression');
      expect(html).toContain('Evidence coverage');
      expect(html).toContain('role="tablist"');
      expect(html).not.toContain('View evidence');
      expect(html).not.toContain('Open technical chronology');
    });

    it('Engineering Manager: review guidance and synthesis without capability scores', () => {
      const html = renderToStaticMarkup(
        <EvaluatorExperience
          sessionId="session-c-12345678"
          activeRole="ENGINEERING_MANAGER"
          projection={projectedEM}
          review={mockReview}
          evidence={evidence}
        />,
      );

      expect(html).toContain('Review guidance');
      expect(html).not.toContain('Open technical chronology');
      expect(html).not.toContain('Candidate rank:');
      expect(html).not.toContain('Performance score:');
      expect(html).toContain('role="tabpanel"');
    });
  });
});
