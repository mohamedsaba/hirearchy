import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteEventStore } from '../../apps/web/src/events/sqlite-event-store';
import { SqliteEvidenceReconstructionStore } from '../../apps/web/src/reconstruction/sqlite-evidence-reconstruction-store';
import { EvidenceReconstructionService } from '../../apps/web/src/reconstruction/evidence-reconstruction-service';
import { DeterministicEvidenceReconstructionGenerator } from '../../apps/web/src/reconstruction/deterministic-evidence-reconstruction-generator';
import { buildReconstructionView } from '../../apps/web/src/reconstruction/evidence-reconstruction-runtime';
import { buildEvaluatorBriefing } from '../../apps/web/src/evaluator/build-evaluator-briefing';
import { projectBriefing } from '../../apps/web/src/evaluator/project-evaluator-briefing';
import { createSignedEvaluatorToken } from '../../apps/web/src/access/evaluator-access';
import { scenario001 } from '../../apps/web/src/scenarios/scenario-001';
import { scenario001SemanticSnapshot } from '../../apps/web/src/scenarios/scenario-semantic-snapshot';
import { GET } from '../../apps/web/app/api/evaluator/sessions/[sessionId]/briefing/route';
import { readBriefingFixture } from '../support/evaluator-briefing-fixtures';

const state = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (state.cookie ? { value: state.cookie } : undefined),
  }),
}));
const directories: string[] = [];
const databasePath = () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'hirearchy-briefing-integration-'),
  );
  directories.push(directory);
  return path.join(directory, 'sessions.sqlite');
};
afterEach(() => {
  vi.unstubAllEnvs();
  state.cookie = undefined;
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    );
});

const rehydrateGate = (caseId: 'D' | 'F' | 'G', dbPath: string) => {
  new SqliteSessionStore(dbPath).findById('missing');
  const fixture = JSON.parse(
    readFileSync(`tests/fixtures/evaluator-gate/${caseId}.json`, 'utf8'),
  );
  const db = new Database(dbPath);
  const row = { ...fixture.sessionRow };
  if (caseId === 'G') {
    db.exec(
      'ALTER TABLE assessment_sessions DROP COLUMN scenario_evaluation_context',
    );
    db.exec(
      'ALTER TABLE assessment_sessions DROP COLUMN scenario_semantic_snapshot',
    );
    delete row.scenario_evaluation_context;
  }
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO assessment_sessions (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
  ).run(...Object.values(row));
  db.close();
  const events = new SqliteEventStore(dbPath);
  for (const event of fixture.evidence.events) events.append(event);
  return new SessionService(new SqliteSessionStore(dbPath), {
    eventStore: events,
  });
};

