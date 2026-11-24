import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import {
  candidateEntryPath,
  candidateSignInPath,
} from '../../../../src/hiring/candidate-entry';
import { isHiringPlatformEnabled } from '../../../../src/runtime/profile';
import { tryReadHiringAccountFromCookie } from '../../../../src/staging/browser';
import { BrandMark } from '../../../_components/brand-mark';
import { LocalTime } from '../../../_components/local-time';
import { ThemeToggle } from '../../../_components/theme-toggle';
import { RepositoryInspector } from '../../../r23/organizations/[organizationId]/builder/repository-inspector';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Submitted work',
  referrer: 'no-referrer' as const,
};

export default async function CandidateSubmissionPage({
  params,
}: Readonly<{ params: Promise<{ sessionId: string }> }>) {
  const { sessionId } = await params;
  const entryPath = candidateEntryPath(`/candidate/submissions/${sessionId}`);
  if (!isHiringPlatformEnabled() || !entryPath) notFound();

  const account = await tryReadHiringAccountFromCookie(
    (await cookies()).toString(),
  );
  if (!account) redirect(candidateSignInPath(entryPath));

  const submission = (await account.dispatch(
    'candidate.session.submitted_read',
    {
      sessionId,
    },
  )) as Readonly<{
    title: string;
    submittedAt: string;
    files: readonly { path: string; content: string }[];
  }> | null;
  if (!submission) notFound();

  return (
    <div className="software-product software-document-body">
      <a className="software-skip-link" href="#submitted-work">
        Skip to submitted work
      </a>
      <header className="software-document-header">
        <Link
          href="/candidate"
          className="software-document-wordmark"
          aria-label="Hirearchy Software assessments"
        >
          <BrandMark />
          <span>Hirearchy</span>
          <span className="software-document-product">Software</span>
        </Link>
        <ThemeToggle variant="header" />
      </header>
      <main
        className="hiring-portal-main hiring-page-shell"
        id="submitted-work"
        tabIndex={-1}
      >
        <Link href="/candidate" className="hiring-muted-copy">
          ← My assessments
        </Link>
        <header className="hiring-page-header">
          <div>
            <h1>{submission.title}</h1>
            <p>
              Submitted <LocalTime timestamp={submission.submittedAt} />
            </p>
          </div>
          <span className="hiring-pill hiring-pill-success">
            Submitted · Read-only
          </span>
        </header>
        {submission.files.length ? (
          <RepositoryInspector
            files={submission.files}
            workspaceName="Submitted files"
            label="Submitted files"
          />
        ) : (
          <p>No files were saved with this submission.</p>
        )}
      </main>
    </div>
  );
}
