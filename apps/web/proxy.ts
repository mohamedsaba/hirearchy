import { NextResponse, type NextRequest } from 'next/server';

import { CANDIDATE_SUBMISSION_PATH } from './src/hiring/candidate-entry';

import {
  isAuthenticatedStaging,
  isFounderUatEnabled,
  isHiringPlatformEnabled,
  isPublicPreview,
  isStagingLockdown,
} from './src/runtime/profile';

const PUBLIC_PREVIEW_GET_PATHS = new Set([
  '/',
  '/about',
  '/contact',
  '/early-access',
  '/privacy',
  '/products',
  '/products/software',
  '/terms',
  '/thinking',
]);

const STAGING_BROWSER_GET_PATTERNS: readonly RegExp[] = [
  /^\/r23\/login$/,
  /^\/r23\/signup$/,
  /^\/r23\/verify-email$/,
  /^\/r23\/recover$/,
  /^\/r23\/reset-password$/,
  /^\/r23\/invitations\/accept$/,
  /^\/r23\/organizations\/[^/]+\/settings$/,
  /^\/r23\/auth\/callback$/,
  /^\/r23\/organizations$/,
  /^\/r23\/organizations\/[^/]+$/,
  /^\/r23\/organizations\/[^/]+\/builder$/,
  /^\/r23\/organizations\/[^/]+\/problems(?:\/[^/]+)?$/,
  /^\/r23\/organizations\/[^/]+\/sessions\/[^/]+$/,
  /^\/r23\/api\/organizations\/[^/]+\/assessments\/draft$/,
  /^\/r23\/api\/organizations\/[^/]+\/assessments\/versions\/[^/]+$/,
  /^\/r23\/api\/organizations\/[^/]+\/problems(?:\/[^/]+)?$/,
  /^\/r23\/api\/organizations\/[^/]+\/reviewers$/,
  /^\/r23\/api\/organizations\/[^/]+\/sessions$/,
  /^\/r23\/api\/organizations\/[^/]+\/sessions\/[^/]+$/,
  /^\/r23\/api\/organizations\/[^/]+\/sessions\/[^/]+\/assignments$/,
  /^\/r23\/api\/organizations\/[^/]+\/sessions\/[^/]+\/candidate-token$/,
  /^\/r26\/candidate\/[^/]+$/,
  /^\/r26\/api\/candidate\/[^/]+$/,
  /^\/r27\/organizations\/[^/]+\/sessions\/[^/]+$/,
  /^\/r27\/api\/organizations\/[^/]+\/sessions\/[^/]+\/ai-review$/,
  /^\/r27\/api\/organizations\/[^/]+\/sessions\/[^/]+\/evidence$/,
  /^\/r27\/api\/organizations\/[^/]+\/sessions\/[^/]+\/evidence\/revisions\/[^/]+$/,
  /^\/r27\/api\/organizations\/[^/]+\/sessions\/[^/]+\/observations$/,
  /^\/r27\/api\/organizations\/[^/]+\/sessions\/[^/]+\/observations\/[^/]+$/,
  /^\/r27\/api\/organizations\/[^/]+\/sessions\/[^/]+\/review-packet$/,
  /^\/api\/staging\/readiness$/,
  /^\/r23\/mail$/,
  /^\/api\/founder-uat\/mail$/,
  /^\/api\/founder-uat\/mail\/template\/(confirmation|recovery)$/,
];