describe('immutable semantic snapshot migration', () => {
  it('snapshots new sessions independently, survives reload/submission and never updates the frozen metadata', async () => {
    const dbPath = databasePath();
    const store = new SqliteSessionStore(dbPath);
    const service = new SessionService(store);
    const { session } = service.createSession({ scenarioId: 'scenario-001' });
    expect(session.scenario.semanticSnapshot).toEqual(
      scenario001SemanticSnapshot,
    );
    expect(session.scenario.semanticSnapshot).not.toBe(
      scenario001.semanticSnapshot,
    );
    const frozen = structuredClone(session.scenario.semanticSnapshot);
    (
      session.scenario.semanticSnapshot as { contentVersion: string }
    ).contentVersion = '2.0.0';
    const loaded = store.findById(session.id)!;
    expect(loaded.scenario.semanticSnapshot).toEqual(frozen);
    store.activate(loaded.candidateTokenHash, '2026-09-17T00:00:00Z');
    store.submit(loaded.candidateTokenHash, '2026-09-17T00:01:00Z', '');
    expect(
      new SqliteSessionStore(dbPath).findById(session.id)?.scenario
        .semanticSnapshot,
    ).toEqual(frozen);
  });
  it('adds a nullable column to legacy records without backfilling context or semantics', () => {
    const dbPath = databasePath();
    const service = rehydrateGate('G', dbPath);
    const fixture = readBriefingFixture('G');
    const evidence = service.getSubmittedEvidence(fixture.evidence.sessionId);
    expect(evidence.scenario.semanticSnapshot).toBeUndefined();
    expect(evidence.scenario.evaluationContext).toBeUndefined();
    expect(evidence.diff).toBe(fixture.evidence.diff);
    const db = new Database(dbPath, { readonly: true });
    expect(
      db
        .prepare(
          'SELECT scenario_semantic_snapshot FROM assessment_sessions WHERE id = ?',
        )
        .get(evidence.sessionId),
    ).toEqual({ scenario_semantic_snapshot: null });
    db.close();
  });
  it.each([
    '{"schemaVersion":999}',
    'not-json',
    '{"schemaVersion":1,"scores":[10]}',
  ])(
    'keeps unsupported stored semantics explicit and the record readable: %s',
    (stored) => {
      const dbPath = databasePath();
      const service = rehydrateGate('G', dbPath);
      const id = readBriefingFixture('G').evidence.sessionId;
      service.getSubmittedEvidence(id);
      const db = new Database(dbPath);
      db.prepare(
        'UPDATE assessment_sessions SET scenario_semantic_snapshot = ? WHERE id = ?',
      ).run(stored, id);
      db.close();
      const evidence = service.getSubmittedEvidence(id);
      const briefing = buildEvaluatorBriefing(evidence, {
        status: 'NOT_STARTED',
        record: null,
        legacyArtifacts: [],
      });
      expect(briefing.artifactAvailability.semantics).toBe('unsupported');
      expect(briefing.submittedState.changedPaths).toEqual([
        'inventory/service.py',
      ]);
    },
  );
  it('rejects invalid authored semantics instead of persisting an authoritative-looking snapshot', () => {
    const dbPath = databasePath();
    const store = new SqliteSessionStore(dbPath);
    const { session } = new SessionService(store).createSession();
    expect(() =>
      store.create({
        ...session,
        id: 'invalid-snapshot',
        candidateTokenHash: 'invalid-token-hash',
        scenario: {
          ...session.scenario,
          semanticSnapshot: { schemaVersion: 999 },
        },
      }),
    ).toThrow();
    expect(store.findById('invalid-snapshot')).toBeNull();
  });
});

describe('authorized briefing read and preserved reconstruction', () => {
  it.each(['D', 'F', 'G'] as const)(
    'rehydrates %s through real stores and retains exact v3 output',
    async (caseId) => {
      const dbPath = databasePath();
      const service = rehydrateGate(caseId, dbPath);
      const fixture = readBriefingFixture(caseId);
      const reconstructionStore = new SqliteEvidenceReconstructionStore(dbPath);
      const record = await new EvidenceReconstructionService(
        reconstructionStore,
        new DeterministicEvidenceReconstructionGenerator(),
        (id) => service.getSubmittedEvidence(id),
      ).ensure(fixture.evidence.sessionId);
      expect(record.content).toEqual(fixture.reconstruction.record?.content);
      const evidence = service.getSubmittedEvidence(fixture.evidence.sessionId);
      const briefing = buildEvaluatorBriefing(
        evidence,
        buildReconstructionView(reconstructionStore, evidence.sessionId),
      );
      expect(briefing.provenance.finalDiffSha256).toBe(
        fixture.reconstruction.record?.finalDiffSha256,
      );
      expect(briefing.submittedState.evidenceRefs).toEqual([
        `session:${evidence.sessionId}:final-diff`,
      ]);
      vi.stubEnv('HIREARCHY_DB_PATH', dbPath);
      vi.stubEnv('HIREARCHY_EVALUATOR_KEY', 'briefing-key');
      const request = (depth = '') =>
        GET(
          new Request(
            `http://localhost/api/evaluator/sessions/${evidence.sessionId}/briefing${depth}`,
          ),
          { params: Promise.resolve({ sessionId: evidence.sessionId }) },
        );
      expect((await request()).status).toBe(401);
      state.cookie = createSignedEvaluatorToken('different-key');
      expect((await request()).status).toBe(401);
      state.cookie = createSignedEvaluatorToken('briefing-key');
      const base = await request();
      expect(base.status).toBe(200);
      expect(base.headers.get('cache-control')).toBe('private, no-store');
      expect(await base.json()).toEqual(briefing);
      const projected = await request('?depth=GENERALIST_RECRUITER');
      expect(projected.status).toBe(200);
      expect(await projected.json()).toEqual(
        projectBriefing(briefing, 'GENERALIST_RECRUITER'),
      );
      expect((await request('?depth=ADMIN')).status).toBe(400);
      expect(
        reconstructionStore.getBySessionId(
          evidence.sessionId,
          record.promptVersion,
        )?.content,
      ).toEqual(record.content);
    },
  );
});
