import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { IconCheck } from '@tabler/icons-react';

import {
  candidateEntryPath,
  candidateSignInPath,
} from '../../../../src/hiring/candidate-entry';
import { isHiringPlatformEnabled } from '../../../../src/runtime/profile';
import { tryReadHiringAccountFromCookie } from '../../../../src/staging/browser';
import { LocalTime } from '../../../_components/local-time';
import { ProductFeedbackPulse } from '../../../_components/product-feedback-pulse';
import { ThemeToggle } from '../../../_components/theme-toggle';
import { RepositoryInspector } from '../../../r23/organizations/[organizationId]/builder/repository-inspector';
import './submitted-work.css';

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
    <div className="software-product software-document-body candidate-submitted">
      <a className="software-skip-link" href="#submitted-work">
        Skip to submitted work
      </a>
      <header className="software-document-header">
        <div className="candidate-submitted-brand">
          <Link
            href="/candidate"
            className="software-document-wordmark"
            aria-label="Hirearchy Software assessments"
          >
            <span>Hirearchy</span>
            <span className="software-document-product">Software</span>
          </Link>
          <span className="candidate-submitted-masthead-title">
            {submission.title}
          </span>
        </div>
        <div className="candidate-submitted-header-actions">
          <ThemeToggle variant="header" />
          <span>Submitted</span>
        </div>
      </header>
      <main
        className="candidate-submitted-main"
        id="submitted-work"
        tabIndex={-1}
      >
        <nav className="candidate-submitted-breadcrumb" aria-label="Breadcrumb">
          <Link href="/candidate">My assessments</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{submission.title}</span>
        </nav>
        <header className="candidate-submitted-receipt">
          <div className="candidate-submitted-confirmation">
            <IconCheck
              className="candidate-submitted-check"
              size={42}
              aria-hidden="true"
            />
            <div>
              <h1>Assessment submitted</h1>
              <p>
                <LocalTime timestamp={submission.submittedAt} absolute />
                {' · '}
                {submission.files.length}{' '}
                {submission.files.length === 1 ? 'file' : 'files'} captured
              </p>
            </div>
          </div>
          <Link href="/candidate" className="hiring-btn hiring-btn-primary">
            Back to My assessments
          </Link>
        </header>
        <ProductFeedbackPulse
          surface="candidate_post_submit"
          actorType="candidate"
          sessionId={sessionId}
          storageKey={`hirearchy:fb:candidate:${sessionId}`}
          title="How fair and smooth was this assessment workspace?"
          privacyNote="Private to Hirearchy to improve the platform — never shared with the hiring team."
          tags={[
            'Clear & realistic',
            'Smooth experience',
            'Instructions unclear',
            'Editor or test issue',
            'Time felt tight',
          ]}
        />
        {submission.files.length ? (
          <RepositoryInspector
            files={submission.files}
            label="Submitted files"
            submitted
          />
        ) : (
          <p>No files were saved with this submission.</p>
        )}
      </main>
    </div>
  );
}
