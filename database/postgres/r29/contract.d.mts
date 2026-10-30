/**
 * R2.9 structured evaluator observation contract.
 *
 * Defines the authoritative shape of anchored reviewer observations,
 * audit history, and optimistic concurrency mutations.
 */

export type R29EvidenceSourceType = 'timeline_event' | 'file_revision';

export type R29ObservationVisibility = 'private';

export interface R29ObservationHistoryEntry {
  readonly historyId: string;
  readonly observationId: string;
  readonly version: number;
  readonly body: string;
  readonly evidenceSourceType: R29EvidenceSourceType;
  readonly eventSequence: string;
  readonly filePath: string | null;
  readonly fileVersion: string | null;
  readonly evidenceDigest: string;
  readonly visibility: R29ObservationVisibility;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly recordedAt: string;
}

export interface R29EvaluatorObservation {
  readonly id: string;
  readonly organizationId: string;
  readonly sessionId: string;
  readonly authorPrincipalId: string;
  readonly evidenceSourceType: R29EvidenceSourceType;
  readonly eventSequence: string;
  readonly filePath: string | null;
  readonly fileVersion: string | null;
  readonly evidenceDigest: string;
  readonly body: string;
  readonly version: number;
  readonly visibility: R29ObservationVisibility;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly history?: readonly R29ObservationHistoryEntry[];
}

export interface R29CreateObservationInput {
  readonly evidenceSourceType: R29EvidenceSourceType;
  readonly eventSequence: string;
  readonly filePath?: string | null;
  readonly fileVersion?: string | null;
  readonly evidenceDigest: string;
  readonly body: string;
}

export interface R29UpdateObservationInput {
  readonly expectedVersion: number;
  readonly body: string;
}
