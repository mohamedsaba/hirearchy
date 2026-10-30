import { createTwoFilesPatch } from 'diff';

import type { R28CandidateRevision } from '../../../../database/postgres/r28/contract.mjs';

export type R28ComparisonMode =
  'content' | 'previous' | 'starter' | 'submitted';

export type R28RevisionPresentation = Readonly<{
  filePath: string;
  version: string;
  previousVersion: string;
  acceptedAt: string;
  requestId: string;
  eventSequence: string;
  contentDigest: string;
  previousDigest: string;
  isSubmitted: boolean;
  availability: R28CandidateRevision['availability'];
  provenance: R28CandidateRevision['provenance'];
  statusBadge: string;
  content: string | null;
  diffWithPrevious: string | null;
  diffWithStarter: string | null;
  diffWithSubmitted: string | null;
  notice: string | null;
  hasPrevious: boolean;
  hasStarter: boolean;
  hasSubmitted: boolean;
}>;

export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function diffWithPrevious(
  revision: R28CandidateRevision,
): string | null {
  if (
    revision.availability === 'unavailable' ||
    revision.content === null ||
    revision.previousContent === null
  ) {
    return null;
  }

  return createTwoFilesPatch(
    `a/${revision.filePath}`,
    `b/${revision.filePath}`,
    normalizeLineEndings(revision.previousContent),
    normalizeLineEndings(revision.content),
    `version ${revision.previousVersion}`,
    `version ${revision.version}`,
  );
}

export function diffWithStarter(revision: R28CandidateRevision): string | null {
  if (
    revision.availability === 'unavailable' ||
    revision.content === null ||
    revision.starterContent === null
  ) {
    return null;
  }

  return createTwoFilesPatch(
    `a/${revision.filePath}`,
    `b/${revision.filePath}`,
    normalizeLineEndings(revision.starterContent),
    normalizeLineEndings(revision.content),
    'starter baseline',
    `version ${revision.version}`,
  );
}

export function diffWithSubmitted(
  revision: R28CandidateRevision,
): string | null {
  if (
    revision.availability === 'unavailable' ||
    revision.content === null ||
    revision.submittedContent === null
  ) {
    return null;
  }

  return createTwoFilesPatch(
    `a/${revision.filePath}`,
    `b/${revision.filePath}`,
    normalizeLineEndings(revision.content),
    normalizeLineEndings(revision.submittedContent),
    `version ${revision.version}`,
    'submitted',
  );
}

export function buildR28RevisionPresentation(
  revision: R28CandidateRevision,
): R28RevisionPresentation {
  const isAvailable =
    revision.availability === 'available' && revision.content !== null;
  const statusBadge = revision.isSubmitted
    ? 'Final submitted version'
    : `Intermediate save v${revision.version}`;

  if (!isAvailable) {
    return {
      filePath: revision.filePath,
      version: revision.version,
      previousVersion: revision.previousVersion,
      acceptedAt: revision.acceptedAt,
      requestId: revision.requestId,
      eventSequence: revision.eventSequence,
      contentDigest: revision.contentDigest,
      previousDigest: revision.previousDigest,
      isSubmitted: revision.isSubmitted,
      availability: 'unavailable',
      provenance: revision.provenance,
      statusBadge,
      content: null,
      diffWithPrevious: null,
      diffWithStarter: null,
      diffWithSubmitted: null,
      notice:
        'This save is retained as sequence and digest metadata. Intermediate file content is unavailable.',
      hasPrevious: false,
      hasStarter: false,
      hasSubmitted: false,
    };
  }

  const prevDiff = diffWithPrevious(revision);
  const starterDiff = diffWithStarter(revision);
  const submittedDiff = diffWithSubmitted(revision);

  return {
    filePath: revision.filePath,
    version: revision.version,
    previousVersion: revision.previousVersion,
    acceptedAt: revision.acceptedAt,
    requestId: revision.requestId,
    eventSequence: revision.eventSequence,
    contentDigest: revision.contentDigest,
    previousDigest: revision.previousDigest,
    isSubmitted: revision.isSubmitted,
    availability: 'available',
    provenance: revision.provenance,
    statusBadge,
    content: revision.content,
    diffWithPrevious: prevDiff,
    diffWithStarter: starterDiff,
    diffWithSubmitted: submittedDiff,
    notice: null,
    hasPrevious: prevDiff !== null,
    hasStarter: starterDiff !== null,
    hasSubmitted: submittedDiff !== null,
  };
}
