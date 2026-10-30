import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { r26IsEnabled } from '../../../../src/r26-candidate/config';
import { R26CandidateClient } from './candidate-client';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Candidate workspace',
  referrer: 'no-referrer',
};

type CandidatePageProps = Readonly<{
  params: Promise<{ sessionId: string }>;
}>;

export default async function CandidatePage({ params }: CandidatePageProps) {
  const { sessionId } = await params;
  if (!r26IsEnabled() || !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    notFound();
  }

  return <R26CandidateClient sessionId={sessionId} />;
}
