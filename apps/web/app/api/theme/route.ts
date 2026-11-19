import { NextRequest, NextResponse } from 'next/server';

export const THEME_COOKIE_NAME = 'hirearchy-theme';
export type HirearchyTheme = 'light' | 'dark';

function normalizeTheme(value: unknown): HirearchyTheme | null {
  if (value === 'dark' || value === 'light') {
    return value;
  }
  return null;
}

function sanitizeRedirectTarget(value: unknown, request: NextRequest): string {
  if (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\')
  ) {
    return value;
  }
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const parsed = new URL(referer);
      if (parsed.origin === request.nextUrl.origin) {
        const candidate = `${parsed.pathname}${parsed.search}`;
        if (candidate.startsWith('/') && !candidate.startsWith('//')) {
          return candidate;
        }
      }
    } catch {
      // Ignore malformed referer and fall back to workspace root.
    }
  }
  return '/r23/organizations';
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get('content-type') ?? '';
  let requestedTheme: HirearchyTheme | null = null;
  let nextPath: unknown = null;
  let isFormSubmission = false;

  if (contentType.includes('application/json')) {
    try {
      const body = (await request.json()) as {
        theme?: unknown;
        next?: unknown;
      };
      requestedTheme = normalizeTheme(body?.theme);
      nextPath = body?.next;
    } catch {
      requestedTheme = null;
    }
  } else {
    isFormSubmission = true;
    try {
      const formData = await request.formData();
      requestedTheme = normalizeTheme(formData.get('theme'));
      nextPath = formData.get('next');
    } catch {
      requestedTheme = null;
    }
  }

  const currentTheme = normalizeTheme(
    request.cookies.get(THEME_COOKIE_NAME)?.value,
  );
  const resolvedTheme: HirearchyTheme =
    requestedTheme ?? (currentTheme === 'dark' ? 'light' : 'dark');

  const prefersJson =
    !isFormSubmission ||
    (request.headers.get('accept')?.includes('application/json') &&
      !request.headers.get('accept')?.includes('text/html'));

  const response = prefersJson
    ? NextResponse.json({ theme: resolvedTheme }, { status: 200 })
    : NextResponse.redirect(
        new URL(sanitizeRedirectTarget(nextPath, request), request.url),
        303,
      );

  response.cookies.set(THEME_COOKIE_NAME, resolvedTheme, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    httpOnly: false,
  });

  return response;
}