const STAGING_BROWSER_POST_PATTERNS: readonly RegExp[] = [
  /^\/api\/staging\/v1$/,
  /^\/api\/auth\/(signup|verify-email|recover|reset-password)$/,
  /^\/r23\/login$/,
  /^\/r23\/signup$/,
  /^\/r23\/verify-email$/,
  /^\/r23\/recover$/,
  /^\/r23\/reset-password$/,
  /^\/r23\/organization\/bootstrap$/,
  /^\/r23\/organizations\/[^/]+\/settings$/,
  /^\/r23\/invitations\/accept$/,
  /^\/r23\/auth\/login$/,
  /^\/r23\/auth\/logout$/,
  /^\/r23\/auth\/refresh$/,
  /^\/r23\/organization$/,
  /^\/r23\/api\/organizations\/[^/]+\/assessments\/validate$/,
  /^\/r23\/api\/organizations\/[^/]+\/problems$/,
  /^\/r23\/api\/organizations\/[^/]+\/problems\/[^/]+\/reuse$/,
  /^\/r23\/api\/organizations\/[^/]+\/sessions$/,
  /^\/r23\/api\/organizations\/[^/]+\/sessions\/[^/]+\/candidate-token$/,
  /^\/r27\/api\/organizations\/[^/]+\/sessions\/[^/]+\/ai-review$/,
  /^\/r27\/api\/organizations\/[^/]+\/sessions\/[^/]+\/observations$/,
  /^\/r27\/api\/organizations\/[^/]+\/sessions\/[^/]+\/review-packet\/finalize$/,
  /^\/r26\/api\/candidate\/[^/]+$/,
  /^\/api\/founder-uat\/(mail\/consume|invitations\/context|auth\/reset-password)$/,
];

const STAGING_BROWSER_PUT_PATTERNS: readonly RegExp[] = [
  /^\/r23\/api\/organizations\/[^/]+\/assessments\/draft$/,
  /^\/r27\/api\/organizations\/[^/]+\/sessions\/[^/]+\/review-packet$/,
];

const STAGING_BROWSER_PATCH_PATTERNS: readonly RegExp[] = [
  /^\/r23\/api\/organizations\/[^/]+\/problems\/[^/]+$/,
  /^\/r27\/api\/organizations\/[^/]+\/sessions\/[^/]+\/observations\/[^/]+$/,
];

const STAGING_BROWSER_DELETE_PATTERNS: readonly RegExp[] = [
  /^\/r23\/api\/organizations\/[^/]+\/problems\/[^/]+$/,
  /^\/r23\/api\/organizations\/[^/]+\/sessions\/[^/]+\/candidate-token$/,
];

const HIRING_PLATFORM_GET_PATTERNS: readonly RegExp[] = [
  /^\/hiring-platform\.css$/,
  /^\/r23\/account$/,
  /^\/r23\/organizations\/[^/]+\/(?:plan|upgrade)$/,
  /^\/candidate$/,
  /^\/candidate\/login$/,
  /^\/candidate\/signup$/,
  CANDIDATE_SUBMISSION_PATH,
  /^\/api\/candidate-portal$/,
  /^\/r26\/api\/candidate\/[^/]+\/ai$/,
  /^\/r23\/organizations\/[^/]+\/candidates$/,
  /^\/r23\/organizations\/[^/]+\/handoffs$/,
  /^\/r23\/organizations\/[^/]+\/handoffs\/[^/]+$/,
  /^\/r23\/api\/organizations\/[^/]+\/hiring\/plan$/,
  /^\/r23\/api\/organizations\/[^/]+\/hiring\/candidates$/,
  /^\/r23\/api\/organizations\/[^/]+\/hiring\/library$/,
  /^\/r23\/api\/organizations\/[^/]+\/hiring\/handoffs$/,
  /^\/r23\/api\/organizations\/[^/]+\/hiring\/builder\/generate$/,
  /^\/r23\/api\/organizations\/[^/]+\/hiring\/sessions\/[^/]+\/review$/,
];

const HIRING_PLATFORM_POST_PATTERNS: readonly RegExp[] = [
  /^\/api\/theme$/,
  /^\/api\/telemetry$/,
  /^\/api\/feedback$/,
  /^\/r23\/account$/,
  /^\/r23\/organizations\/[^/]+\/plan$/,
  /^\/api\/candidate-portal$/,
  /^\/r26\/api\/candidate\/[^/]+\/ai$/,
  /^\/r23\/api\/organizations\/[^/]+\/hiring\/plan$/,
  /^\/r23\/api\/organizations\/[^/]+\/hiring\/builder\/generate$/,
  /^\/r23\/api\/organizations\/[^/]+\/hiring\/library$/,
  /^\/r23\/api\/organizations\/[^/]+\/hiring\/issue$/,
  /^\/r23\/api\/organizations\/[^/]+\/hiring\/handoffs$/,
  /^\/r23\/api\/organizations\/[^/]+\/hiring\/sessions\/[^/]+\/review$/,
];

