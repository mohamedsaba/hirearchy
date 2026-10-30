import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CompactAiSummary } from '../../apps/web/app/evaluator/sessions/[sessionId]/compact-ai-summary';
import { EvidenceItemCard } from '../../apps/web/app/evaluator/sessions/[sessionId]/evidence-item-card';
import { RecordedActivity } from '../../apps/web/app/evaluator/sessions/[sessionId]/recorded-activity';
import { EvaluatorExperience } from '../../apps/web/app/evaluator/sessions/[sessionId]/evaluator-experience';
import {
  briefingDepthProfiles,
  projectBriefing,
} from '../../apps/web/src/evaluator/project-evaluator-briefing';
import { buildEvaluatorBriefing } from '../../apps/web/src/evaluator/build-evaluator-briefing';
import { buildEvidenceReferenceCatalog } from '../../apps/web/src/reconstruction/evidence-reference-catalog';
import {
  noReconstruction,
  testEvidence,
} from '../support/briefing-test-evidence';
import type {
  BriefingAiSummary,
  ObservedStatement,
} from '../../apps/web/src/evaluator/evaluator-briefing';
import type { SessionEvent } from '../../apps/web/src/events/session-event';
import type {
  ReconstructionItem,
  AiRequestStartedItem,
  AiResponseCompletedItem,
  AiRequestCancelledItem,
  AiRequestFailedItem,
  CommandExecutionItem,
} from '../../apps/web/src/evidence/chronological-reconstruction';

const dummyEvent: SessionEvent = {
  id: 'evt-dummy',
  sessionId: 'briefing-test',
  sequence: 1,
  type: 'AI_REQUEST_STARTED',
  timestamp: '2026-09-17T10:00:00.000Z',
  source: 'server',
  payload: {
    interactionId: 'int-dummy',
    clientRequestId: 'req-dummy',
    configuredProviderId: 'mock-provider',
    configuredModelId: 'claude-3-5-sonnet',
    candidateInputExcerpt: '',
    candidateInputBytes: 0,
  },
};

const mockReview: EvaluatorReviewPresentation = {
  session: {
    id: 'briefing-test',
    assessment: 'scenario · v1',
    scenarioTitle: 'Scenario',
    scenarioVersion: '1',
    status: 'Submitted',
    duration: '15m 00s',
    submittedAt: '2026-09-17T10:15:00.000Z',
    closureReason: 'candidate_submission',
  },
  scenario: {
    context: {
      schemaVersion: 1,
      version: '1',
      purpose: 'Organize the recorded evidence for review.',
      evidenceAreas: [],
      systemInvariants: ['System invariants remain authoritative.'],
      verificationTargets: ['Verification target'],
      interpretationWarnings: ['Do not infer intent.'],
      reviewPolicy: ['Evaluator makes final verdict.'],
    },
    relatedEvidence: [],
    finalVerification: {
      hasRecordedRuns: true,
      lastRun: {
        command: 'pytest',
        exitCode: 0,
        summary: 'All tests passed',
        timestamp: '2026-09-17T10:14:00.000Z',
      },
      allRunsPassed: true,
      totalRuns: 1,
    },
  },
  chronology: [],
  submittedDiff: '',
  evidenceEntries: [],
};

const baseAiSummary: BriefingAiSummary = {
  capabilityState: 'active',
  totalInteractions: 3,
  completedCount: 3,
  cancelledCount: 0,
  failedCount: 0,
  interleaved: true,
  summaryText: '3 AI interactions were recorded (3 completed) across 15m 00s.',
  providerInterruptionNotice: null,
  configuredProviderId: 'anthropic',
  configuredModelId: 'claude-3-5-sonnet',
};

const defaultBriefing = buildEvaluatorBriefing(
  testEvidence([]),
  noReconstruction,
);
const getDepth = (role: Parameters<typeof projectBriefing>[1]) =>
  projectBriefing(defaultBriefing, role).defaultDepth;

