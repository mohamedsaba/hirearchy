import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteEventStore } from '../../apps/web/src/events/sqlite-event-store';
import { SqliteEvidenceReconstructionStore } from '../../apps/web/src/reconstruction/sqlite-evidence-reconstruction-store';
import { EvidenceReconstructionService } from '../../apps/web/src/reconstruction/evidence-reconstruction-service';
import { DeterministicEvidenceReconstructionGenerator } from '../../apps/web/src/reconstruction/deterministic-evidence-reconstruction-generator';
import { buildEvaluatorReviewPresentation } from '../../apps/web/src/evaluator/evaluator-review-presentation';
import { buildReconstructionView } from '../../apps/web/src/reconstruction/evidence-reconstruction-runtime';
import EvidencePage from '../../apps/web/app/evaluator/sessions/[sessionId]/page';
import { createSignedEvaluatorToken } from '../../apps/web/src/access/evaluator-access';

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => ({ value: createSignedEvaluatorToken('fixture-evaluator-key') }),
  }),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/evaluator/sessions/fixture-session',
  useSearchParams: () => new URLSearchParams(),
}));
import type { SessionEvent } from '../../apps/web/src/events/session-event';

const directory = path.join(process.cwd(), 'tests/fixtures/evaluator-gate');
const manifest = JSON.parse(
  readFileSync(path.join(directory, 'manifest.json'), 'utf8'),
) as {
  caseId: string;
  sessionId: string;
  source: string;
  submittedDiffSha256: string;
  generatorVersion: string;
  authoritativeEvents: { id: string; sequence: number; type: string }[];
  testSummaries: string[];
}[];

describe('evaluator gate fixture consistency', () => {
  it('keeps validation IDs distinct from acceptance labels and fixes case C facts', () => {
    expect(manifest.map((entry) => entry.caseId)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
    ]);
    expect(manifest.find((entry) => entry.caseId === 'B')?.source).toContain(
      'histories.ts: C',
    );
    expect(manifest.find((entry) => entry.caseId === 'C')?.source).toContain(
      'histories.ts: B',
    );
    expect(
      manifest.find((entry) => entry.caseId === 'C')?.testSummaries,
    ).toEqual(['3 failed', '3 failed']);
    expect(manifest.find((entry) => entry.caseId === 'E')?.source).toContain(
      'histories.ts: D',
    );
  });
  it.each(['A', 'D', 'F', 'G'])(
    'rehydrates captured %s through real stores and renders source-faithful review',
    async (caseId) => {
      const fixture = JSON.parse(
        readFileSync(path.join(directory, `${caseId}.json`), 'utf8'),
      ) as {
        caseId: string;
        sessionRow: Record<string, string | null>;
        evidence: { events: SessionEvent[]; diff: string };
        record: { content: unknown };
      };
      const entry = manifest.find((entry) => entry.caseId === caseId)!;
      const temporary = mkdtempSync(path.join(tmpdir(), 'gate-fixture-'));
      try {
        const dbPath = path.join(temporary, 'fixture.sqlite');
        // Initialize real schemas, then recreate a genuine pre-context G schema.
        new SqliteSessionStore(dbPath).findById('missing');
        const db = new Database(dbPath);
        const row = { ...fixture.sessionRow };
        if (caseId === 'G') {
          db.exec(
            'ALTER TABLE assessment_sessions DROP COLUMN scenario_evaluation_context',
          );
          delete row.scenario_evaluation_context;
        }
        const columns = Object.keys(row);
        db.prepare(
          `INSERT INTO assessment_sessions (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
        ).run(...Object.values(row));
        db.close();
        const events = new SqliteEventStore(dbPath);
        for (const event of fixture.evidence.events)
          expect(events.append(event).sequence).toBe(event.sequence);
        const service = new SessionService(new SqliteSessionStore(dbPath), {
          eventStore: events,
        });
        const evidence = service.getSubmittedEvidence(entry.sessionId);
        expect(evidence.diff).toBe(fixture.evidence.diff);
        expect(createHash('sha256').update(evidence.diff).digest('hex')).toBe(
          entry.submittedDiffSha256,
        );
        expect(
          evidence.events.map((event) => ({
            sequence: event.sequence,
            id: event.id,
            type: event.type,
          })),
        ).toEqual(entry.authoritativeEvents);
        const store = new SqliteEvidenceReconstructionStore(dbPath);
        const record = await new EvidenceReconstructionService(
          store,
          new DeterministicEvidenceReconstructionGenerator(),
          (id) => service.getSubmittedEvidence(id),
        ).ensure(entry.sessionId);
        expect(record.promptVersion).toBe(entry.generatorVersion);
        expect(record.content).toEqual(fixture.record.content);
        const view = buildReconstructionView(store, entry.sessionId);
        const review = buildEvaluatorReviewPresentation(evidence, view);
        vi.stubEnv('HIREARCHY_DB_PATH', dbPath);
        vi.stubEnv('HIREARCHY_EVALUATOR_KEY', 'fixture-evaluator-key');
        const defaultHtml = renderToStaticMarkup(
          await EvidencePage({
            params: Promise.resolve({ sessionId: entry.sessionId }),
          }),
        );
        expect(defaultHtml).toContain('What this task was about');
        expect(defaultHtml).toContain('Submitted work');
        expect(defaultHtml).toContain('Open submitted diff');
        expect(defaultHtml).toContain('Observed progression');
        expect(defaultHtml).not.toContain('Open technical chronology');

        const engineerHtml = renderToStaticMarkup(
          await EvidencePage({
            params: Promise.resolve({ sessionId: entry.sessionId }),
            searchParams: Promise.resolve({ depth: 'ENGINEER' }),
          }),
        );
        expect(engineerHtml).toContain('data-role-lens="ENGINEER"');
        expect(engineerHtml).toContain('id="workbench-mode-summary"');
        expect(engineerHtml).toContain('id="workbench-mode-evidence"');
        expect(engineerHtml).toContain('id="workbench-mode-review"');
        expect(review.submittedDiff).toBe(evidence.diff);
        if (caseId === 'G') {
          expect(evidence.scenario.evaluationContext).toBeUndefined();
          expect(defaultHtml).toContain(
            'Scenario evaluation context is not available for this earlier session',
          );
        } else expect(evidence.scenario.evaluationContext).toBeDefined();
        if (caseId === 'F') {
          expect(review.notices).toHaveLength(1);
        }
        if (caseId === 'A')
          expect(
            review.summary.milestones
              .filter((m) => m.kind === 'verification')
              .map((m) => m.text),
          ).toEqual(['0 failing · 3 passing']);
        if (caseId === 'D') {
          expect(evidence.diff).toContain(
            '+    set_cached_stock(warehouse_id, product_id, new_quantity)',
          );
          expect(evidence.diff).not.toContain(
            'diff --git a/inventory/cache.py',
          );
          expect(
            review.evidenceEntries.some(
              (entry) =>
                entry.item?.kind === 'COMMAND_EXECUTION' &&
                entry.item.stdoutPreview ===
                  'Additional invariant checks passed\n',
            ),
          ).toBe(true);
          expect(defaultHtml).not.toContain(
            'Additional invariant checks passed',
          );
        }
      } finally {
        vi.unstubAllEnvs();
        rmSync(temporary, { recursive: true, force: true });
      }
    },
  );
});
