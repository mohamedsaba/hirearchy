import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { ReviewerWorkflowStore } from '../../apps/web/src/review-workflow/reviewer-workflow-store';

const folders: string[] = [];
const createStore = () => {
  const folder = mkdtempSync(
    path.join(os.tmpdir(), 'hirearchy-review-workflow-'),
  );
  folders.push(folder);
  return new ReviewerWorkflowStore(path.join(folder, 'review.sqlite'));
};

afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

describe('ReviewerWorkflowStore', () => {
  it('keeps notes, candidate clarification, and human next step separate and session-scoped', () => {
    const store = createStore();
    expect(
      store.saveNote(
        'session-a',
        'Observed retry handling.',
        0,
        '2026-10-01T10:00:00Z',
      ),
    ).toEqual({
      body: 'Observed retry handling.',
      updatedAt: '2026-10-01T10:00:00Z',
      version: 1,
    });
    const clarification = store.requestClarification(
      'session-a',
      'What happens on a duplicate event?',
      '00000000-0000-0000-0000-000000000001',
    );
    expect(
      store.requestClarification(
        'session-a',
        'Ignored retry body',
        '00000000-0000-0000-0000-000000000001',
      ),
    ).toBeNull();
    expect(
      store.requestClarification(
        'session-a',
        'What happens on a duplicate event?',
        '00000000-0000-0000-0000-000000000001',
      )?.id,
    ).toBe(clarification.id);
    expect(store.closeClarification('session-a', clarification.id)).toBe(false);
    const reply = store.replyToClarification(
      'session-a',
      clarification.id,
      'The handler checks the event key before sending.',
      '2026-10-01T10:03:00Z',
    );
    expect(reply?.reply).toBe(
      'The handler checks the event key before sending.',
    );
    expect(
      store.replyToClarification(
        'session-b',
        clarification.id,
        'Cross-session response',
        '2026-10-01T10:04:00Z',
      ),
    ).toBeNull();
    expect(
      store.replyToClarification(
        'session-a',
        clarification.id,
        reply!.reply!,
        '2026-10-01T10:04:00Z',
      )?.id,
    ).toBe(clarification.id);
    expect(
      store.replyToClarification(
        'session-a',
        clarification.id,
        'Changed after submit',
        '2026-10-01T10:04:00Z',
      ),
    ).toBe('conflict');
    expect(
      store.replyToClarification(
        'session-b',
        clarification.id,
        reply!.reply!,
        '2026-10-01T10:04:00Z',
      ),
    ).toBeNull();
    expect(
      store.replyToClarification(
        'session-a',
        'missing-clarification',
        'Any response',
      ),
    ).toBeNull();
    expect(
      store.closeClarification(
        'session-a',
        clarification.id,
        '2026-10-01T10:05:00Z',
      ),
    ).toBe(true);
    store.saveNextStep(
      'session-a',
      'technical_review',
      'Inspect the retry boundary.',
      0,
      '2026-10-01T10:06:00Z',
    );

    expect(store.get('session-a')).toMatchObject({
      note: { body: 'Observed retry handling.', version: 1 },
      clarifications: [
        {
          id: clarification.id,
          reply: 'The handler checks the event key before sending.',
          closedAt: '2026-10-01T10:05:00Z',
        },
      ],
      nextStep: {
        action: 'technical_review',
        note: 'Inspect the retry boundary.',
        version: 1,
      },
    });
    expect(store.get('session-b')).toEqual({
      note: null,
      clarifications: [],
      nextStep: null,
    });
  });

  it('rejects stale note saves without overwriting the newer saved note', () => {
    const store = createStore();
    expect(store.saveNote('session-a', 'first tab', 0)).toMatchObject({
      version: 1,
    });
    expect(store.saveNote('session-a', 'second tab draft', 0)).toBeNull();
    expect(store.get('session-a').note).toMatchObject({
      body: 'first tab',
      version: 1,
    });
    expect(store.saveNote('session-a', 'updated note', 1)).toMatchObject({
      version: 2,
    });
  });

  it('rejects stale next-step saves without overwriting the newer choice', () => {
    const store = createStore();
    expect(
      store.saveNextStep(
        'session-a',
        'continue_review',
        'First draft',
        0,
        '2026-10-01T10:00:00Z',
      ),
    ).toMatchObject({ version: 1 });
    expect(
      store.saveNextStep(
        'session-a',
        'technical_review',
        'Latest saved choice',
        1,
        '2026-10-01T10:01:00Z',
      ),
    ).toMatchObject({ version: 2 });
    expect(
      store.saveNextStep(
        'session-a',
        'closeout',
        'Stale draft',
        1,
        '2026-10-01T10:02:00Z',
      ),
    ).toBeNull();
    expect(store.get('session-a').nextStep).toMatchObject({
      action: 'technical_review',
      note: 'Latest saved choice',
      version: 2,
    });
  });

  it('migrates an existing next-step table and assigns its saved row version 1', () => {
    const folder = mkdtempSync(
      path.join(os.tmpdir(), 'hirearchy-review-workflow-'),
    );
    folders.push(folder);
    const databasePath = path.join(folder, 'review.sqlite');
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE reviewer_next_steps (
        session_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        note TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO reviewer_next_steps VALUES (
        'session-a', 'continue_review', 'Existing record', '2026-10-01T10:00:00Z'
      );
    `);
    database.close();

    const store = new ReviewerWorkflowStore(databasePath);
    expect(store.get('session-a').nextStep).toMatchObject({
      action: 'continue_review',
      note: 'Existing record',
      version: 1,
    });
    expect(
      store.saveNextStep('session-a', 'closeout', 'Stale view', 0),
    ).toBeNull();
  });

  it('makes retries idempotent and rejects key reuse with different content', async () => {
    const store = createStore();
    const requestKey = '00000000-0000-0000-0000-000000000002';
    const [first, retry] = await Promise.all([
      Promise.resolve(
        store.requestClarification(
          'session-a',
          'Explain the retry guard.',
          requestKey,
        ),
      ),
      Promise.resolve(
        store.requestClarification(
          'session-a',
          'Explain the retry guard.',
          requestKey,
        ),
      ),
    ]);
    expect(first?.id).toBe(retry?.id);
    expect(store.get('session-a').clarifications).toHaveLength(1);
    const separateSession = store.requestClarification(
      'session-b',
      'A session-specific question.',
      requestKey,
    );
    expect(separateSession?.id).not.toBe(first?.id);
    expect(store.get('session-b').clarifications).toEqual([
      expect.objectContaining({ prompt: 'A session-specific question.' }),
    ]);
    expect(store.get('session-a').clarifications[0]?.prompt).toBe(
      'Explain the retry guard.',
    );
    expect(
      store.requestClarification(
        'session-a',
        'Different question.',
        requestKey,
      ),
    ).toBeNull();
  });
});
