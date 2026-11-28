export type TelemetryCategory =
  | 'acquisition'
  | 'team_funnel'
  | 'candidate_funnel'
  | 'ai_quality'
  | 'monetization'
  | 'ux_friction'
  | 'performance'
  | 'error';

export type TelemetryActorType =
  'visitor' | 'team_member' | 'candidate' | 'system';

export type TelemetryStatus = 'ok' | 'error' | 'abandoned' | 'blocked';

export type TelemetryPlanTier = 'none' | 'per_candidate' | 'pro' | 'ultra';

export type NudgeKey =
  | 'no_assessment_48h'
  | 'unreviewed_submission_48h'
  | 'plan_gate_no_upgrade'
  | 'problem_health_alert'
  | 'connect_slack_webhook';

export const LAUNCH_MATURITY_EVENT_NAMES = [
  'demo.opened',
  'demo.milestone.clicked',
  'demo.tab.viewed',
  'demo.decision.simulated',
  'demo.cta.clicked',
  'dossier.share.created',
  'dossier.share.revoked',
  'dossier.public.viewed',
  'webhook.created',
  'webhook.updated',
  'webhook.deleted',
  'webhook.ping.sent',
  'nudge.snoozed',
  'nudge.dismissed',
  'operator.outreach.logged',
  'operator.nudge.updated',
] as const;

export interface PublicMarketingProof {
  readonly live: boolean;
  readonly windowDays: number;
  readonly metrics: {
    readonly candidateCompletionRatePct: number | null;
    readonly candidateFairnessPositivePct: number | null;
    readonly candidateSatisfactionAvg: number | null;
    readonly medianReviewTurnaroundHours: number | null;
    readonly medianCandidateMinutes: number | null;
    readonly activeOrganizations: number;
    readonly sessionsStarted: number;
    readonly sessionsSubmitted: number;
    readonly totalCandidateFeedback: number;
    readonly decisionsPublished: number;
  };
}

export interface LifecycleActionQueueItem {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly ownerEmail: string;
  readonly planTier: TelemetryPlanTier;
  readonly nudgeKey: NudgeKey;
  readonly targetRef: string;
  readonly hoursAge: number;
  readonly affectedCount: number;
  readonly summary: string;
  readonly nudgeStatus:
    'active' | 'dismissed' | 'snoozed' | 'resolved' | 'contacted';
  readonly snoozedUntil: string | null;
  readonly founderNote: string;
  readonly contactedAt: string | null;
}

export interface CohortRetentionRow {
  readonly cohortMonth: string;
  readonly orgsCreated: number;
  readonly activated7dPct: number;
  readonly retainedM1Pct: number | null;
  readonly retainedM2Pct: number | null;
  readonly retainedM3Pct: number | null;
  readonly repeatWaveOrgsCount: number;
  readonly repeatWavePct: number;
  readonly medianHoursToFirstInvite: number | null;
}

export interface ProductLifecycleReport {
  readonly actionQueue: readonly LifecycleActionQueueItem[];
  readonly cohortRetention: readonly CohortRetentionRow[];
}

export function buildPublicMarketingProof(
  report: ProductIntelligenceReport | null,
  publicProofLiveFlag: boolean,
): PublicMarketingProof {
  if (!report) {
    return {
      live: false,
      windowDays: 90,
      metrics: {
        candidateCompletionRatePct: null,
        candidateFairnessPositivePct: null,
        candidateSatisfactionAvg: null,
        medianReviewTurnaroundHours: null,
        medianCandidateMinutes: null,
        activeOrganizations: 0,
        sessionsStarted: 0,
        sessionsSubmitted: 0,
        totalCandidateFeedback: 0,
        decisionsPublished: 0,
      },
    };
  }

  const m = report.marketingProof;
  const globalGateMet =
    publicProofLiveFlag &&
    m.activeOrganizations >= 5 &&
    m.sessionsStarted >= 25 &&
    m.sessionsSubmitted >= 15;

  return {
    live: globalGateMet,
    windowDays: report.windowDays,
    metrics: {
      candidateCompletionRatePct:
        globalGateMet && m.sessionsStarted >= 25
          ? m.candidateCompletionRatePct
          : null,
      candidateFairnessPositivePct:
        globalGateMet && m.totalCandidateFeedback >= 15
          ? m.candidateFairnessPositivePct
          : null,
      candidateSatisfactionAvg:
        globalGateMet && m.totalCandidateFeedback >= 15
          ? m.candidateSatisfactionAvg
          : null,
      medianReviewTurnaroundHours:
        globalGateMet && m.decisionsPublished >= 15
          ? m.medianReviewTurnaroundHours
          : null,
      medianCandidateMinutes:
        globalGateMet && m.sessionsSubmitted >= 15
          ? m.medianCandidateMinutes
          : null,
      activeOrganizations: m.activeOrganizations,
      sessionsStarted: m.sessionsStarted,
      sessionsSubmitted: m.sessionsSubmitted,
      totalCandidateFeedback: m.totalCandidateFeedback,
      decisionsPublished: m.decisionsPublished,
    },
  };
}

