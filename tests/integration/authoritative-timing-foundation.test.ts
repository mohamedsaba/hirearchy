import Database from 'better-sqlite3';
import { migrateLegacyCandidateTokens } from '../../apps/web/src/sessions/candidate-token-storage.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scenario001 } from '../../apps/web/src/scenarios/scenario-001';
import {
  type ScenarioSnapshot,
  sliceOneScenario,
} from '../../apps/web/src/scenarios/slice-one-scenario';
import { SessionError } from '../../apps/web/src/sessions/session';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { deriveSessionDeadline } from '../../apps/web/src/sessions/session-timing';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

const createLegacySessionDatabase = (databasePath: string) => {
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE assessment_sessions (
      id TEXT PRIMARY KEY,
      candidate_token_hash TEXT NOT NULL UNIQUE,
      scenario_id TEXT NOT NULL,
      scenario_version TEXT NOT NULL,
      scenario_title TEXT NOT NULL,
      scenario_brief TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL,
      file_path TEXT NOT NULL,
      original_content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('CREATED', 'ACTIVE', 'SUBMITTED')),
      working_content TEXT NOT NULL,
      submitted_content TEXT,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      submitted_at TEXT,
      scenario_type TEXT DEFAULT 'single_file',
      submitted_diff TEXT,
      scenario_evaluation_context TEXT,
      scenario_semantic_snapshot TEXT,
      ai_capability_snapshot TEXT
    );
  `);

  // 1. Historical submitted session
  database
    .prepare(
      `INSERT INTO assessment_sessions (
        id, candidate_token_hash, scenario_id, scenario_version, scenario_title,
        scenario_brief, acceptance_criteria, file_path, original_content, status,
        working_content, submitted_content, created_at, activated_at, submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'hist-submitted',
      'a'.repeat(64),
      'slice-1-greeting-format',
      '1.0.0',
      'Title',
      'Brief',
      JSON.stringify(['Criterion 1']),
      'src/file.ts',
      'original',
      'SUBMITTED',
      'working',
      'submitted',
      '2026-09-01T10:00:00.000Z',
      '2026-09-01T10:01:00.000Z',
      '2026-09-01T10:20:00.000Z',
    );

  // 2. Historical active session
  database
    .prepare(
      `INSERT INTO assessment_sessions (
        id, candidate_token_hash, scenario_id, scenario_version, scenario_title,
        scenario_brief, acceptance_criteria, file_path, original_content, status,
        working_content, submitted_content, created_at, activated_at, submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'hist-active',
      'b'.repeat(64),
      'slice-1-greeting-format',
      '1.0.0',
      'Title',
      'Brief',
      JSON.stringify(['Criterion 1']),
      'src/file.ts',
      'original',
      'ACTIVE',
      'working',
      null,
      '2026-09-01T11:00:00.000Z',
      '2026-09-01T11:01:00.000Z',
      null,
    );

  // 3. Historical created session
  database
    .prepare(
      `INSERT INTO assessment_sessions (
        id, candidate_token_hash, scenario_id, scenario_version, scenario_title,
        scenario_brief, acceptance_criteria, file_path, original_content, status,
        working_content, submitted_content, created_at, activated_at, submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'hist-created',
      'c'.repeat(64),
      'slice-1-greeting-format',
      '1.0.0',
      'Title',
      'Brief',
      JSON.stringify(['Criterion 1']),
      'src/file.ts',
      'original',
      'CREATED',
      'original',
      null,
      '2026-09-01T12:00:00.000Z',
      null,
      null,
    );

  database.close();
  const adoption = new Database(databasePath);
  try {
    migrateLegacyCandidateTokens(adoption, { adoptExisting: true });
  } finally {
    adoption.close();
  }
};

