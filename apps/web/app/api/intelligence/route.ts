import { NextResponse } from 'next/server';

import { isFounderUatEnabled } from '../../../src/runtime/founder-uat';
import { formatIntelligenceCsv } from '../../../src/telemetry/catalog';
import { loadProductIntelligenceReport } from '../../../src/telemetry/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

function isIntelligenceEnabled(): boolean {
  return (
    isFounderUatEnabled() ||
    process.env.HIREARCHY_OPERATOR_ANALYTICS_ENABLED === 'true'
  );
}

export async function GET(request: Request): Promise<Response> {
  if (!isIntelligenceEnabled()) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'Not found.' } },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const url = new URL(request.url);
  const rawDays = Number(url.searchParams.get('days') ?? 30);
  const days = Number.isFinite(rawDays)
    ? Math.max(1, Math.min(3650, Math.trunc(rawDays)))
    : 30;
  const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json';

  const report = await loadProductIntelligenceReport(days);
  if (!report) {
    return NextResponse.json(
      {
        error: {
          code: 'INTELLIGENCE_UNAVAILABLE',
          message: 'Product intelligence database is unavailable.',
        },
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (format === 'csv') {
    const csv = formatIntelligenceCsv(report);
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="hirearchy-intelligence-${days}d.csv"`,
        'Cache-Control': 'private, no-store',
      },
    });
  }

  return NextResponse.json(
    { report },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
