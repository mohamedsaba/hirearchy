import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import HomePage from '../../apps/web/app/page';
import SoftwarePage from '../../apps/web/app/products/software/page';
import TrustPage from '../../apps/web/app/trust/page';
import {
  MarketingProofStrip,
  PROOF_THRESHOLDS,
  resolveProofStrip,
  type MarketingProofPayload,
} from '../../apps/web/app/_components/marketing-proof-strip';
import {
  DEFAULT_ROI_INPUTS,
  RoiCalculator,
  calculateEngineeringRoi,
  clampRoiInputs,
  recommendPlanTierForVolume,
} from '../../apps/web/app/_components/roi-calculator';
import {
  PAID_PLAN_ORDER,
  PLAN_CATALOG,
  formatPlanBadge,
  getRequiredPlanForFeature,
  hasPlanFeature,
} from '../../apps/web/src/plans/entitlements';

describe('Engineering ROI calculator math & tier mapping', () => {
  it('computes default reclaimed hours, value, onsite savings, and Pro recommendation', () => {
    const result = calculateEngineeringRoi(DEFAULT_ROI_INPUTS);
    expect(result.totalAssessments).toBe(48);
    expect(result.hoursReclaimed).toBe(120);
    expect(result.engineeringWeeksEquivalent).toBe(3);
    expect(result.reclaimedValueUsd).toBe(13200);
    expect(result.onsiteHoursAvoided).toBe(58);
    expect(result.recommendedTier).toBe('pro');
    expect(result.tierName).toBe('Pro');
  });

  it('maps assessment volume strictly across Per Candidate (<=15), Pro (16-60), and Ultra (>60)', () => {
    expect(recommendPlanTierForVolume(1)).toBe('per_candidate');
    expect(recommendPlanTierForVolume(15)).toBe('per_candidate');
    expect(recommendPlanTierForVolume(16)).toBe('pro');
    expect(recommendPlanTierForVolume(60)).toBe('pro');
    expect(recommendPlanTierForVolume(61)).toBe('ultra');

    expect(
      calculateEngineeringRoi({
        targetHires: 3,
        candidatesPerHire: 5,
        hoursSavedPerCandidate: 2,
        hourlyCostUsd: 100,
      }).recommendedTier,
    ).toBe('per_candidate');

    expect(
      calculateEngineeringRoi({
        targetHires: 10,
        candidatesPerHire: 6,
        hoursSavedPerCandidate: 2.5,
        hourlyCostUsd: 120,
      }).recommendedTier,
    ).toBe('pro');

    expect(
      calculateEngineeringRoi({
        targetHires: 11,
        candidatesPerHire: 6,
        hoursSavedPerCandidate: 3,
        hourlyCostUsd: 130,
      }).recommendedTier,
    ).toBe('ultra');
  });

  it('clamps out-of-range inputs cleanly', () => {
    const clamped = clampRoiInputs({
      targetHires: -10,
      candidatesPerHire: 999,
      hoursSavedPerCandidate: 10,
      hourlyCostUsd: 10,
    });
    expect(clamped).toEqual({
      targetHires: 1,
      candidatesPerHire: 25,
      hoursSavedPerCandidate: 4,
      hourlyCostUsd: 60,
    });
  });

  it('renders transparent formula and tier badge in SSR markup', () => {
    const html = renderToStaticMarkup(createElement(RoiCalculator));
    expect(html).toContain('data-testid="roi-calculator"');
    expect(html).toContain('data-testid="roi-formula"');
    expect(html).toContain('data-testid="roi-tier-badge"');
    expect(html).toContain('120 hrs');
    expect(html).toContain('$13,200');
    expect(html).toContain('href="/early-access?tier=pro&amp;assessments=48"');
  });
});

