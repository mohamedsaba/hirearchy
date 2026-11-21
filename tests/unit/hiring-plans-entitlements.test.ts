import { describe, expect, it } from 'vitest';

import {
  PLAN_CATALOG,
  formatPlanBadge,
  getRequiredPlanForFeature,
  hasPlanFeature,
} from '../../apps/web/src/plans/entitlements';
import {
  filterAndSortCandidates,
  groupCandidateSessions,
  type RawHiringCandidateSessionRow,
} from '../../apps/web/src/hiring/candidates-view';
import { PLATFORM_TEMPLATES } from '../../apps/web/src/hiring/templates';

describe('Organization hiring plans & entitlements', () => {
  it('enforces no free plan and keeps AI candidate review + fit report Ultra-only', () => {
    expect(PLAN_CATALOG.none.canIssueAssessments).toBe(false);
    expect(PLAN_CATALOG.per_candidate.canIssueAssessments).toBe(true);
    expect(PLAN_CATALOG.pro.canIssueAssessments).toBe(true);
    expect(PLAN_CATALOG.ultra.canIssueAssessments).toBe(true);

    expect(hasPlanFeature('none', 'aiAssessmentBuilder')).toBe(false);
    expect(hasPlanFeature('per_candidate', 'aiAssessmentBuilder')).toBe(true);
    expect(hasPlanFeature('pro', 'aiAssessmentBuilder')).toBe(true);

    expect(hasPlanFeature('per_candidate', 'aiCandidateReview')).toBe(false);
    expect(hasPlanFeature('pro', 'aiCandidateReview')).toBe(false);
    expect(hasPlanFeature('ultra', 'aiCandidateReview')).toBe(true);

    expect(hasPlanFeature('pro', 'aiPerformanceReport')).toBe(false);
    expect(hasPlanFeature('ultra', 'aiPerformanceReport')).toBe(true);
    expect(getRequiredPlanForFeature('aiCandidateReview')).toBe('ultra');
  });

  it('formats concise plan badges including remaining per-candidate slots', () => {
    expect(
      formatPlanBadge({
        planTier: 'per_candidate',
        candidateCreditsPurchased: 5,
        candidateCreditsUsed: 2,
        candidateCreditsRemaining: 3,
        creditedEmails: ['a@example.test', 'b@example.test'],
        updatedAt: null,
      }),
    ).toBe('Per Candidate · 3 slots left');

    expect(
      formatPlanBadge({
        planTier: 'ultra',
        candidateCreditsPurchased: 0,
        candidateCreditsUsed: 0,
        candidateCreditsRemaining: null,
        creditedEmails: [],
        updatedAt: null,
      }),
    ).toBe('Ultra');
  });

  it('provides 3 ready platform templates for non-manual problem authoring', () => {
    expect(PLATFORM_TEMPLATES.map((t) => t.templateId)).toEqual([
      'reservation-moves-v3',
      'webhook-dedup-v1',
      'cache-rate-limiter-v1',
    ]);
    for (const tpl of PLATFORM_TEMPLATES) {
      const built = tpl.buildDraftInput({
        durationMinutes: 45,
        integratedAi: true,
      });
      expect(built.durationMinutes).toBe(45);
      expect(built.integratedAi).toBe(true);
      expect(built.starterFiles.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('Candidate pipeline grouping, KPIs & curated filters', () => {
  const rows: RawHiringCandidateSessionRow[] = [
    {
      sessionId: 'sess_1',
      candidateEmail: 'laila@example.test',
      scenarioTitle: 'Reservation Moves',
      targetRole: 'Backend Engineer',
      experienceLevel: 'senior',
      skills: ['Python', 'Concurrency & Idempotency'],
      durationSeconds: 3600,
      lifecycleStatus: 'SUBMITTED',
      createdAt: '2026-11-18T10:00:00Z',
      submittedAt: '2026-11-18T11:00:00Z',
      issuerPrincipalId: 'p1',
      issuerName: 'Omar',
      profile: {
        candidateCode: 'HRC-1234ABCD',
        fullName: 'Laila Mansour',
        locationCountry: 'Egypt',
        locationCity: 'Cairo',
        workMode: 'remote',
        headlineRole: 'Backend Engineer',
        yearsExperience: 6,
        experienceLevel: 'senior',
        skills: ['Python', 'PostgreSQL'],
      },
    },
    {
      sessionId: 'sess_2',
      candidateEmail: 'laila@example.test',
      scenarioTitle: 'Payment Webhook Deduplication',
      targetRole: 'Backend Engineer',
      experienceLevel: 'senior',
      skills: ['Python', 'Testing & Debugging'],
      durationSeconds: 3600,
      lifecycleStatus: 'ACTIVE',
      createdAt: '2026-11-19T09:00:00Z',
      activatedAt: '2026-11-19T09:10:00Z',
      issuerPrincipalId: 'p1',
      issuerName: 'Omar',
    },
    {
      sessionId: 'sess_3',
      candidateEmail: 'karim@example.test',
      scenarioTitle: 'Cache Rate Limiter',
      targetRole: 'Full-Stack Engineer',
      experienceLevel: 'mid',
      skills: ['Python', 'Caching & Performance'],
      durationSeconds: 2700,
      lifecycleStatus: 'CREATED',
      createdAt: '2026-11-17T08:00:00Z',
      issuerPrincipalId: 'p1',
      issuerName: 'Omar',
      profile: {
        candidateCode: 'HRC-9988ZXCV',
        fullName: 'Karim Adel',
        locationCountry: 'United Arab Emirates',
        locationCity: 'Dubai',
        workMode: 'hybrid',
        headlineRole: 'Full-Stack Engineer',
        yearsExperience: 3,
        experienceLevel: 'mid',
        skills: ['TypeScript', 'React'],
      },
    },
  ];

  it('groups assessments under distinct candidate emails and merges skills', () => {
    const grouped = groupCandidateSessions(rows);
    expect(grouped).toHaveLength(2);
    const laila = grouped.find((c) => c.email === 'laila@example.test');
    expect(laila?.sessions).toHaveLength(2);
    expect(laila?.skills).toContain('PostgreSQL');
    expect(laila?.skills).toContain('Testing & Debugging');
    expect(laila?.latestPipelineStatus).toBe('in_progress');
    expect(laila?.hasAccount).toBe(true);
  });

  it('filters cleanly by location, role, experience level, and skills', () => {
    const grouped = groupCandidateSessions(rows);
    const byEgypt = filterAndSortCandidates(grouped, {
      role: 'Backend Engineer',
      status: 'all',
      experienceLevel: 'senior',
      minimumYears: 5,
      location: 'Egypt',
      skills: ['Python', 'PostgreSQL'],
      sort: 'recent',
    });
    expect(byEgypt).toHaveLength(1);
    expect(byEgypt[0]?.fullName).toBe('Laila Mansour');
  });
});