const HIRING_PLATFORM_DELETE_PATTERNS: readonly RegExp[] = [
  /^\/r23\/api\/organizations\/[^/]+\/hiring\/builder\/generate$/,
];

function isAllowedAuthenticatedStagingRequest(
  method: string,
  pathname: string,
): boolean {
  const hiring = isHiringPlatformEnabled();
  if (
    (method === 'GET' || method === 'HEAD') &&
    (pathname.startsWith('/_next/') ||
      pathname === '/software-ui.css' ||
      (hiring && pathname === '/hiring-platform.css') ||
      pathname === '/fonts/dm-sans-latin.woff2' ||
      pathname === '/fonts/newsreader-latin.woff2' ||
      pathname === '/fonts/jetbrains-mono-latin.woff2' ||
      pathname === '/favicon.ico')
  ) {
    return true;
  }
  if (method === 'GET' || method === 'HEAD') {
    return (
      STAGING_BROWSER_GET_PATTERNS.some((pattern) => pattern.test(pathname)) ||
      (hiring &&
        HIRING_PLATFORM_GET_PATTERNS.some((pattern) => pattern.test(pathname)))
    );
  }
  if (method === 'POST') {
    return (
      STAGING_BROWSER_POST_PATTERNS.some((pattern) => pattern.test(pathname)) ||
      (hiring &&
        HIRING_PLATFORM_POST_PATTERNS.some((pattern) => pattern.test(pathname)))
    );
  }
  if (method === 'PUT') {
    return STAGING_BROWSER_PUT_PATTERNS.some((pattern) =>
      pattern.test(pathname),
    );
  }
  if (method === 'PATCH') {
    return STAGING_BROWSER_PATCH_PATTERNS.some((pattern) =>
      pattern.test(pathname),
    );
  }
  if (method === 'DELETE') {
    return (
      STAGING_BROWSER_DELETE_PATTERNS.some((pattern) =>
        pattern.test(pathname),
      ) ||
      (hiring &&
        HIRING_PLATFORM_DELETE_PATTERNS.some((pattern) =>
          pattern.test(pathname),
        ))
    );
  }
  return false;
}

function isAllowedPublicPreviewRequest(
  method: string,
  pathname: string,
): boolean {
  if (method === 'GET' || method === 'HEAD') {
    return (
      PUBLIC_PREVIEW_GET_PATHS.has(pathname) ||
      pathname === '/api/health' ||
      pathname === '/favicon.ico' ||
      pathname.startsWith('/_next/static/') ||
      pathname.startsWith('/fonts/') ||
      pathname.startsWith('/software/icons/')
    );
  }
  return method === 'POST' && pathname === '/api/early-access';
}

function isFounderUatRoute(method: string, pathname: string): boolean {
  if ((method === 'GET' || method === 'HEAD') && pathname === '/') {
    return isFounderUatEnabled();
  }
  if (method === 'GET' || method === 'HEAD') {
    return (
      pathname === '/r23/mail' ||
      pathname === '/api/founder-uat/mail' ||
      /^\/api\/founder-uat\/mail\/template\/(confirmation|recovery)$/.test(
        pathname,
      ) ||
      (isFounderUatEnabled() &&
        (pathname === '/r23/intelligence' || pathname === '/api/intelligence'))
    );
  }
  return (
    method === 'POST' &&
    /^\/api\/founder-uat\/(mail\/consume|invitations\/context|auth\/reset-password)$/.test(
      pathname,
    )
  );
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicPreview()) {
    if (isAllowedPublicPreviewRequest(request.method, pathname)) {
      return NextResponse.next();
    }
    return NextResponse.json(
      {
        error: {
          code: 'PREVIEW_ROUTE_UNAVAILABLE',
          message: 'This route is unavailable in the public preview.',
        },
      },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (
    isStagingLockdown() &&
    !(
      request.method === 'GET' &&
      (pathname === '/api/health' || pathname === '/api/staging/readiness')
    ) &&
    !(
      isAuthenticatedStaging() &&
      isAllowedAuthenticatedStagingRequest(request.method, pathname)
    ) &&
    !isFounderUatRoute(request.method, pathname)
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
