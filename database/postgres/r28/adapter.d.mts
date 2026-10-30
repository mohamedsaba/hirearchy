import type { R28CandidateRevision, R28RevisionQuery } from './contract.d.mts';

export declare function installR28RevisionFixture(clientOrPool: {
  query(sql: string): Promise<unknown>;
}): Promise<void>;
