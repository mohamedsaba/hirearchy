'use client';

import { useEffect, useState } from 'react';

export interface MarketingProofMetrics {
  candidateCompletionRatePct: number | null;
  candidateFairnessPositivePct: number | null;
  candidateSatisfactionAvg: number | null;
  medianReviewTurnaroundHours: number | null;
  medianCandidateMinutes: number | null;
  activeOrganizations: number;
  sessionsStarted: number;
  sessionsSubmitted: number;
  totalCandidateFeedback: number;
  decisionsPublished: number;
}

export interface MarketingProofPayload {
  live: boolean;
  windowDays: number;
  metrics: MarketingProofMetrics;
}

export interface ProofCard {
  id: 'completion' | 'fairness' | 'turnaround' | 'duration';
  label: string;
  headline: string;
  detail: string;
  isLive: boolean;
}

export interface ResolvedProofStrip {
  mode: 'live' | 'benchmark';
  badgeLabel: string;
  cards: readonly ProofCard[];
}

export const PROOF_THRESHOLDS = {
  sessionsStarted: 25,
  totalCandidateFeedback: 15,
  decisionsPublished: 15,
  sessionsSubmitted: 15,
} as const;

const BENCHMARK_CARDS: readonly ProofCard[] = [
  {
    id: 'completion',
    label: 'Candidate completion',
    headline: 'Designed for >90% completion',
    detail: 'Zero spyware, bounded 60–90m repo tasks.',
    isLive: false,
  },
  {
    id: 'fairness',
    label: 'Candidate trust & consent',
    headline: 'Candidate-first consent',
    detail: 'Upfront candidate-data-v1 notice & read-only submission receipts.',
    isLive: false,
  },
  {
    id: 'turnaround',
    label: 'Evaluator debrief speed',
    headline: 'Minutes to debrief, not days',
    detail: 'Chronological diffs + anchored observations in one view.',
    isLive: false,
  },
  {
    id: 'duration',
    label: 'Assessment scope',
    headline: 'Bounded real-repo scope',
    detail: 'No multi-day unpaid take-home projects.',
    isLive: false,
  },
];

/**
 * Resolves proof strip cards from `/api/marketing-proof` payload, enforcing strict
 * per-metric sample-size floors so early or sparse telemetry never shows misleading stats.
 */
export function resolveProofStrip(
  payload: MarketingProofPayload | null,
  variant: 'full' | 'compact' = 'full',
): ResolvedProofStrip {
  const m = payload?.metrics;
  const allowLive = Boolean(payload?.live && m);

  const cards: ProofCard[] = BENCHMARK_CARDS.map((fallback) => {
    if (!allowLive || !m) return fallback;

    if (
      fallback.id === 'completion' &&
      m.sessionsStarted >= PROOF_THRESHOLDS.sessionsStarted &&
      m.candidateCompletionRatePct !== null
    ) {
      return {
        id: 'completion',
        label: 'Candidate completion',
        headline: `${Math.round(m.candidateCompletionRatePct)}% completion`,
        detail: `Across ${m.sessionsStarted} started sessions (${payload!.windowDays}d).`,
        isLive: true,
      };
    }

    if (
      fallback.id === 'fairness' &&
      m.totalCandidateFeedback >= PROOF_THRESHOLDS.totalCandidateFeedback &&
      m.candidateFairnessPositivePct !== null
    ) {
      const avgText =
        m.candidateSatisfactionAvg !== null
          ? ` (${m.candidateSatisfactionAvg.toFixed(1)}/5 avg)`
          : '';
      return {
        id: 'fairness',
        label: 'Candidate fairness rating',
        headline: `${Math.round(m.candidateFairnessPositivePct)}% rated 4–5★`,
        detail: `Across ${m.totalCandidateFeedback} candidate ratings${avgText}.`,
        isLive: true,
      };
    }

    if (
      fallback.id === 'turnaround' &&
      m.decisionsPublished >= PROOF_THRESHOLDS.decisionsPublished &&
      m.medianReviewTurnaroundHours !== null
    ) {
      const formattedHours =
        m.medianReviewTurnaroundHours >= 10
          ? `${Math.round(m.medianReviewTurnaroundHours)} hrs`
          : `${m.medianReviewTurnaroundHours.toFixed(1)} hrs`;
      return {
        id: 'turnaround',
        label: 'Median review turnaround',
        headline: `${formattedHours} median`,
        detail: `Across ${m.decisionsPublished} published human decisions.`,
        isLive: true,
      };
    }

    if (
      fallback.id === 'duration' &&
      m.sessionsSubmitted >= PROOF_THRESHOLDS.sessionsSubmitted &&
      m.medianCandidateMinutes !== null
    ) {
      return {
        id: 'duration',
        label: 'Median assessment time',
        headline: `${Math.round(m.medianCandidateMinutes)} min median`,
        detail: `Across ${m.sessionsSubmitted} submitted real-repo sessions.`,
        isLive: true,
      };
    }

    return fallback;
  });

  const visibleCards = variant === 'compact' ? cards.slice(0, 3) : cards;
  const hasAnyLive = visibleCards.some((card) => card.isLive);

  return {
    mode: hasAnyLive ? 'live' : 'benchmark',
    badgeLabel: hasAnyLive
      ? `Live network metrics (${payload?.windowDays ?? 90}d aggregate)`
      : 'Platform design standards',
    cards: visibleCards,
  };
}

export function MarketingProofStrip({
  variant = 'full',
  surface = 'light',
}: {
  variant?: 'full' | 'compact';
  surface?: 'light' | 'mint';
}) {
  const [payload, setPayload] = useState<MarketingProofPayload | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/marketing-proof', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res
          .json()
          .catch(() => null)) as MarketingProofPayload | null;
        if (data && typeof data === 'object' && data.metrics) {
          setPayload(data);
        }
      })
      .catch(() => {
        // Silent fallback to Platform design standards
      });

    return () => controller.abort();
  }, []);

  const resolved = resolveProofStrip(payload, variant);

  return (
    <div
      className={`ct-proof-strip${variant === 'compact' ? ' ct-proof-strip--compact' : ''}${surface === 'mint' ? ' ct-proof-strip--on-mint' : ''}`}
      data-testid="marketing-proof-strip"
      data-proof-mode={resolved.mode}
    >
      <div className="ct-proof-header">
        <span className="ct-proof-badge">{resolved.badgeLabel}</span>
        <span className="ct-proof-note">
          {resolved.mode === 'live'
            ? 'Privacy-thresholded network aggregates — zero candidate PII.'
            : 'Public telemetry activates automatically once k-anonymity sample floors are met.'}
        </span>
      </div>
      <ul className="ct-proof-grid">
        {resolved.cards.map((card) => (
          <li className="ct-proof-card" key={card.id}>
            <span className="ct-proof-card-label">{card.label}</span>
            <strong className="ct-proof-card-value">{card.headline}</strong>
            <p className="ct-proof-card-detail">{card.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