export type ProductFeedbackSurface =
  | 'candidate_post_submit'
  | 'builder_ai_generated'
  | 'evaluator_review'
  | 'general';

export interface TelemetryAttribution {
  readonly anonymousId: string;
  readonly utmSource?: string;
  readonly utmMedium?: string;
  readonly utmCampaign?: string;
  readonly utmTerm?: string;
  readonly utmContent?: string;
  readonly referrerDomain?: string;
  readonly landingPath?: string;
}

export type TelemetryPropertyValue = string | number | boolean | null;

export interface TelemetryEventInput {
  readonly eventName: string;
  readonly category: TelemetryCategory;
  readonly actorType: TelemetryActorType;
  readonly anonymousId?: string | null;
  readonly organizationId?: string | null;
  readonly principalId?: string | null;
  readonly sessionId?: string | null;
  readonly route?: string | null;
  readonly planTier?: TelemetryPlanTier | string | null;
  readonly status?: TelemetryStatus;
  readonly durationMs?: number | null;
  readonly properties?: Readonly<Record<string, unknown>> | null;
  readonly attribution?: TelemetryAttribution | null;
}

export interface SanitizedTelemetryEvent {
  readonly eventName: string;
  readonly category: TelemetryCategory;
  readonly actorType: TelemetryActorType;
  readonly anonymousId?: string;
  readonly organizationId?: string;
  readonly principalId?: string;
  readonly sessionId?: string;
  readonly route: string;
  readonly planTier?: TelemetryPlanTier;
  readonly status: TelemetryStatus;
  readonly durationMs?: number;
  readonly properties: Record<string, TelemetryPropertyValue>;
  readonly attribution?: TelemetryAttribution;
}

export interface ProductFeedbackInput {
  readonly actorType: 'team_member' | 'candidate';
  readonly surface: ProductFeedbackSurface;
  readonly organizationId?: string | null;
  readonly principalId?: string | null;
  readonly sessionId?: string | null;
  readonly rating: number;
  readonly tags?: readonly string[];
  readonly comment?: string;
  readonly context?: Readonly<Record<string, unknown>> | null;
}

