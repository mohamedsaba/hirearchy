/**
 * R2.10 structured human review packet contract.
 *
 * Defines the authoritative shape of human review packets,
 * referenced evidence and observations, audit history, and optimistic concurrency.
 */

export type R210PacketStatus = 'DRAFT' | 'FINALIZED';

export interface R210ReferencedEvidence {
  readonly evidenceSourceType: 'timeline_event' | 'file_revision';
  readonly eventSequence: string;
  readonly filePath: string | null;
  readonly fileVersion: string | null;
  readonly evidenceDigest: string;
  readonly label?: string;
}

export interface R210ReviewPacketHistoryEntry {
  readonly historyId: string;
  readonly packetId: string;
  readonly organizationId: string;
  readonly sessionId: string;
  readonly authorPrincipalId: string;
  readonly status: R210PacketStatus;
  readonly version: number;
  readonly summary: string;
  readonly strengths: readonly string[];
  readonly concerns: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly referencedObservationIds: readonly string[];
  readonly referencedEvidence: readonly R210ReferencedEvidence[];
  readonly finalizedAt: string | null;
  readonly finalDigest: string | null;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly recordedAt: string;
}

export interface R210ReviewPacket {
  readonly id: string;
  readonly organizationId: string;
  readonly sessionId: string;
  readonly authorPrincipalId: string;
  readonly status: R210PacketStatus;
  readonly summary: string;
  readonly strengths: readonly string[];
  readonly concerns: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly referencedObservationIds: readonly string[];
  readonly referencedEvidence: readonly R210ReferencedEvidence[];
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finalizedAt: string | null;
  readonly finalDigest: string | null;
  readonly history?: readonly R210ReviewPacketHistoryEntry[];
}

export interface R210SaveDraftInput {
  readonly summary: string;
  readonly strengths: readonly string[];
  readonly concerns: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly referencedObservationIds: readonly string[];
  readonly referencedEvidence: readonly R210ReferencedEvidence[];
  readonly expectedVersion?: number;
}

export interface R210FinalizePacketInput {
  readonly expectedVersion: number;
}
