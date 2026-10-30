/**
 * R2.8 persistent candidate file revision contract.
 *
 * Defines the authoritative shape of captured candidate mutations and
 * on-demand evaluator revision projections.
 */

export type R28RevisionAvailability = 'available' | 'unavailable';

export type R28RevisionProvenance =
  'hirearchy.candidate_file_revisions' | 'hirearchy.candidate_session_events';

export type R28CandidateRevision = Readonly<{
  organizationId: string;
  sessionId: string;
  filePath: string;
  version: string;
  requestId: string;
  eventSequence: string;
  acceptedAt: string;
  contentEncoding: 'utf-8';
  content: string | null;
  contentLength: number;
  contentDigest: string;
  previousVersion: string;
  previousDigest: string;
  previousContent: string | null;
  starterContent: string | null;
  submittedContent: string | null;
  isSubmitted: boolean;
  availability: R28RevisionAvailability;
  provenance: R28RevisionProvenance;
  limitations?: readonly string[];
}>;

export type R28RevisionQuery = Readonly<{
  sequence: string;
}>;