export interface ProductIntelligenceReport {
  readonly windowDays: number;
  readonly generatedAt: string;
  readonly marketingProof: {
    readonly totalOrganizations: number;
    readonly activeOrganizations: number;
    readonly totalSessionsIssued: number;
    readonly sessionsStarted: number;
    readonly sessionsSubmitted: number;
    readonly candidateStartRatePct: number;
    readonly candidateCompletionRatePct: number;
    readonly medianCandidateMinutes: number | null;
    readonly medianReviewTurnaroundHours: number | null;
    readonly decisionsPublished: number;
    readonly acceptanceRatePct: number;
    readonly aiAssistantEnabledPct: number;
    readonly candidateSatisfactionAvg: number | null;
    readonly candidateFairnessPositivePct: number;
    readonly totalCandidateFeedback: number;
  };
  readonly acquisitionChannels: readonly {
    readonly source: string;
    readonly medium: string;
    readonly campaign: string;
    readonly visitors: number;
    readonly signups: number;
    readonly orgsCreated: number;
    readonly conversionRatePct: number;
  }[];
  readonly hiringFunnel: {
    readonly orgsCreated: number;
    readonly assessmentsAuthored: number;
    readonly invitesIssued: number;
    readonly candidatesOpened: number;
    readonly candidatesStarted: number;
    readonly candidatesRanCode: number;
    readonly candidatesSubmitted: number;
    readonly decisionsPublished: number;
    readonly handoffsCompleted: number;
  };
  readonly assessmentHealth: readonly {
    readonly title: string;
    readonly sourceKind: string;
    readonly targetRole: string;
    readonly issued: number;
    readonly started: number;
    readonly submitted: number;
    readonly completionRatePct: number;
    readonly medianMinutes: number | null;
    readonly executionErrorRatePct: number;
    readonly avgCandidateRating: number | null;
    readonly healthFlag:
      | 'healthy'
      | 'high_dropoff'
      | 'runner_errors'
      | 'time_pressure'
      | 'low_sample';
  }[];
  readonly aiPerformance: {
    readonly generateStarted: number;
    readonly generateCompleted: number;
    readonly generateFailed: number;
    readonly successRatePct: number;
    readonly medianLatencyMs: number | null;
    readonly p95LatencyMs: number | null;
    readonly problemsSaved: number;
    readonly aiProblemsIssued: number;
    readonly avgAiQualityRating: number | null;
    readonly aiFeedbackCount: number;
    readonly advisoryReviewOpened: number;
  };
  readonly monetization: {
    readonly planDistribution: {
      readonly none: number;
      readonly per_candidate: number;
      readonly pro: number;
      readonly ultra: number;
    };
    readonly planGateHits: number;
    readonly upgradePageVisits: number;
    readonly planUpgrades: number;
    readonly slotAddons: number;
  };
  readonly uxFriction: {
    readonly topErrors: readonly {
      readonly eventName: string;
      readonly route: string;
      readonly count: number;
    }[];
    readonly topRoutes: readonly {
      readonly route: string;
      readonly views: number;
    }[];
    readonly themeSplit: {
      readonly light: number;
      readonly dark: number;
    };
    readonly clientErrorCount: number;
    readonly p95ApiDurationMs: number | null;
  };
  readonly recentFeedback: readonly {
    readonly id: string;
    readonly createdAt: string;
    readonly actorType: 'team_member' | 'candidate';
    readonly surface: ProductFeedbackSurface;
    readonly rating: number;
    readonly tags: readonly string[];
    readonly comment: string;
    readonly context: Readonly<Record<string, TelemetryPropertyValue>>;
  }[];
}

const VALID_CATEGORIES = new Set<TelemetryCategory>([
  'acquisition',
  'team_funnel',
  'candidate_funnel',
  'ai_quality',
  'monetization',
  'ux_friction',
  'performance',
  'error',
]);

const VALID_ACTORS = new Set<TelemetryActorType>([
  'visitor',
  'team_member',
  'candidate',
  'system',
]);

const VALID_STATUSES = new Set<TelemetryStatus>([
  'ok',
  'error',
  'abandoned',
  'blocked',
]);

const VALID_PLANS = new Set<TelemetryPlanTier>([
  'none',
  'per_candidate',
  'pro',
  'ultra',
]);

const VALID_FEEDBACK_SURFACES = new Set<ProductFeedbackSurface>([
  'candidate_post_submit',
  'builder_ai_generated',
  'evaluator_review',
  'general',
]);

const EVENT_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID_RE = /^sess_[A-Za-z0-9_-]{8,128}$/;

// Keys that must never leave application workflows into product analytics.
const PII_KEY_PATTERNS: readonly RegExp[] = [
  /email/i,
  /password/i,
  /secret/i,
  /token/i,
  /cookie/i,
  /authorization/i,
  /csrf/i,
  /phone/i,
  /avatar/i,
  /prompt/i,
  /response/i,
  /stdout/i,
  /stderr/i,
  /diff/i,
  /fullname/i,
  /displayname/i,
  /invitationnote/i,
  /internalnotes/i,
  /candidatefeedback/i,
  /^ip$/i,
  /^ipaddress$/i,
  /^code$/i,
  /^content$/i,
  /^note$/i,
  /^notes$/i,
  /^name$/i,
];

function isBlockedPropertyKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '');
  return PII_KEY_PATTERNS.some(
    (pattern) => pattern.test(key) || pattern.test(normalized),
  );
}

/**
 * Strips query parameters, fragments, UUIDs, session IDs, and opaque invite tokens from route strings.
 */
export function normalizeRoutePath(rawPath: string | null | undefined): string {
  if (!rawPath || typeof rawPath !== 'string') return '';
  const withoutHash = rawPath.split('#')[0] ?? '';
  const withoutQuery = withoutHash.split('?')[0] ?? '';
  let path = withoutQuery.trim();
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      path = '/';
    }
  }
  const normalized = path
    .replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi,
      '/:id',
    )
    .replace(/\/sess_[A-Za-z0-9_-]+(?=\/|$)/g, '/:sessionId')
    .replace(/(\/(?:r26\/)?candidate\/)[A-Za-z0-9_-]{12,}(?=\/|$)/g, '$1:token')
    .slice(0, 200);
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