describe('Slice 6E — Evaluator AI Evidence Presentation Rendering', () => {
  describe('CompactAiSummary component', () => {
    it('renders active summary with interaction counts and interleaving notes', () => {
      const depth = getDepth('ENGINEER');
      const html = renderToStaticMarkup(
        <CompactAiSummary
          summary={baseAiSummary}
          showConfiguredModel={depth.aiConfiguredModel}
          showInterleaving={depth.technicalFootprint}
        />,
      );

      expect(html).toContain('AI capability');
      expect(html).toContain('3 AI interactions were recorded');
      expect(html).toContain(
        'Recorded AI activity was interleaved with terminal commands and workspace changes.',
      );
      expect(html).toContain('claude-3-5-sonnet');
      // Calm, non-dominant tone
      expect(html).not.toContain('🤖');
      expect(html).not.toContain('ai-badge-glowing');
    });

    it('hides model and provider details based on role depth presentation controls', () => {
      const generalistDepth = getDepth('GENERALIST_RECRUITER');
      const htmlGeneralist = renderToStaticMarkup(
        <CompactAiSummary
          summary={{
            ...baseAiSummary,
            configuredModelId: null,
            configuredProviderId: null,
          }}
          showConfiguredModel={generalistDepth.aiConfiguredModel}
          showInterleaving={generalistDepth.technicalFootprint}
        />,
      );

      expect(htmlGeneralist).toContain('AI capability');
      expect(htmlGeneralist).toContain('3 AI interactions were recorded');
      expect(htmlGeneralist).not.toContain('Model:');
    });

    it('renders zero interactions state neutrally without negative judgment', () => {
      const depth = getDepth('TECHNICAL_RECRUITER');
      const zeroSummary: BriefingAiSummary = {
        capabilityState: 'active',
        totalInteractions: 0,
        completedCount: 0,
        cancelledCount: 0,
        failedCount: 0,
        interleaved: false,
        summaryText:
          'AI capability was active for this assessment. No integrated AI interactions were recorded.',
        providerInterruptionNotice: null,
        configuredProviderId: 'anthropic',
        configuredModelId: 'claude-3-5-sonnet',
      };

      const html = renderToStaticMarkup(
        <CompactAiSummary
          summary={zeroSummary}
          showConfiguredModel={depth.aiConfiguredModel}
          showInterleaving={depth.technicalFootprint}
        />,
      );

      expect(html).toContain(
        'AI capability was active for this assessment. No integrated AI interactions were recorded.',
      );
      // Must not accuse candidate or infer intent
      expect(html).not.toContain('Candidate failed to use AI');
      expect(html).not.toContain('Candidate did not use AI');
    });

    it('renders disabled state clearly and neutrally', () => {
      const depth = getDepth('ENGINEERING_MANAGER');
      const disabledSummary: BriefingAiSummary = {
        capabilityState: 'disabled',
        totalInteractions: 0,
        completedCount: 0,
        cancelledCount: 0,
        failedCount: 0,
        interleaved: false,
        summaryText: 'Integrated AI was not enabled for this assessment.',
        providerInterruptionNotice: null,
        configuredProviderId: null,
        configuredModelId: null,
      };

      const html = renderToStaticMarkup(
        <CompactAiSummary
          summary={disabledSummary}
          showConfiguredModel={depth.aiConfiguredModel}
          showInterleaving={depth.technicalFootprint}
        />,
      );

      expect(html).toContain(
        'Integrated AI was not enabled for this assessment.',
      );
    });

    it('renders legacy state for pre-6D sessions', () => {
      const depth = getDepth('GENERALIST_RECRUITER');
      const legacySummary: BriefingAiSummary = {
        capabilityState: 'legacy',
        totalInteractions: 0,
        completedCount: 0,
        cancelledCount: 0,
        failedCount: 0,
        interleaved: false,
        summaryText: 'AI capability was not recorded for this session.',
        providerInterruptionNotice: null,
        configuredProviderId: null,
        configuredModelId: null,
      };

      const html = renderToStaticMarkup(
        <CompactAiSummary
          summary={legacySummary}
          showConfiguredModel={depth.aiConfiguredModel}
          showInterleaving={depth.technicalFootprint}
        />,
      );

      expect(html).toContain(
        'AI capability was not recorded for this session.',
      );
      expect(html).toContain('AI capture');
    });

    it('surfaces interruption notices with platform attribution', () => {
      const depth = getDepth('ENGINEER');
      const failedSummary: BriefingAiSummary = {
        ...baseAiSummary,
        failedCount: 1,
        cancelledCount: 1,
        providerInterruptionNotice:
          '1 provider error or timeout occurred (external platform event).',
      };

      const html = renderToStaticMarkup(
        <CompactAiSummary
          summary={failedSummary}
          showConfiguredModel={depth.aiConfiguredModel}
          showInterleaving={depth.technicalFootprint}
        />,
      );

      expect(html).toContain(
        '1 provider error or timeout occurred (external platform event).',
      );
    });
  });

  describe('EvidenceItemCard AI milestone items', () => {
    it('renders AI_REQUEST_STARTED with prompt excerpt collapsed by default and disclosed on affordance', () => {
      const requestItem: AiRequestStartedItem = {
        kind: 'AI_REQUEST_STARTED',
        timestamp: '2026-09-17T10:00:00.000Z',
        sequence: 1,
        rawEventId: 'evt-start-1',
        interactionId: 'int-1234',
        configuredModelId: 'claude-3-5-sonnet',
        configuredProviderId: 'anthropic',
        candidateInputExcerpt:
          'How do I optimize the database query for cache hits?',
        candidateInputBytes: 54,
        contextAttachmentsCount: 1,
        rawEvent: dummyEvent,
      };

      // When rendered for Engineer in default timeline state (collapsed excerpt)
      const engineerDefaultHtml = renderToStaticMarkup(
        <EvidenceItemCard
          item={requestItem}
          showConfiguredModel={true}
          showTokenTelemetry={true}
          showTechnicalDetails={true}
        />,
      );

      expect(engineerDefaultHtml).toContain('AI request');
      expect(engineerDefaultHtml).toContain('claude-3-5-sonnet');
      expect(engineerDefaultHtml).toContain('54 bytes');
      expect(engineerDefaultHtml).not.toContain(
        'How do I optimize the database query for cache hits?',
      );
      expect(engineerDefaultHtml).toContain('View prompt excerpt');
      expect(engineerDefaultHtml).toContain('aria-expanded="false"');
      expect(engineerDefaultHtml).toContain('1 context attachment included');
      expect(engineerDefaultHtml).toContain('Provider: anthropic');

      // After disclosure
      const engineerDisclosedHtml = renderToStaticMarkup(
        <EvidenceItemCard
          item={requestItem}
          showConfiguredModel={true}
          showTokenTelemetry={true}
          showTechnicalDetails={true}
          defaultExpanded={true}
        />,
      );

      expect(engineerDisclosedHtml).toContain(
        'How do I optimize the database query for cache hits?',
      );
      expect(engineerDisclosedHtml).toContain('Hide prompt excerpt');
      expect(engineerDisclosedHtml).toContain('aria-expanded="true"');

      // When rendered for Generalist Recruiter (model suppressed, tokens / technical details hidden, excerpt collapsed)
      const generalistDefaultHtml = renderToStaticMarkup(
        <EvidenceItemCard
          item={requestItem}
          showConfiguredModel={false}
          showTokenTelemetry={false}
          showTechnicalDetails={false}
        />,
      );

      expect(generalistDefaultHtml).toContain('AI request');
      expect(generalistDefaultHtml).toContain('An AI request was recorded.');
      expect(generalistDefaultHtml).not.toContain('claude-3-5-sonnet');
      expect(generalistDefaultHtml).not.toContain(
        'How do I optimize the database query for cache hits?',
      );
      expect(generalistDefaultHtml).toContain('View prompt excerpt');
      expect(generalistDefaultHtml).not.toContain('Provider: anthropic');
      expect(generalistDefaultHtml).not.toContain('Sequence: #1');

      // Generalist disclosed
      const generalistDisclosedHtml = renderToStaticMarkup(
        <EvidenceItemCard
          item={requestItem}
          showConfiguredModel={false}
          showTokenTelemetry={false}
          showTechnicalDetails={false}
          defaultExpanded={true}
        />,
      );
      expect(generalistDisclosedHtml).toContain(
        'How do I optimize the database query for cache hits?',
      );
    });

    it('renders AI_RESPONSE_COMPLETED with duration and token breakdown, excerpt collapsed by default', () => {
      const responseItem: AiResponseCompletedItem = {
        kind: 'AI_RESPONSE_COMPLETED',
        timestamp: '2026-09-17T10:00:02.500Z',
        sequence: 2,
        rawEventId: 'evt-complete-1',
        interactionId: 'int-1234',
        durationMs: 2500,
        reportedModelId: 'claude-3-5-sonnet',
        responseExcerpt:
          'To optimize the query, add an index on (org_id, status).',
        responseBytes: 57,
        tokenUsage: {
          promptTokens: 120,
          completionTokens: 45,
          totalTokens: 165,
        },
        rawEvent: dummyEvent,
      };

      // Default engineer card: excerpt hidden, duration and tokens visible
      const engineerDefaultHtml = renderToStaticMarkup(
        <EvidenceItemCard
          item={responseItem}
          showConfiguredModel={true}
          showTokenTelemetry={true}
          showTechnicalDetails={true}
        />,
      );

      expect(engineerDefaultHtml).toContain('AI response');
      expect(engineerDefaultHtml).toContain('Duration: 2.5s');
      expect(engineerDefaultHtml).toContain('claude-3-5-sonnet');
      expect(engineerDefaultHtml).not.toContain(
        'To optimize the query, add an index on (org_id, status).',
      );
      expect(engineerDefaultHtml).toContain('View response excerpt');
      expect(engineerDefaultHtml).toContain('aria-expanded="false"');
      expect(engineerDefaultHtml).toContain(
        '165 total (120 prompt · 45 completion)',
      );

      // Disclosed engineer card: response excerpt visible
      const engineerDisclosedHtml = renderToStaticMarkup(
        <EvidenceItemCard
          item={responseItem}
          showConfiguredModel={true}
          showTokenTelemetry={true}
          showTechnicalDetails={true}
          defaultExpanded={true}
        />,
      );

      expect(engineerDisclosedHtml).toContain(
        'To optimize the query, add an index on (org_id, status).',
      );
      expect(engineerDisclosedHtml).toContain('Hide response excerpt');
      expect(engineerDisclosedHtml).toContain('aria-expanded="true"');

      // Technical recruiter: duration visible, token telemetry hidden, excerpt collapsed
      const techRecruiterHtml = renderToStaticMarkup(
        <EvidenceItemCard
          item={responseItem}
          showConfiguredModel={true}
          showTokenTelemetry={false}
          showTechnicalDetails={false}
        />,
      );

      expect(techRecruiterHtml).toContain('Duration: 2.5s');
      expect(techRecruiterHtml).not.toContain('165 total');
      expect(techRecruiterHtml).not.toContain(
        'To optimize the query, add an index on (org_id, status).',
      );
      expect(techRecruiterHtml).toContain('View response excerpt');
    });

    it('verifies prompt and response excerpts are collapsed by default across all four role profiles', () => {
      const requestItem: AiRequestStartedItem = {
        kind: 'AI_REQUEST_STARTED',
        timestamp: '2026-09-17T10:00:00.000Z',
        sequence: 1,
        rawEventId: 'evt-start-1',
        interactionId: 'int-1234',
        configuredModelId: 'claude-3-5-sonnet',
        configuredProviderId: 'anthropic',
        candidateInputExcerpt: 'Candidate secret prompt',
        candidateInputBytes: 23,
        contextAttachmentsCount: 0,
        rawEvent: dummyEvent,
      };
      const responseItem: AiResponseCompletedItem = {
        kind: 'AI_RESPONSE_COMPLETED',
        timestamp: '2026-09-17T10:00:02.000Z',
        sequence: 2,
        rawEventId: 'evt-complete-1',
        interactionId: 'int-1234',
        durationMs: 2000,
        reportedModelId: 'claude-3-5-sonnet',
        responseExcerpt: 'Provider secret answer',
        responseBytes: 22,
        rawEvent: dummyEvent,
      };

      for (const role of briefingDepthProfiles) {
        const d = getDepth(role);
        const reqHtml = renderToStaticMarkup(
          <EvidenceItemCard
            item={requestItem}
            showConfiguredModel={d.aiConfiguredModel}
            showTokenTelemetry={d.aiTokenTelemetry}
            showTechnicalDetails={d.technicalFootprint}
          />,
        );
        expect(reqHtml).not.toContain('Candidate secret prompt');
        expect(reqHtml).toContain('View prompt excerpt');

        const respHtml = renderToStaticMarkup(
          <EvidenceItemCard
            item={responseItem}
            showConfiguredModel={d.aiConfiguredModel}
            showTokenTelemetry={d.aiTokenTelemetry}
            showTechnicalDetails={d.technicalFootprint}
          />,
        );
        expect(respHtml).not.toContain('Provider secret answer');
        expect(respHtml).toContain('View response excerpt');

        // And after disclosure, both are visible
        const reqDisclosed = renderToStaticMarkup(
          <EvidenceItemCard
            item={requestItem}
            showConfiguredModel={d.aiConfiguredModel}
            showTokenTelemetry={d.aiTokenTelemetry}
            showTechnicalDetails={d.technicalFootprint}
            defaultExpanded={true}
          />,
        );
        expect(reqDisclosed).toContain('Candidate secret prompt');

        const respDisclosed = renderToStaticMarkup(
          <EvidenceItemCard
            item={responseItem}
            showConfiguredModel={d.aiConfiguredModel}
            showTokenTelemetry={d.aiTokenTelemetry}
            showTechnicalDetails={d.technicalFootprint}
            defaultExpanded={true}
          />,
        );
        expect(respDisclosed).toContain('Provider secret answer');
      }
    });

    it('renders AI_REQUEST_CANCELLED with candidate attribution', () => {
      const cancelItem: AiRequestCancelledItem = {
        kind: 'AI_REQUEST_CANCELLED',
        timestamp: '2026-09-17T10:00:01.200Z',
        sequence: 3,
        rawEventId: 'evt-cancel-1',
        interactionId: 'int-1235',
        durationMs: 1200,
        cancelReason: 'candidate_requested_cancel',
        rawEvent: dummyEvent,
      };

      const html = renderToStaticMarkup(
        <EvidenceItemCard
          item={cancelItem}
          showTokenTelemetry={true}
          showTechnicalDetails={true}
        />,
      );

      expect(html).toContain('AI cancellation');
      expect(html).toContain(
        'Candidate requested cancellation of the AI request.',
      );
      expect(html).toContain('Elapsed before cancellation: 1.2s');
    });

    it('renders AI_REQUEST_FAILED with platform failure attribution', () => {
      const failItem: AiRequestFailedItem = {
        kind: 'AI_REQUEST_FAILED',
        timestamp: '2026-09-17T10:00:30.000Z',
        sequence: 4,
        rawEventId: 'evt-fail-1',
        interactionId: 'int-1236',
        durationMs: 30000,
        failureReason: 'timeout',
        errorMessageExcerpt: 'Gateway timeout from upstream provider',
        rawEvent: dummyEvent,
      };

      const html = renderToStaticMarkup(
        <EvidenceItemCard
          item={failItem}
          showTokenTelemetry={true}
          showTechnicalDetails={true}
        />,
      );

      expect(html).toContain('AI timeout');
      expect(html).toContain(
        'The AI request timed out at the provider boundary.',
      );
      expect(html).toContain('Gateway timeout from upstream provider');
      expect(html).toContain('Elapsed before failure: 30.0s');
    });
  });

  describe('RecordedActivity burst grouping and interleaving', () => {
    const createCompletePair = (
      intId: string,
      time1: string,
      time2: string,
      durationMs: number,
      seqStart = 1,
    ): [AiRequestStartedItem, AiResponseCompletedItem] => [
      {
        kind: 'AI_REQUEST_STARTED',
        timestamp: time1,
        sequence: seqStart,
        rawEventId: `evt-${intId}-start`,
        interactionId: intId,
        configuredModelId: 'claude-3-5-sonnet',
        configuredProviderId: 'anthropic',
        candidateInputExcerpt: `Prompt for ${intId}`,
        candidateInputBytes: 20,
        contextAttachmentsCount: 0,
        rawEvent: dummyEvent,
      },
      {
        kind: 'AI_RESPONSE_COMPLETED',
        timestamp: time2,
        sequence: seqStart + 1,
        rawEventId: `evt-${intId}-complete`,
        interactionId: intId,
        durationMs,
        reportedModelId: 'claude-3-5-sonnet',
        responseExcerpt: `Response for ${intId}`,
        responseBytes: 22,
        rawEvent: dummyEvent,
      },
    ];

    const buildActivitiesAndCatalog = (
      items: (
        AiRequestStartedItem | AiResponseCompletedItem | CommandExecutionItem
      )[],
    ) => {
      const catalog = buildEvidenceReferenceCatalog(
        'briefing-test',
        items as readonly ReconstructionItem[],
      );
      const activities: ObservedStatement[] = items.map((item, idx) => {
        const entry = catalog.entries[idx];
        const isRequest = item.kind === 'AI_REQUEST_STARTED';
        const isResponse = item.kind === 'AI_RESPONSE_COMPLETED';
        const kind = isRequest
          ? ('recorded_ai_request' as const)
          : isResponse
            ? ('recorded_ai_response' as const)
            : ('recorded_verification_execution' as const);

        return {
          id: `act-${idx}`,
          basis: 'chronology',
          evidenceRefs: [entry.evidenceRef],
          kind,
          chronologyOrder: idx + 1,
          wording: {
            template: isRequest
              ? 'An AI request was recorded.'
              : isResponse
                ? 'An AI response was recorded.'
                : 'A command was executed.',
            variables: {},
          },
          text: isRequest
            ? 'An AI request was recorded.'
            : isResponse
              ? 'An AI response was recorded.'
              : 'A command was executed.',
        };
      });

      return { activities, catalog };
    };

    it('groups 3 or more consecutive complete successful interactions into a burst accordion', () => {
      const pair1 = createCompletePair(
        'int-1',
        '2026-09-17T10:00:00.000Z',
        '2026-09-17T10:00:02.000Z',
        2000,
        1,
      );
      const pair2 = createCompletePair(
        'int-2',
        '2026-09-17T10:00:03.000Z',
        '2026-09-17T10:00:05.000Z',
        2000,
        3,
      );
      const pair3 = createCompletePair(
        'int-3',
        '2026-09-17T10:00:06.000Z',
        '2026-09-17T10:00:09.000Z',
        3000,
        5,
      );

      const items = [...pair1, ...pair2, ...pair3];
      const { activities, catalog } = buildActivitiesAndCatalog(items);

      const depth = getDepth('ENGINEER');
      const html = renderToStaticMarkup(
        <RecordedActivity
          activities={activities}
          evidenceEntries={catalog.entries}
          aiSummary={baseAiSummary}
          showDetailedTechnical={depth.technicalFootprint}
          showConfiguredModel={depth.aiConfiguredModel}
          showTokenTelemetry={depth.aiTokenTelemetry}
          activatedAt="2026-09-17T10:00:00.000Z"
        />,
      );

      // Burst group header should be rendered
      expect(html).toContain('activity-burst-group');
      expect(html).toContain('3 AI interactions recorded');
      expect(html).toContain('3 completed');
      expect(html).toContain('Expand 3 interactions');
      expect(html).toContain('aria-expanded="false"');
    });

    it('does NOT group fewer than 3 consecutive interactions (leaves individual items)', () => {
      const pair1 = createCompletePair(
        'int-1',
        '2026-09-17T10:00:00.000Z',
        '2026-09-17T10:00:02.000Z',
        2000,
        1,
      );
      const pair2 = createCompletePair(
        'int-2',
        '2026-09-17T10:00:03.000Z',
        '2026-09-17T10:00:05.000Z',
        2000,
        3,
      );

      const items = [...pair1, ...pair2];
      const { activities, catalog } = buildActivitiesAndCatalog(items);

      const depth = getDepth('ENGINEER');
      const html = renderToStaticMarkup(
        <RecordedActivity
          activities={activities}
          evidenceEntries={catalog.entries}
          aiSummary={baseAiSummary}
          showDetailedTechnical={depth.technicalFootprint}
          showConfiguredModel={depth.aiConfiguredModel}
          showTokenTelemetry={depth.aiTokenTelemetry}
          activatedAt="2026-09-17T10:00:00.000Z"
        />,
      );

      // No burst group
      expect(html).not.toContain('activity-burst-group');
      expect(html).not.toContain('Expand 3 interactions');
      // Both appear individually as activity items
      expect(html).toContain('activity-item-recorded_ai_request');
      expect(html).toContain('activity-item-recorded_ai_response');
    });

    it('breaks burst grouping when a command intervenes', () => {
      const pair1 = createCompletePair(
        'int-1',
        '2026-09-17T10:00:00.000Z',
        '2026-09-17T10:00:02.000Z',
        2000,
        1,
      );
      const cmdItem: CommandExecutionItem = {
        kind: 'COMMAND_EXECUTION',
        timestamp: '2026-09-17T10:00:03.000Z',
        command: 'pytest tests/',
        exitCode: 0,
        outputExcerpt: 'All passed',
        durationMs: 1500,
        commandId: 'cmd-1',
        rawStartedEventId: 'evt-cmd-start',
        rawFinishedEventId: 'evt-cmd-finish',
        sequence: 3,
        rawFinishedEvent: dummyEvent,
        rawStartedEvent: dummyEvent,
        stdoutPreview: 'All passed',
        stderrPreview: '',
        timedOut: false,
        stdoutBytes: 10,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        finishedAt: '2026-09-17T10:00:04.500Z',
      };
      const pair2 = createCompletePair(
        'int-2',
        '2026-09-17T10:00:05.000Z',
        '2026-09-17T10:00:07.000Z',
        2000,
        4,
      );
      const pair3 = createCompletePair(
        'int-3',
        '2026-09-17T10:00:08.000Z',
        '2026-09-17T10:00:10.000Z',
        2000,
        6,
      );

      const items = [...pair1, cmdItem, ...pair2, ...pair3];
      const { activities, catalog } = buildActivitiesAndCatalog(items);

      const depth = getDepth('ENGINEER');
      const html = renderToStaticMarkup(
        <RecordedActivity
          activities={activities}
          evidenceEntries={catalog.entries}
          aiSummary={baseAiSummary}
          showDetailedTechnical={depth.technicalFootprint}
          showConfiguredModel={depth.aiConfiguredModel}
          showTokenTelemetry={depth.aiTokenTelemetry}
          activatedAt="2026-09-17T10:00:00.000Z"
        />,
      );

      // pair1 has 1 interaction, pair2+pair3 has 2 interactions: neither reaches threshold of 3!
      expect(html).not.toContain('activity-burst-group');
      expect(html).not.toContain('Expand 3 interactions');
    });
  });

  describe('EvaluatorExperience integration across role depths', () => {
    const evidence = testEvidence([]);
    evidence.aiCapabilitySnapshot = {
      enabled: true,
      contractVersion: '1.0',
      configurationVersion: '1.0',
      configuredModelId: 'claude-3-5-sonnet',
      configuredProviderId: 'anthropic',
    };

    const briefingWithAi: typeof defaultBriefing = {
      ...defaultBriefing,
      aiSummary: baseAiSummary,
    };

    it.each(briefingDepthProfiles)(
      '%s starts in Summary with the three workspace modes and no private AI configuration',
      (profile) => {
        const projection = projectBriefing(briefingWithAi, profile);
        const html = renderToStaticMarkup(
          <EvaluatorExperience
            sessionId="briefing-test"
            activeRole={profile}
            projection={projection}
            review={mockReview}
            evidence={evidence}
          />,
        );

        expect(html).toContain('id="workbench-mode-summary"');
        expect(html).toContain('id="workbench-mode-evidence"');
        expect(html).toContain('id="workbench-mode-review"');
        expect(html.match(/data-workbench-mode-tab=/g)).toHaveLength(3);
        expect(html).not.toContain('AI capability');
        expect(html).not.toContain('claude-3-5-sonnet');
        expect(html).not.toContain('activity-token-telemetry');
      },
    );
  });
});
