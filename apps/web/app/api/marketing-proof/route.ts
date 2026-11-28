import { NextResponse } from 'next/server';

import { loadPublicMarketingProof } from '../../../src/telemetry/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  const proof = await loadPublicMarketingProof();
  return NextResponse.json(proof, {
    headers: {
      'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=3600',
    },
  });
}