/**
 * Keeps only shallow allowlisted primitive properties and strips all PII/content/secret fields.
 */
export function sanitizeTelemetryProperties(
  raw: unknown,
): Record<string, TelemetryPropertyValue> {
  const out: Record<string, TelemetryPropertyValue> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return out;
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  for (const [rawKey, value] of entries) {
    if (Object.keys(out).length >= 24) break;
    const key = rawKey.trim().slice(0, 48);
    if (!key || !/^[A-Za-z0-9_.-]+$/.test(key) || isBlockedPropertyKey(key)) {
      continue;
    }
    if (value === null) {
      out[key] = null;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'number') {
      if (Number.isFinite(value)) out[key] = Math.round(value * 1000) / 1000;
    } else if (typeof value === 'string') {
      const cleaned = value.trim().slice(0, 160);
      if (cleaned) out[key] = cleaned;
    }
  }
  return out;
}

export function sanitizeAttribution(
  raw: unknown,
): TelemetryAttribution | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const anonymousId =
    typeof obj.anonymousId === 'string'
      ? obj.anonymousId.trim().slice(0, 80)
      : '';
  if (anonymousId.length < 8) return undefined;

  const str = (v: unknown, max = 160) =>
    typeof v === 'string' ? v.trim().slice(0, max) : undefined;

  return {
    anonymousId,
    ...(str(obj.utmSource) ? { utmSource: str(obj.utmSource) } : {}),
    ...(str(obj.utmMedium) ? { utmMedium: str(obj.utmMedium) } : {}),
    ...(str(obj.utmCampaign) ? { utmCampaign: str(obj.utmCampaign) } : {}),
    ...(str(obj.utmTerm) ? { utmTerm: str(obj.utmTerm) } : {}),
    ...(str(obj.utmContent) ? { utmContent: str(obj.utmContent) } : {}),
    ...(str(obj.referrerDomain)
      ? { referrerDomain: str(obj.referrerDomain) }
      : {}),
    ...(str(obj.landingPath, 200)
      ? { landingPath: normalizeRoutePath(str(obj.landingPath, 200)) }
      : {}),
  };
}

export function sanitizeTelemetryEvent(
  input: unknown,
): SanitizedTelemetryEvent | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const obj = input as Record<string, unknown>;
  const eventName =
    typeof obj.eventName === 'string' ? obj.eventName.trim().slice(0, 80) : '';
  if (!EVENT_NAME_RE.test(eventName)) return null;

  const category = obj.category as TelemetryCategory;
  if (!VALID_CATEGORIES.has(category)) return null;

  const actorType = obj.actorType as TelemetryActorType;
  if (!VALID_ACTORS.has(actorType)) return null;

  const status =
    typeof obj.status === 'string' &&
    VALID_STATUSES.has(obj.status as TelemetryStatus)
      ? (obj.status as TelemetryStatus)
      : 'ok';

  const anonymousId =
    typeof obj.anonymousId === 'string' &&
    obj.anonymousId.trim().length >= 8 &&
    obj.anonymousId.trim().length <= 80
      ? obj.anonymousId.trim()
      : undefined;

  const organizationId =
    typeof obj.organizationId === 'string' &&
    UUID_RE.test(obj.organizationId.trim())
      ? obj.organizationId.trim().toLowerCase()
      : undefined;

  const principalId =
    typeof obj.principalId === 'string' && UUID_RE.test(obj.principalId.trim())
      ? obj.principalId.trim().toLowerCase()
      : undefined;

  const sessionId =
    typeof obj.sessionId === 'string' &&
    SESSION_ID_RE.test(obj.sessionId.trim())
      ? obj.sessionId.trim()
      : undefined;

  const planTier =
    typeof obj.planTier === 'string' &&
    VALID_PLANS.has(obj.planTier as TelemetryPlanTier)
      ? (obj.planTier as TelemetryPlanTier)
      : undefined;

  const durationMs =
    typeof obj.durationMs === 'number' &&
    Number.isFinite(obj.durationMs) &&
    obj.durationMs >= 0
      ? Math.min(3_600_000, Math.round(obj.durationMs))
      : undefined;

  const attribution = sanitizeAttribution(obj.attribution);

  return {
    eventName,
    category,
    actorType,
    ...(anonymousId ? { anonymousId } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(principalId ? { principalId } : {}),
    ...(sessionId ? { sessionId } : {}),
    route: normalizeRoutePath(
      typeof obj.route === 'string' ? obj.route : undefined,
    ),
    ...(planTier ? { planTier } : {}),
    status,
    ...(durationMs !== undefined ? { durationMs } : {}),
    properties: sanitizeTelemetryProperties(obj.properties),
    ...(attribution ? { attribution } : {}),
  };
}

