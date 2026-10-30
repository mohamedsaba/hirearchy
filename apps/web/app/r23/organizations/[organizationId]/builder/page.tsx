import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  loadAuthenticatedOrganizationSessionList,
  r211AssessmentDraftApiGet,
} from '../../../../../src/r23-auth/server';
import { AssessmentBuilderClient } from './assessment-builder-client';
import type { R211AssessmentDraft } from '../../../../../src/r211-builder/contract';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export default async function AssessmentBuilderPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const incomingHeaders = await headers();
  const cookie = incomingHeaders.get('cookie') ?? '';

  const request = new Request('https://hirearchy-builder.invalid/', {
    headers: {
      Accept: 'application/json',
      Cookie: cookie,
    },
  });

  let context;
  try {
    context = await loadAuthenticatedOrganizationSessionList(
      request,
      organizationId,
    );
  } catch {
    redirect('/r23/login');
  }

  // Role boundary: Only active recruiters can author and issue assessments
  if (context.membership.role !== 'recruiter') {
    notFound();
  }

  let initialDraft: R211AssessmentDraft | null = null;
  try {
    if (typeof r211AssessmentDraftApiGet === 'function') {
      const draftRes = await r211AssessmentDraftApiGet(request, organizationId);
      if (draftRes.ok) {
        const data = await draftRes.json();
        initialDraft = data?.draft ?? null;
      }
    }
  } catch {
    initialDraft = null;
  }

  return (
    <AssessmentBuilderClient
      organizationId={organizationId}
      csrfToken={context.csrfToken}
      initialDraft={initialDraft}
    />
  );
}
