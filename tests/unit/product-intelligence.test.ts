import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { proxy } from '../../apps/web/proxy';
import {
  formatIntelligenceCsv,
  normalizeRoutePath,
  sanitizeFeedbackInput,
  sanitizeTelemetryEvent,
  sanitizeTelemetryProperties,
  type ProductIntelligenceReport,
} from '../../apps/web/src/telemetry/catalog';

afterEach(() => vi.unstubAllEnvs());

describe('product intelligence catalog & privacy guards', () => {
  it('normalizes routes by removing queries, UUIDs, session IDs, and candidate tokens', () => {
    expect(
      normalizeRoutePath(
        '/r23/organizations/11111111-2222-3333-4444-555555555555/builder?mode=ai&draft=abc',
      ),
    ).toBe('/r23/organizations/:id/builder');

    expect(
      normalizeRoutePath(
        '/r26/candidate/sess_8f91ab2c-3d4e-5f6a-7b8c-9d0e1f2a3b4c',
      ),
    ).toBe('/r26/candidate/:sessionId');

    expect(
      normalizeRoutePath('/candidate/AbCdEfGhIjKlMnOpQrStUvWxYz123456'),
    ).toBe('/candidate/:token');
  });

  it('strips all PII, source code, prompts, and secret keys from telemetry properties', () => {
    const cleaned = sanitizeTelemetryProperties({
      email: 'candidate@example.com',
      candidateEmail: 'secret@example.com',
      code: 'print("hello")',
      candidatePrompt: 'solve this bug',
      password: '123',
      stdout: 'secret output',
      displayName: 'Jane Doe',
      targetRole: 'Backend Engineer',
      durationMinutes: 60,
      integratedAi: true,
      nestedObject: { skipped: true },
    });

    expect(cleaned).toEqual({
      targetRole: 'Backend Engineer',
      durationMinutes: 60,
      integratedAi: true,
    });
  });

  it('validates event schema bounds and normalizes organization/session identifiers', () => {
    expect(
      sanitizeTelemetryEvent({
        eventName: 'INVALID EVENT!',
        category: 'team_funnel',
        actorType: 'team_member',
      }),
    ).toBeNull();

    const valid = sanitizeTelemetryEvent({
      eventName: 'hiring.assessment.issued',
      category: 'team_funnel',
      actorType: 'team_member',
      organizationId: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      sessionId: 'sess_1234567890',
      route:
        'https://hirearchy.test/r23/organizations/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/builder?tab=ai',
      planTier: 'ultra',
      durationMs: 421.7,
      properties: { targetRole: 'Platform Engineer', token: 'drop-me' },
    });

    expect(valid).toEqual({
      eventName: 'hiring.assessment.issued',
      category: 'team_funnel',
      actorType: 'team_member',
      organizationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      sessionId: 'sess_1234567890',
      route: '/r23/organizations/:id/builder',
      planTier: 'ultra',
      status: 'ok',
      durationMs: 422,
      properties: { targetRole: 'Platform Engineer' },
    });
  });

  it('validates micro-feedback ratings, tags, and comment bounds', () => {
    expect(
      sanitizeFeedbackInput({
        actorType: 'candidate',
        surface: 'candidate_post_submit',
        rating: 6,
      }),
    ).toBeNull();

    const parsed = sanitizeFeedbackInput({
      actorType: 'candidate',
      surface: 'candidate_post_submit',
      sessionId: 'sess_candidate_abc123',
      rating: 5,
      tags: ['Clear & realistic', 'Smooth experience'],
      comment: '  Great real-world bug hunt!  ',
      context: { email: 'never@store.me', templateId: 'reservation-moves-v3' },
    });

    expect(parsed).toEqual({
      actorType: 'candidate',
      surface: 'candidate_post_submit',
      sessionId: 'sess_candidate_abc123',
      rating: 5,
      tags: ['Clear & realistic', 'Smooth experience'],
      comment: 'Great real-world bug hunt!',
      context: { templateId: 'reservation-moves-v3' },
    });
  });

  it('exports ProductIntelligenceReport as properly escaped CSV', () => {
    const sample: ProductIntelligenceReport = {
      windowDays: 30,
      generatedAt: '2026-11-27T16:00:00.000Z',
      marketingProof: {
        totalOrganizations: 3,
        activeOrganizations: 2,
        totalSessionsIssued: 12,
        sessionsStarted: 10,
        sessionsSubmitted: 9,
        candidateStartRatePct: 83.3,
        candidateCompletionRatePct: 90,
        medianCandidateMinutes: 42.5,
        medianReviewTurnaroundHours: 4.2,
        decisionsPublished: 8,
        acceptanceRatePct: 50,
        aiAssistantEnabledPct: 25,
        candidateSatisfactionAvg: 4.6,
        candidateFairnessPositivePct: 90,
        totalCandidateFeedback: 8,
      },
      acquisitionChannels: [
        {
          source: 'github',
          medium: 'social',
          campaign: 'launch',
          visitors: 25,
          signups: 5,
          orgsCreated: 2,
          conversionRatePct: 20,
        },
      ],
      hiringFunnel: {
        orgsCreated: 2,
        assessmentsAuthored: 4,
        invitesIssued: 12,
        candidatesOpened: 11,
        candidatesStarted: 10,
        candidatesRanCode: 9,
        candidatesSubmitted: 9,
        decisionsPublished: 8,
        handoffsCompleted: 3,
      },
      assessmentHealth: [
        {
          title: 'Reservation Moves',
          sourceKind: 'template',
          targetRole: 'Backend Engineer',
          issued: 12,
          started: 10,
          submitted: 9,
          completionRatePct: 90,
          medianMinutes: 42.5,
          executionErrorRatePct: 12,
          avgCandidateRating: 4.6,
          healthFlag: 'healthy',
        },
      ],
      aiPerformance: {
        generateStarted: 5,
        generateCompleted: 5,
        generateFailed: 0,
        successRatePct: 100,
        medianLatencyMs: 6500,
        p95LatencyMs: 9200,
        problemsSaved: 4,
        aiProblemsIssued: 3,
        avgAiQualityRating: 4.5,
        aiFeedbackCount: 2,
        advisoryReviewOpened: 6,
      },
      monetization: {
        planDistribution: { none: 0, per_candidate: 1, pro: 1, ultra: 1 },
        planGateHits: 2,
        upgradePageVisits: 4,
        planUpgrades: 1,
        slotAddons: 1,
      },
      uxFriction: {
        topErrors: [],
        topRoutes: [{ route: '/r23/organizations/:id/candidates', views: 20 }],
        themeSplit: { light: 14, dark: 6 },
        clientErrorCount: 0,
        p95ApiDurationMs: 120,
      },
      recentFeedback: [
        {
          id: 'fb-1',
          createdAt: '2026-11-27T15:00:00.000Z',
          actorType: 'candidate',
          surface: 'candidate_post_submit',
          rating: 5,
          tags: ['Clear & realistic'],
          comment: 'Smooth, crisp workspace',
          context: {},
        },
      ],
    };

    const csv = formatIntelligenceCsv(sample);
    expect(csv).toContain('section,metric_or_item,dimension,value,extra');
    expect(csv).toContain('marketing_proof,candidateCompletionRatePct,,90,');
    expect(csv).toContain(
      'acquisition_channel,github/social,launch,25,signups=5;orgs=2;conv=20%',
    );
    expect(csv).toContain(
      'product_feedback,candidate_post_submit,candidate,5,"tags=Clear & realistic;comment=Smooth, crisp workspace"',
    );
  });

  it('enforces proxy gating for telemetry, feedback, and founder-only intelligence routes', () => {
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'staging-authenticated');
    vi.stubEnv('HIREARCHY_HIRING_PLATFORM_ENABLED', 'true');

    expect(
      proxy(
        new NextRequest('http://localhost/api/telemetry', { method: 'POST' }),
      ).headers.get('x-middleware-next'),
    ).toBe('1');
    expect(
      proxy(
        new NextRequest('http://localhost/api/feedback', { method: 'POST' }),
      ).headers.get('x-middleware-next'),
    ).toBe('1');

    // Intelligence UI & API must remain blocked in standard authenticated staging
    expect(
      proxy(new NextRequest('http://localhost/r23/intelligence')).status,
    ).toBe(503);
    expect(
      proxy(new NextRequest('http://localhost/api/intelligence')).status,
    ).toBe(503);

    // Allowed when Founder UAT runtime is properly configured
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'founder-uat');
    vi.stubEnv('FOUNDER_UAT_APP_ORIGIN', 'http://127.0.0.1:3310');
    vi.stubEnv('FOUNDER_UAT_MAILPIT_API_URL', 'http://127.0.0.1:8036');
    vi.stubEnv('STAGING_PUBLIC_ORIGIN', 'http://127.0.0.1:3310');
    vi.stubEnv('STAGING_AUTH_URL', 'http://127.0.0.1:9997');
    vi.stubEnv('STAGING_AUTH_ISSUER', 'http://127.0.0.1:9997');
    vi.stubEnv('STAGING_AUTH_AUDIENCE', 'authenticated');
    vi.stubEnv(
      'STAGING_DATABASE_URL',
      'postgres://r23_gateway:local-test@127.0.0.1:5432/postgres',
    );
    vi.stubEnv('STAGING_PROOF_ISSUER', 'hirearchy-founder-uat');
    vi.stubEnv('STAGING_PROOF_AUDIENCE', 'hirearchy-postgres');
    vi.stubEnv('STAGING_PROOF_KEY_ID', '00000000-0000-4000-8000-000000000000');
    vi.stubEnv('STAGING_PROOF_PRIVATE_KEY', 'server-validates-this-key');

    expect(
      proxy(new NextRequest('http://localhost/r23/intelligence')).headers.get(
        'x-middleware-next',
      ),
    ).toBe('1');
    expect(
      proxy(new NextRequest('http://localhost/api/intelligence')).headers.get(
        'x-middleware-next',
      ),
    ).toBe('1');
  });
});