export function sanitizeFeedbackInput(input: unknown): {
  actorType: 'team_member' | 'candidate';
  surface: ProductFeedbackSurface;
  organizationId?: string;
  principalId?: string;
  sessionId?: string;
  rating: number;
  tags: string[];
  comment: string;
  context: Record<string, TelemetryPropertyValue>;
} | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const obj = input as Record<string, unknown>;
  const actorType =
    obj.actorType === 'candidate'
      ? 'candidate'
      : obj.actorType === 'team_member'
        ? 'team_member'
        : null;
  if (!actorType) return null;

  const surface = obj.surface as ProductFeedbackSurface;
  if (!VALID_FEEDBACK_SURFACES.has(surface)) return null;

  const rawRating = Number(obj.rating);
  if (!Number.isInteger(rawRating) || rawRating < 1 || rawRating > 5) {
    return null;
  }

  const tags = Array.isArray(obj.tags)
    ? obj.tags
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim().slice(0, 64))
        .filter(Boolean)
        .slice(0, 8)
    : [];

  const comment =
    typeof obj.comment === 'string' ? obj.comment.trim().slice(0, 1000) : '';

  const organizationId =
    typeof obj.organizationId === 'string' &&
    UUID_RE.test(obj.organizationId.trim())
      ? obj.organizationId.trim().toLowerCase()
      : undefined;

  const principalId =
    typeof obj.principalId === 'string' && UUID_RE.test(obj.principalId.trim())
      ? obj.principalId.trim().toLowerCase()
      : undefined;

  const sessionId =
    typeof obj.sessionId === 'string' &&
    SESSION_ID_RE.test(obj.sessionId.trim())
      ? obj.sessionId.trim()
      : undefined;

  return {
    actorType,
    surface,
    ...(organizationId ? { organizationId } : {}),
    ...(principalId ? { principalId } : {}),
    ...(sessionId ? { sessionId } : {}),
    rating: rawRating,
    tags,
    comment,
    context: sanitizeTelemetryProperties(obj.context),
  };
}

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/**
 * Formats a ProductIntelligenceReport as a clean multi-section CSV for spreadsheet or BI import.
 */
export function formatIntelligenceCsv(
  report: ProductIntelligenceReport,
): string {
  const lines: string[] = [];
  lines.push(
    ['section', 'metric_or_item', 'dimension', 'value', 'extra'].join(','),
  );

  for (const [k, v] of Object.entries(report.marketingProof)) {
    lines.push(['marketing_proof', k, '', v, ''].map(csvCell).join(','));
  }

  for (const [k, v] of Object.entries(report.hiringFunnel)) {
    lines.push(['hiring_funnel', k, '', v, ''].map(csvCell).join(','));
  }

  for (const ch of report.acquisitionChannels) {
    lines.push(
      [
        'acquisition_channel',
        `${ch.source}/${ch.medium}`,
        ch.campaign,
        ch.visitors,
        `signups=${ch.signups};orgs=${ch.orgsCreated};conv=${ch.conversionRatePct}%`,
      ]
        .map(csvCell)
        .join(','),
    );
  }

  for (const item of report.assessmentHealth) {
    lines.push(
      [
        'assessment_health',
        item.title,
        `${item.sourceKind}:${item.targetRole}`,
        `${item.completionRatePct}%`,
        `issued=${item.issued};submitted=${item.submitted};err=${item.executionErrorRatePct}%;flag=${item.healthFlag}`,
      ]
        .map(csvCell)
        .join(','),
    );
  }

  for (const [k, v] of Object.entries(report.aiPerformance)) {
    lines.push(['ai_performance', k, '', v, ''].map(csvCell).join(','));
  }

  for (const [k, v] of Object.entries(report.monetization.planDistribution)) {
    lines.push(['plan_distribution', k, '', v, ''].map(csvCell).join(','));
  }

  for (const fb of report.recentFeedback) {
    lines.push(
      [
        'product_feedback',
        fb.surface,
        fb.actorType,
        fb.rating,
        `tags=${fb.tags.join('|')};comment=${fb.comment}`,
      ]
        .map(csvCell)
        .join(','),
    );
  }

  return `${lines.join('\n')}\n`;
}
