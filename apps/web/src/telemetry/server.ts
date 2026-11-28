import { Pool } from 'pg';

import { operationalLogger, sanitizeError } from '../observability/logger.mjs';
import {
  buildPublicMarketingProof,
  sanitizeAttribution,
  sanitizeFeedbackInput,
  sanitizeTelemetryEvent,
  type NudgeKey,
  type ProductFeedbackInput,
  type ProductIntelligenceReport,
  type ProductLifecycleReport,
  type PublicMarketingProof,
  type TelemetryAttribution,
  type TelemetryEventInput,
} from './catalog';

let telemetryPool: Pool | null = null;
let configuredDatabaseUrl: string | undefined;

function getTelemetryPool(): Pool | null {
  const databaseUrl = process.env.STAGING_DATABASE_URL?.trim();
  if (!databaseUrl) return null;

  if (!telemetryPool || configuredDatabaseUrl !== databaseUrl) {
    configuredDatabaseUrl = databaseUrl;
    telemetryPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
      statement_timeout: 4000,
    });
    const emitter = telemetryPool as unknown as {
      on?: (event: string, cb: (err: unknown) => void) => void;
    };
    emitter.on?.('error', (error: unknown) => {
      operationalLogger.warn('Telemetry PostgreSQL pool idle error', {
        service: 'product_telemetry',
        error: sanitizeError(error),
      });
    });
  }
  return telemetryPool;
}

function parseCookieMap(request: Request): Map<string, string> {
  const map = new Map<string, string>();
  const raw = request.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      map.set(key, decodeURIComponent(val));
    } catch {
      map.set(key, val);
    }
  }
  return map;
}

/**
 * Extracts first-party attribution and anonymous visitor ID cookies stored by the browser SDK.
 */
export function readAttributionCookie(
  request: Request,
): TelemetryAttribution | null {
  const cookies = parseCookieMap(request);
  const anon = cookies.get('hirearchy-anon');
  const attrRaw = cookies.get('hirearchy-attr');
  if (attrRaw) {
    try {
      const parsed = JSON.parse(attrRaw) as Record<string, unknown>;
      const cleaned = sanitizeAttribution({
        anonymousId: parsed.anonymousId ?? anon,
        ...parsed,
      });
      if (cleaned) return cleaned;
    } catch {
      // Ignore malformed attribution cookie
    }
  }
  if (anon && anon.length >= 8 && anon.length <= 80) {
    return { anonymousId: anon };
  }
  return null;
}

/**
 * Persists a validated batch of telemetry events to PostgreSQL via `staging.telemetry_record_events`.
 * Never throws; returns number of accepted events (0 when DB is unconfigured or unavailable).
 */
export async function recordServerTelemetryBatch(
  events: readonly TelemetryEventInput[],
): Promise<number> {
  const sanitized = events
    .slice(0, 50)
    .map((event) => sanitizeTelemetryEvent(event))
    .filter((event): event is NonNullable<typeof event> => event !== null);

  if (sanitized.length === 0) return 0;

  const pool = getTelemetryPool();
  if (!pool) return 0;

  try {
    const res = await pool.query<{ result: { accepted?: number } }>(
      'SELECT staging.telemetry_record_events($1::pg_catalog.jsonb) AS result',
      [JSON.stringify(sanitized)],
    );
    const accepted = Number(res.rows[0]?.result?.accepted ?? 0);
    return Number.isFinite(accepted) ? accepted : 0;
  } catch (error) {
    operationalLogger.warn('Failed to persist product telemetry batch', {
      service: 'product_telemetry',
      error: sanitizeError(error),
    });
    return 0;
  }
}

/**
 * Fire-and-forget telemetry emitter for server handlers and background jobs.
 */
export function recordServerTelemetryEvent(event: TelemetryEventInput): void {
  void recordServerTelemetryBatch([event]).catch(() => 0);
}

/**
 * Stores structured candidate or team micro-feedback in `hirearchy.product_feedback`.
 */
