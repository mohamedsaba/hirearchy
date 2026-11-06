export type R23CandidateInvitationStatus =
  'not_created' | 'active' | 'expired' | 'revoked' | 'unmanaged';

export type R23CandidateInvitationResponse = Readonly<{
  sessionId: string;
  status: R23CandidateInvitationStatus;
  expiresAt: string | null;
  candidatePath: string | null;
}>;

export type R23CandidateInvitationRevocationResponse = Readonly<{
  sessionId: string;
  status: 'revoked' | 'not_created' | 'unmanaged';
}>;
