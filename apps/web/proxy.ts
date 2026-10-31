import { NextResponse, type NextRequest } from 'next/server';

import {
  isAuthenticatedStaging,
  isStagingLockdown,
} from './src/runtime/profile';

export function proxy(request: NextRequest) {
  if (
    isStagingLockdown() &&
    !(request.method === 'GET' && request.nextUrl.pathname === '/api/health') &&
    !(
      isAuthenticatedStaging() &&
      request.method === 'POST' &&
      request.nextUrl.pathname === '/api/staging/v1'
    )
  ) {
    return NextResponse.json(
      {
        error: {
          code: 'STAGING_CAPABILITY_DISABLED',
          message: 'This capability is unavailable in staging lockdown.',
        },
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.next();
}
