export type PlanTier = 'none' | 'per_candidate' | 'pro' | 'ultra';

export type PlanFeatureKey =
  | 'aiCandidateReview'
  | 'aiPerformanceReport'
  | 'aiAssessmentBuilder'
  | 'candidateWorkspaceAi'
  | 'savedProblemLibrary'
  | 'multiStageHandoff'
  | 'secondOpinionReview';

export interface PlanDefinition {
  readonly id: PlanTier;
  readonly name: string;
  readonly badgeLabel: string;
  readonly tagline: string;
  readonly billingModel: 'none' | 'credits' | 'subscription';
  readonly priceLabel: string;
  readonly canIssueAssessments: boolean;
  readonly highlights: readonly string[];
  readonly features: Readonly<Record<PlanFeatureKey, boolean>>;
}

/**
 * Single source of truth for plan capabilities & feature gating.
 * Edit names, highlights, or feature toggles here when commercial rules evolve.
 */
export const PLAN_CATALOG: Readonly<Record<PlanTier, PlanDefinition>> = {
  none: {
    id: 'none',
    name: 'No active plan',
    badgeLabel: 'Plan required',
    tagline:
      'Team onboarding is available, but an active paid plan is required before issuing assessments. There is no free plan.',
    billingModel: 'none',
    priceLabel: 'Not activated',
    canIssueAssessments: false,
    highlights: [
      'Set up your organization, CTO/Owner, recruiters, and evaluators',
      'Upgrade to Per Candidate, Pro, or Ultra to issue assessments',
    ],
    features: {
      aiCandidateReview: false,
      aiPerformanceReport: false,
      aiAssessmentBuilder: false,
      candidateWorkspaceAi: false,
      savedProblemLibrary: false,
      multiStageHandoff: false,
      secondOpinionReview: false,
    },
  },
  per_candidate: {
    id: 'per_candidate',
    name: 'Per Candidate',
    badgeLabel: 'Per Candidate',
    tagline:
      'Purchase candidate evaluation slots and pay strictly per distinct candidate assessed by your organization.',
    billingModel: 'credits',
    priceLabel: 'Pay per candidate slot',
    canIssueAssessments: true,
    highlights: [
      'One slot per distinct candidate',
      'Templates, AI authoring, and saved problems',
      'Candidate AI assistant, peer reviews, and handoffs',
    ],
    features: {
      aiCandidateReview: false,
      aiPerformanceReport: false,
      aiAssessmentBuilder: true,
      candidateWorkspaceAi: true,
      savedProblemLibrary: true,
      multiStageHandoff: true,
      secondOpinionReview: true,
    },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    badgeLabel: 'Pro',
    tagline:
      'Unlimited candidate assessments with AI-assisted problem authoring, saved problem library, and team handoff workflows.',
    billingModel: 'subscription',
    priceLabel: 'Pro Subscription',
    canIssueAssessments: true,
    highlights: [
      'Unlimited candidate assessments',
      'Authoring, candidate AI, and team tools from Per Candidate',
    ],
    features: {
      aiCandidateReview: false,
      aiPerformanceReport: false,
      aiAssessmentBuilder: true,
      candidateWorkspaceAi: true,
      savedProblemLibrary: true,
      multiStageHandoff: true,
      secondOpinionReview: true,
    },
  },
  ultra: {
    id: 'ultra',
    name: 'Ultra',
    badgeLabel: 'Ultra',
    tagline:
      'Everything in Pro, plus AI-assisted review summaries and hiring manager fit reports.',
    billingModel: 'subscription',
    priceLabel: 'Ultra Subscription',
    canIssueAssessments: true,
    highlights: [
      'Everything in Pro',
      'AI-assisted review summaries',
      'Hiring Manager Fit Report on candidate acceptance',
    ],
    features: {
      aiCandidateReview: true,
      aiPerformanceReport: true,
      aiAssessmentBuilder: true,
      candidateWorkspaceAi: true,
      savedProblemLibrary: true,
      multiStageHandoff: true,
      secondOpinionReview: true,
    },
  },
};

export const PAID_PLAN_ORDER: readonly Exclude<PlanTier, 'none'>[] = [
  'per_candidate',
  'pro',
  'ultra',
];

export function isPlanTier(value: unknown): value is PlanTier {
  return (
    value === 'none' ||
    value === 'per_candidate' ||
    value === 'pro' ||
    value === 'ultra'
  );
}

export function getPlanDefinition(
  tier: PlanTier | string | null | undefined,
): PlanDefinition {
  if (isPlanTier(tier)) return PLAN_CATALOG[tier];
  return PLAN_CATALOG.none;
}

export function hasPlanFeature(
  tier: PlanTier | string | null | undefined,
  feature: PlanFeatureKey,
): boolean {
  return getPlanDefinition(tier).features[feature];
}

export function getRequiredPlanForFeature(feature: PlanFeatureKey): PlanTier {
  if (PLAN_CATALOG.per_candidate.features[feature]) return 'per_candidate';
  if (PLAN_CATALOG.pro.features[feature]) return 'pro';
  return 'ultra';
}

export interface OrganizationPlanSummary {
  readonly planTier: PlanTier;
  readonly candidateCreditsPurchased: number;
  readonly candidateCreditsUsed: number;
  readonly candidateCreditsRemaining: number | null;
  readonly creditedEmails: readonly string[];
  readonly updatedAt: string | null;
}

export function formatPlanBadge(plan: OrganizationPlanSummary): string {
  const def = getPlanDefinition(plan.planTier);
  if (plan.planTier === 'per_candidate') {
    const remaining = plan.candidateCreditsRemaining ?? 0;
    return `${def.badgeLabel} · ${remaining} ${remaining === 1 ? 'slot' : 'slots'} left`;
  }
  return def.badgeLabel;
}