export async function recordProductFeedback(
  input: ProductFeedbackInput,
): Promise<{ id: string; createdAt: string } | null> {
  const cleaned = sanitizeFeedbackInput(input);
  if (!cleaned) return null;

  const pool = getTelemetryPool();
  if (!pool) return null;

  try {
    const res = await pool.query<{
      result: { id?: string; createdAt?: string };
    }>(
      'SELECT staging.telemetry_record_feedback($1::pg_catalog.jsonb) AS result',
      [JSON.stringify(cleaned)],
    );
    const row = res.rows[0]?.result;
    if (row?.id && row.createdAt) {
      return { id: row.id, createdAt: row.createdAt };
    }
    return null;
  } catch (error) {
    operationalLogger.warn('Failed to persist product feedback', {
      service: 'product_telemetry',
      error: sanitizeError(error),
    });
    return null;
  }
}

/**
 * Queries aggregated marketing, hiring funnel, assessment health, AI, and feedback metrics.
 */
export async function loadProductIntelligenceReport(
  days = 30,
): Promise<ProductIntelligenceReport | null> {
  const pool = getTelemetryPool();
  if (!pool) return null;

  const safeDays = Math.max(1, Math.min(3650, Math.trunc(days || 30)));
  try {
    const res = await pool.query<{ result: ProductIntelligenceReport }>(
      'SELECT staging.telemetry_insights_report($1::pg_catalog.int4) AS result',
      [safeDays],
    );
    return res.rows[0]?.result ?? null;
  } catch (error) {
    operationalLogger.warn('Failed to load product intelligence report', {
      service: 'product_telemetry',
      error: sanitizeError(error),
    });
    return null;
  }
}

const PUBLIC_PROOF_CACHE_TTL_MS = 15 * 60 * 1000;
let cachedPublicProof: {
  expiresAt: number;
  liveFlag: boolean;
  value: PublicMarketingProof;
} | null = null;

/**
 * Loads privacy-thresholded aggregate network proof for public marketing pages.
 * Never exposes organization names, emails, or feedback comments, and caches for 15 minutes.
 */
export async function loadPublicMarketingProof(): Promise<PublicMarketingProof> {
  const liveFlag = process.env.HIREARCHY_PUBLIC_PROOF_LIVE === 'true';
  const now = Date.now();
  if (
    cachedPublicProof &&
    cachedPublicProof.liveFlag === liveFlag &&
    cachedPublicProof.expiresAt > now
  ) {
    return cachedPublicProof.value;
  }

  const report = await loadProductIntelligenceReport(90);
  const projected = buildPublicMarketingProof(report, liveFlag);
  cachedPublicProof = {
    expiresAt: now + PUBLIC_PROOF_CACHE_TTL_MS,
    liveFlag,
    value: projected,
  };
  return projected;
}

/**
 * Loads operator action queue and repeat-cycle cohort retention matrix.
 */
export async function loadLifecycleReport(): Promise<ProductLifecycleReport | null> {
  const pool = getTelemetryPool();
  if (!pool) return null;

  try {
    const res = await pool.query<{ result: ProductLifecycleReport }>(
      'SELECT staging.telemetry_lifecycle_report() AS result',
    );
    return res.rows[0]?.result ?? null;
  } catch (error) {
    operationalLogger.warn('Failed to load lifecycle report', {
      service: 'product_telemetry',
      error: sanitizeError(error),
    });
    return null;
  }
}

/**
 * Updates an operator lifecycle nudge status (contacted, snoozed, resolved).
 */
export async function updateOperatorNudge(input: {
  organizationId: string;
  nudgeKey: NudgeKey;
  targetRef?: string;
  status: 'contacted' | 'snoozed' | 'resolved';
  founderNote?: string;
}): Promise<boolean> {
  const pool = getTelemetryPool();
  if (!pool) return false;

  try {
    const res = await pool.query<{ result: { ok?: boolean } }>(
      'SELECT staging.telemetry_update_nudge($1::pg_catalog.uuid, $2, $3, $4, $5) AS result',
      [
        input.organizationId,
        input.nudgeKey,
        input.targetRef ?? '',
        input.status,
        input.founderNote ?? '',
      ],
    );
    return Boolean(res.rows[0]?.result?.ok);
  } catch (error) {
    operationalLogger.warn('Failed to update operator nudge', {
      service: 'product_telemetry',
      error: sanitizeError(error),
    });
    return false;
  }
}