describe('T1A.1 authoritative timing foundation', () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-timing-'));
    databasePath = path.join(directory, 'hirearchy.sqlite');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  describe('migration requirements (1-5)', () => {
    it('1-4. migrates legacy database successfully, keeps duration null, backfills submitted sessions, and preserves active sessions', () => {
      createLegacySessionDatabase(databasePath);

      const store = new SqliteSessionStore(databasePath);

      // Rehydrate historical submitted session
      const histSubmitted = store.findById('hist-submitted');
      expect(histSubmitted).not.toBeNull();
      // Test 2: Historical duration remains NULL
      expect(histSubmitted?.durationSeconds).toBeNull();
      // Test 3: Historical SUBMITTED gets candidate_submission
      expect(histSubmitted?.closureReason).toBe('candidate_submission');

      // Rehydrate historical active session
      const histActive = store.findById('hist-active');
      expect(histActive).not.toBeNull();
      // Test 2: Historical duration remains NULL
      expect(histActive?.durationSeconds).toBeNull();
      // Test 4: Historical ACTIVE remains closureReason null
      expect(histActive?.closureReason).toBeNull();

      // Rehydrate historical created session
      const histCreated = store.findById('hist-created');
      expect(histCreated).not.toBeNull();
      expect(histCreated?.durationSeconds).toBeNull();
      expect(histCreated?.closureReason).toBeNull();
    });

    it('5. migration is safe and idempotent under repeated initialization', () => {
      createLegacySessionDatabase(databasePath);

      const db = new Database(databasePath);
      // Run ensureSchema once
      SqliteSessionStore.ensureSchema(db);
      // Run ensureSchema again (idempotent check)
      SqliteSessionStore.ensureSchema(db);
      db.close();

      const store = new SqliteSessionStore(databasePath);
      const histSubmitted = store.findById('hist-submitted');
      expect(histSubmitted?.closureReason).toBe('candidate_submission');
      expect(histSubmitted?.durationSeconds).toBeNull();
    });
  });

  describe('new session creation and duration snapshots (6-12)', () => {
    it('6-8. snapshots authoritative scenario duration into session for scenario001 and slice-one fixture', () => {
      const store = new SqliteSessionStore(databasePath);
      const service = new SessionService(store);

      // Test 7: Scenario 001 snapshots 3600
      const s001 = service.createSession({
        scenarioId: scenario001.id,
      });
      expect(s001.session.durationSeconds).toBe(3600);
      expect(s001.session.closureReason).toBeNull();
      const reloadedS001 = store.findById(s001.session.id);
      expect(reloadedS001?.durationSeconds).toBe(3600);
      expect(reloadedS001?.closureReason).toBeNull();

      // Test 8: Slice-one fixture snapshots 900
      const sSlice1 = service.createSession({
        scenarioId: 'slice-1-greeting-format',
      });
      expect(sSlice1.session.durationSeconds).toBe(900);
      expect(sSlice1.session.closureReason).toBeNull();
      const reloadedSlice1 = store.findById(sSlice1.session.id);
      expect(reloadedSlice1?.durationSeconds).toBe(900);
      expect(reloadedSlice1?.closureReason).toBeNull();
    });

    it('9. missing duration fails session creation', () => {
      const store = new SqliteSessionStore(databasePath);
      const service = new SessionService(store);

      const invalidScenario = {
        ...sliceOneScenario,
        durationSeconds: undefined as unknown as number,
      };

      expect(() =>
        service.createSession({ scenario: invalidScenario }),
      ).toThrowError(
        new SessionError(
          'INVALID_SCENARIO_DURATION',
          'Scenario duration must be a positive integer.',
        ),
      );
    });

    it('10. zero duration fails session creation', () => {
      const store = new SqliteSessionStore(databasePath);
      const service = new SessionService(store);

      const invalidScenario: ScenarioSnapshot = {
        ...sliceOneScenario,
        durationSeconds: 0,
      };

      expect(() =>
        service.createSession({ scenario: invalidScenario }),
      ).toThrowError(
        new SessionError(
          'INVALID_SCENARIO_DURATION',
          'Scenario duration must be a positive integer.',
        ),
      );
    });

    it('11. negative duration fails session creation', () => {
      const store = new SqliteSessionStore(databasePath);
      const service = new SessionService(store);

      const invalidScenario: ScenarioSnapshot = {
        ...sliceOneScenario,
        durationSeconds: -60,
      };

      expect(() =>
        service.createSession({ scenario: invalidScenario }),
      ).toThrowError(
        new SessionError(
          'INVALID_SCENARIO_DURATION',
          'Scenario duration must be a positive integer.',
        ),
      );
    });

    it('12. non-integer duration fails session creation', () => {
      const store = new SqliteSessionStore(databasePath);
      const service = new SessionService(store);

      const invalidScenario: ScenarioSnapshot = {
        ...sliceOneScenario,
        durationSeconds: 120.5,
      };

      expect(() =>
        service.createSession({ scenario: invalidScenario }),
      ).toThrowError(
        new SessionError(
          'INVALID_SCENARIO_DURATION',
          'Scenario duration must be a positive integer.',
        ),
      );
    });
  });

  describe('snapshot immutability (13)', () => {
    it('13. changing scenario object duration after creation does not mutate persisted session duration', () => {
      const store = new SqliteSessionStore(databasePath);
      const service = new SessionService(store);

      const mutableScenario: ScenarioSnapshot = {
        ...sliceOneScenario,
        durationSeconds: 900,
      };

      const { session } = service.createSession({ scenario: mutableScenario });
      expect(session.durationSeconds).toBe(900);

      // Mutate the scenario object post-creation
      (mutableScenario as { durationSeconds: number }).durationSeconds = 1800;

      // Persisted session remains immutable at 900
      const persisted = store.findById(session.id);
      expect(persisted?.durationSeconds).toBe(900);
      expect(session.durationSeconds).toBe(900);
    });
  });

  describe('deadline derivation (14-16)', () => {
    it('14. ACTIVE timed session produces exact derived deadline', async () => {
      const store = new SqliteSessionStore(databasePath);
      const service = new SessionService(store, {
        now: () => '2026-09-20T10:00:00.000Z',
      });

      const { candidateToken, session } = service.createSession({
        scenarioId: 'scenario-001-cache-staleness',
      });
      expect(session.durationSeconds).toBe(3600);

      const activated = await service.activate(candidateToken);
      expect(activated.activatedAt).toBe('2026-09-20T10:00:00.000Z');

      const deadline = deriveSessionDeadline(activated);
      expect(deadline).toBe('2026-09-20T11:00:00.000Z');
    });

    it('15. CREATED session has deadline null', () => {
      const store = new SqliteSessionStore(databasePath);
      const service = new SessionService(store);

      const { session } = service.createSession({
        scenarioId: 'scenario-001-cache-staleness',
      });
      expect(session.status).toBe('CREATED');
      expect(session.activatedAt).toBeNull();
      expect(deriveSessionDeadline(session)).toBeNull();
    });

    it('16. legacy duration-null session has deadline null', () => {
      createLegacySessionDatabase(databasePath);
      const store = new SqliteSessionStore(databasePath);

      const legacyActive = store.findById('hist-active');
      expect(legacyActive).not.toBeNull();
      expect(legacyActive?.activatedAt).toBe('2026-09-01T11:01:00.000Z');
      expect(legacyActive?.durationSeconds).toBeNull();

      expect(deriveSessionDeadline(legacyActive!)).toBeNull();
    });
  });

  describe('candidate timing service projection', () => {
    it('exposes minimal timing projection with service serverTime', async () => {
      let currentTime = '2026-09-20T12:00:00.000Z';
      const store = new SqliteSessionStore(databasePath);
      const service = new SessionService(store, {
        now: () => currentTime,
      });

      const { candidateToken } = service.createSession({
        scenarioId: 'slice-1-greeting-format',
      });

      // While CREATED:
      const createdTiming = service.getCandidateTiming(candidateToken);
      expect(createdTiming).toEqual({
        durationSeconds: 900,
        activatedAt: null,
        deadline: null,
        serverTime: '2026-09-20T12:00:00.000Z',
        status: 'CREATED',
        closureReason: null,
      });

      // Activate session at 12:01
      currentTime = '2026-09-20T12:01:00.000Z';
      await service.activate(candidateToken);

      // Check timing at 12:05
      currentTime = '2026-09-20T12:05:00.000Z';
      const activeTiming = service.getCandidateTiming(candidateToken);
      expect(activeTiming).toEqual({
        durationSeconds: 900,
        activatedAt: '2026-09-20T12:01:00.000Z',
        deadline: '2026-09-20T12:16:00.000Z',
        serverTime: '2026-09-20T12:05:00.000Z',
        status: 'ACTIVE',
        closureReason: null,
      });

      // Submit session at 12:10
      currentTime = '2026-09-20T12:10:00.000Z';
      await service.submit(candidateToken);

      const submittedTiming = service.getCandidateTiming(candidateToken);
      expect(submittedTiming).toEqual({
        durationSeconds: 900,
        activatedAt: '2026-09-20T12:01:00.000Z',
        deadline: '2026-09-20T12:16:00.000Z',
        serverTime: '2026-09-20T12:10:00.000Z',
        status: 'SUBMITTED',
        closureReason: 'candidate_submission',
      });
    });
  });
});