describe('Marketing proof strip privacy & sample-size thresholds', () => {
  const fullLivePayload: MarketingProofPayload = {
    live: true,
    windowDays: 90,
    metrics: {
      candidateCompletionRatePct: 91.4,
      candidateFairnessPositivePct: 94.2,
      candidateSatisfactionAvg: 4.7,
      medianReviewTurnaroundHours: 5.4,
      medianCandidateMinutes: 46,
      activeOrganizations: 8,
      sessionsStarted: PROOF_THRESHOLDS.sessionsStarted,
      sessionsSubmitted: PROOF_THRESHOLDS.sessionsSubmitted,
      totalCandidateFeedback: PROOF_THRESHOLDS.totalCandidateFeedback,
      decisionsPublished: PROOF_THRESHOLDS.decisionsPublished,
    },
  };

  it('falls back to Platform design standards when payload is null or live is false', () => {
    const empty = resolveProofStrip(null, 'full');
    expect(empty.mode).toBe('benchmark');
    expect(empty.badgeLabel).toBe('Platform design standards');
    expect(empty.cards).toHaveLength(4);
    expect(empty.cards.every((c) => !c.isLive)).toBe(true);

    const gatedOff = resolveProofStrip(
      { ...fullLivePayload, live: false },
      'compact',
    );
    expect(gatedOff.mode).toBe('benchmark');
    expect(gatedOff.cards).toHaveLength(3);
    expect(gatedOff.cards.every((c) => !c.isLive)).toBe(true);
  });

  it('enforces per-metric sample thresholds even when live is true', () => {
    const belowAll = resolveProofStrip({
      live: true,
      windowDays: 90,
      metrics: {
        ...fullLivePayload.metrics,
        sessionsStarted: PROOF_THRESHOLDS.sessionsStarted - 1,
        totalCandidateFeedback: PROOF_THRESHOLDS.totalCandidateFeedback - 1,
        decisionsPublished: PROOF_THRESHOLDS.decisionsPublished - 1,
        sessionsSubmitted: PROOF_THRESHOLDS.sessionsSubmitted - 1,
      },
    });
    expect(belowAll.mode).toBe('benchmark');
    expect(belowAll.cards.every((c) => !c.isLive)).toBe(true);

    const partial = resolveProofStrip({
      live: true,
      windowDays: 90,
      metrics: {
        ...fullLivePayload.metrics,
        sessionsStarted: 30,
        totalCandidateFeedback: 8,
        decisionsPublished: 15,
        sessionsSubmitted: 10,
      },
    });
    expect(partial.mode).toBe('live');
    expect(partial.cards[0]?.isLive).toBe(true);
    expect(partial.cards[0]?.headline).toBe('91% completion');
    expect(partial.cards[1]?.isLive).toBe(false);
    expect(partial.cards[1]?.headline).toBe('Candidate-first consent');
    expect(partial.cards[2]?.isLive).toBe(true);
    expect(partial.cards[2]?.headline).toBe('5.4 hrs median');
    expect(partial.cards[3]?.isLive).toBe(false);
  });

  it('displays all live metrics when all thresholds pass', () => {
    const resolved = resolveProofStrip(fullLivePayload, 'full');
    expect(resolved.mode).toBe('live');
    expect(resolved.badgeLabel).toBe('Live network metrics (90d aggregate)');
    expect(resolved.cards.every((c) => c.isLive)).toBe(true);
    expect(resolved.cards[1]?.headline).toBe('94% rated 4–5★');
    expect(resolved.cards[3]?.headline).toBe('46 min median');
  });

  it('renders benchmark fallback cleanly on SSR before client fetch', () => {
    const html = renderToStaticMarkup(
      createElement(MarketingProofStrip, { variant: 'full' }),
    );
    expect(html).toContain('Platform design standards');
    expect(html).toContain('Designed for &gt;90% completion');
  });
});

describe('PLAN_CATALOG value-anchored copy and webhooksAndSlack capability', () => {
  it('exposes webhooksAndSlack on paid tiers only and preserves existing plan helpers', () => {
    expect(PAID_PLAN_ORDER).toEqual(['per_candidate', 'pro', 'ultra']);
    expect(hasPlanFeature('none', 'webhooksAndSlack')).toBe(false);
    expect(hasPlanFeature('per_candidate', 'webhooksAndSlack')).toBe(true);
    expect(hasPlanFeature('pro', 'webhooksAndSlack')).toBe(true);
    expect(hasPlanFeature('ultra', 'webhooksAndSlack')).toBe(true);
    expect(getRequiredPlanForFeature('webhooksAndSlack')).toBe('per_candidate');

    expect(PLAN_CATALOG.per_candidate.highlights.join(' ')).toContain(
      '<15 candidates/yr',
    );
    expect(PLAN_CATALOG.pro.highlights.join(' ')).toContain(
      'Unlimited candidate assessments',
    );
    expect(PLAN_CATALOG.ultra.highlights.join(' ')).toContain(
      'Advisory AI Candidate Review',
    );

    expect(
      formatPlanBadge({
        planTier: 'per_candidate',
        candidateCreditsPurchased: 10,
        candidateCreditsUsed: 4,
        candidateCreditsRemaining: 6,
        creditedEmails: [],
        updatedAt: null,
      }),
    ).toBe('Per Candidate · 6 slots left');
  });
});

describe('Public /trust, /products/software, and / GTM surfaces', () => {
  it('renders /trust with all four architectural trust pillars and zero forbidden scoring copy', () => {
    const html = renderToStaticMarkup(createElement(TrustPage));
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain('id="main"');
    expect(html).toContain('Skip to content');
    expect(html).toContain('candidate-data-v1');
    expect(html).toContain('ADR 0006');
    expect(html).toContain('ADR 0008');
    expect(html).toContain('docker pause');
    expect(html).toContain('FORCE ROW LEVEL SECURITY');
    expect(html).toContain('href="/demo"');
    expect(html).toContain('href="/early-access"');
    expect(html).toContain('href="/trust"');
    expect(html).not.toMatch(/candidate score|candidate ranking/i);
  });

  it('orders /products/software with proof strip, contrast table, and ROI above #demo-limits', () => {
    const html = renderToStaticMarkup(createElement(SoftwarePage));
    expect(html).toContain('Real codebase work.');
    expect(html).toContain('Zero surveillance.');
    expect(html).toContain('The Old Funnel vs. Hirearchy Software');
    expect(html).toContain('data-testid="marketing-proof-strip"');
    expect(html).toContain('data-testid="roi-calculator"');
    expect(html).toContain('data-testid="software-staging-limits"');

    const proofIdx = html.indexOf('data-testid="marketing-proof-strip"');
    const compareIdx = html.indexOf('The Old Funnel vs. Hirearchy Software');
    const roiIdx = html.indexOf('data-testid="roi-calculator"');
    const limitsIdx = html.indexOf('data-testid="software-staging-limits"');
    expect(proofIdx).toBeGreaterThan(-1);
    expect(compareIdx).toBeGreaterThan(proofIdx);
    expect(roiIdx).toBeGreaterThan(compareIdx);
    expect(limitsIdx).toBeGreaterThan(roiIdx);
  });

  it('includes Live Demo and Trust navigation links and compact proof strip on /', () => {
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html).toContain('href="/demo"');
    expect(html).toContain('href="/trust"');
    expect(html).toContain('Interactive workbench');
    expect(html).toContain('data-testid="marketing-proof-strip"');
  });
});
