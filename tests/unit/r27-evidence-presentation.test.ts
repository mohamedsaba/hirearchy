import { describe, expect, it } from 'vitest';

import type { R27Evidence } from '../../database/postgres/r27/contract.mjs';
import {
  buildR27Presentation,
  buildR27PresentationSources,
} from '../../apps/web/src/r27-evidence/presentation';

const evidence = (overrides: Partial<R27Evidence> = {}): R27Evidence => ({
  permission: 'assigned_reviewer',
  reviewer: {
    subjectId: '30000000-0000-4000-8000-0000000000ab',
    principalId: 'abababab-1111-4111-8111-111111111111',
  },
  organizationId: '11111111-1111-4111-8111-111111111111',
  sessionId: 'sess_123e4567-e89b-42d3-a456-426614174000',
  assignment: {
    id: 'assignment-1',
    version: '9007199254740993',
    assignedAt: '2026-10-26T10:00:00.000Z',
  },
  scenario: {
    id: 'scenario-002-booking-notification-retry',
    version: '2',
    title: 'The second confirmation',
    snapshotText: JSON.stringify({
      scenario: {
        brief: 'Repair duplicate booking confirmations.',
        acceptanceCriteria: ['Retry once', 'Keep one confirmation'],
      },
      workspaceFiles: ['bookings/service.py'],
    }),
    snapshotDigest: 'scenario-digest',
    starterFiles: { 'bookings/service.py': 'return send_confirmation()\n' },
  },
  status: 'SUBMITTED',
  createdAt: '2026-10-26T10:00:00.000Z',
  activatedAt: '2026-10-26T10:01:00.000Z',
  submittedAt: '2026-10-26T10:10:00.000Z',
  closureReason: 'candidate_submission',
  submission: {
    submittedAt: '2026-10-26T10:10:00.000Z',
    closureReason: 'candidate_submission',
    workspaceDigest: 'workspace-digest',
    manifestDigest: 'manifest-digest',
    files: [
      {
        path: 'bookings/service.py',
        version: '3',
        digest: 'submitted-file-digest',
        content: 'return send_once()\n',
      },
    ],
  },
  revisions: [
    {
      path: 'bookings/service.py',
      version: '1',
      digest: 'starter-file-digest',
      content: 'return send_confirmation()\n',
      source: 'starter',
    },
    {
      path: 'bookings/service.py',
      version: '3',
      digest: 'submitted-file-digest',
      content: 'return send_once()\n',
      source: 'submitted',
    },
    {
      path: 'bookings/service.py',
      version: '2',
      digest: 'intermediate-digest',
      content: null,
      source: 'event_metadata',
    },
  ],
  events: [
    {
      sequence: '9007199254740993',
      type: 'SESSION_ACTIVATED',
      timestamp: '2026-10-26T10:01:00.000Z',
      payload: { deadline: '2026-10-26T10:31:00.000Z' },
      provenance: 'hirearchy.candidate_session_events',
    },
  ],
  pagination: { limit: 50, nextAfterSequence: null },
  availability: {
    terminal: 'unavailable',
    ai: 'unavailable',
    verification: 'unavailable',
    history: 'metadata_only',
    limitations: ['Save history does not retain intermediate content.'],
  },
  ...overrides,
});

describe('R2.7 evidence presentation', () => {
  it('derives the file diff from the immutable starter and submitted contents', () => {
    const result = buildR27Presentation(evidence());

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      path: 'bookings/service.py',
      starterContent: 'return send_confirmation()\n',
      submittedContent: 'return send_once()\n',
      starterDigest: 'starter-file-digest',
      submittedDigest: 'submitted-file-digest',
    });
    expect(result.files[0].diff).toContain('-return send_confirmation()');
    expect(result.files[0].diff).toContain('+return send_once()');
    expect(result.scenarioContext).toEqual({
      brief: 'Repair duplicate booking confirmations.',
      acceptanceCriteria: ['Retry once', 'Keep one confirmation'],
    });
    expect(result.revisionMetadata).toEqual([
      {
        path: 'bookings/service.py',
        version: '2',
        digest: 'intermediate-digest',
      },
    ]);
  });

  it('does not derive a diff when the starter baseline is unavailable', () => {
    const result = buildR27Presentation(
      evidence({
        scenario: {
          ...evidence().scenario,
          snapshotText: 'snapshot source unavailable',
          starterFiles: null,
        },
        revisions: [
          {
            path: 'bookings/service.py',
            version: '2',
            digest: 'event-only-digest',
            content: null,
            source: 'event_metadata',
          },
        ],
      }),
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      path: 'bookings/service.py',
      starterContent: null,
      submittedContent: 'return send_once()\n',
      diff: null,
    });
    expect(result.scenarioContext).toEqual({
      brief: null,
      acceptanceCriteria: [],
    });
  });

  it('keeps event sequence values lossless and separate from intermediate contents', () => {
    const value = evidence();
    const sources = buildR27PresentationSources(value);
    const eventSource = sources.find((source) => source.kind === 'event');

    expect(eventSource?.kind).toBe('event');
    if (eventSource?.kind !== 'event')
      throw new Error('Event source unavailable');
    expect(eventSource.event.sequence).toBe('9007199254740993');
    expect(eventSource.event.provenance).toBe(
      'hirearchy.candidate_session_events',
    );
    expect(
      sources.some(
        (source) =>
          source.kind === 'event' &&
          JSON.stringify(source.event).includes('intermediate-digest'),
      ),
    ).toBe(false);
  });
});
