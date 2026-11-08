import type { R26CandidateView } from '../../../../database/postgres/r26/adapter.mjs';

export const R26_CANDIDATE_DATA_NOTICE_VERSION = 'candidate-data-v1' as const;
export const R26_CANDIDATE_DATA_NOTICE_TEXT =
  'This workspace records saved code, revisions, task activity and submission for your assigned hiring team’s review. This demo uses synthetic data; do not enter secrets or real candidate information. AI assistance and code execution are unavailable in this demo.' as const;

export type R26CandidateCapabilities = Readonly<{
  ai: boolean;
  execution: boolean;
}>;

export type R26CandidateDataNotice = Readonly<{
  version: typeof R26_CANDIDATE_DATA_NOTICE_VERSION;
  digest: string;
  text: typeof R26_CANDIDATE_DATA_NOTICE_TEXT;
}>;

export type R26CandidateGetResponse = R26CandidateView &
  Readonly<{
    invitationExpiresAt: string | null;
    capabilities: R26CandidateCapabilities;
    dataNotice: R26CandidateDataNotice | null;
  }>;

export type R26CandidateActivationInput =
  | Readonly<{
      consent: Readonly<{
        version: typeof R26_CANDIDATE_DATA_NOTICE_VERSION;
        digest: string;
        accepted: true;
      }>;
    }>
  | Readonly<Record<string, never>>;
