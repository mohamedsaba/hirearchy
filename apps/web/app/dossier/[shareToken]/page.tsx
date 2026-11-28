import { createHash } from 'node:crypto';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Pool } from 'pg';

import {
  DEMO_PUBLIC_DOSSIER,
  normalizeResolvedDossier,
} from '../../../src/demo/sample-session';
import {
  operationalLogger,
  sanitizeError,
} from '../../../src/observability/logger.mjs';
import { isPublicPreview } from '../../../src/runtime/profile';
import { DossierClient } from './dossier-client';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ shareToken: string }>;
}): Promise<Metadata> {
  const { shareToken } = await params;
  return {
    title:
      shareToken === 'demo'
        ? 'Sample Executive Candidate Dossier — Hirearchy Software'
        : 'Executive Candidate Dossier — Hirearchy Software',
    referrer: 'no-referrer',
    robots: { index: false, follow: false },
  };
}

let dossierPool: Pool | null = null;
let configuredDatabaseUrl: string | undefined;

function getDossierPool(): Pool | null {
  const databaseUrl = process.env.STAGING_DATABASE_URL?.trim();
  if (!databaseUrl) return null;

  if (!dossierPool || configuredDatabaseUrl !== databaseUrl) {
    configuredDatabaseUrl = databaseUrl;
    dossierPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10000,
      statement_timeout: 4000,
    });
    const emitter = dossierPool as unknown as {
      on?: (event: string, cb: (err: unknown) => void) => void;
    };
    emitter.on?.('error', (error: unknown) => {
      operationalLogger.warn('Dossier PostgreSQL pool idle error', {
        service: 'dossier_share',
        error: sanitizeError(error),
      });
    });
  }
  return dossierPool;
}

export default async function PublicDossierPage({
  params,
}: {
  params: Promise<{ shareToken: string }>;
}) {
  const { shareToken } = await params;
  const selfServiceEnabled =
    !isPublicPreview() &&
    process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED === 'true';
  const demoCtaHref = selfServiceEnabled ? '/r23/signup' : '/early-access';

  if (shareToken === 'demo') {
    return (
      <DossierClient dossier={DEMO_PUBLIC_DOSSIER} demoCtaHref={demoCtaHref} />
    );
  }

  if (!/^[A-Za-z0-9_-]{16,256}$/.test(shareToken)) {
    notFound();
  }

  const pool = getDossierPool();
  if (!pool) {
    notFound();
  }

  const tokenHash = createHash('sha256').update(shareToken).digest('hex');
  let rawResult: unknown = null;
  try {
    const res = await pool.query<{ result: unknown }>(
      'SELECT staging.hiring_dossier_share_resolve($1::pg_catalog.text) AS result',
      [tokenHash],
    );
    rawResult = res.rows[0]?.result ?? null;
  } catch (error) {
    operationalLogger.warn('Failed to resolve dossier share token', {
      service: 'dossier_share',
      error: sanitizeError(error),
    });
    notFound();
  }

  const dossier = normalizeResolvedDossier(rawResult);
  if (!dossier) {
    notFound();
  }

  return <DossierClient dossier={dossier} demoCtaHref={demoCtaHref} />;
}
