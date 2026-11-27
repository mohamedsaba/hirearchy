import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { serializePlatformTemplates } from '../../../../../../src/hiring/templates';
import type { SavedLibraryProblem } from '../../../../../../src/hiring/types';
import { isHiringPlatformEnabled } from '../../../../../../src/runtime/profile';
import { loadHiringOrganizationWorkspaceFromCookie } from '../../../../../../src/staging/browser';
import { OrganizationWorkspaceShell } from '../../../../_components/workspace-shell';
import { CandidatePreviewClient } from './candidate-preview-client';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
export const metadata: Metadata = { title: 'Preview as Candidate' };

export default async function CandidatePreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams?: Promise<{
    draft?: string | string[];
    template?: string | string[];
    definitionId?: string | string[];
  }>;
}) {
  if (!isHiringPlatformEnabled()) {
    notFound();
  }
  const { organizationId } = await params;
  const query = await searchParams;
  const draftId = typeof query?.draft === 'string' ? query.draft : undefined;
  const templateId =
    typeof query?.template === 'string' ? query.template : undefined;
  const definitionId =
    typeof query?.definitionId === 'string' ? query.definitionId : undefined;

  const incomingHeaders = await headers();
  const workspace = await loadHiringOrganizationWorkspaceFromCookie(
    incomingHeaders.get('cookie') ?? '',
    organizationId,
  );
  if (!workspace) {
    redirect(
      `/r23/login?next=${encodeURIComponent(`/r23/organizations/${organizationId.toLowerCase()}/builder/candidate-preview`)}`,
    );
  }

  let matchedProblem: SavedLibraryProblem | null = null;
  if (definitionId) {
    try {
      const libraryRes = (await workspace.dispatch('hiring.library.list', {
        organizationId: workspace.organizationId,
      })) as { problems?: SavedLibraryProblem[] } | null;
      matchedProblem =
        libraryRes?.problems?.find(
          (item) => item.definitionId === definitionId,
        ) ?? null;
    } catch {
      matchedProblem = null;
    }
  }

  return (
    <OrganizationWorkspaceShell
      organizationId={workspace.organizationId}
      organizationName={workspace.organizationName}
      email={workspace.email}
      role={workspace.role}
      csrf={workspace.csrfToken}
      active="builder"
      plan={workspace.plan}
    >
      <CandidatePreviewClient
        organizationId={workspace.organizationId}
        organizationName={workspace.organizationName}
        initialTemplates={serializePlatformTemplates()}
        draftId={draftId}
        templateId={templateId}
        matchedProblem={matchedProblem}
      />
    </OrganizationWorkspaceShell>
  );
}
