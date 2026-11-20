import { describe, expect, it } from 'vitest';

import type { R27Evidence } from '../../database/postgres/r27/contract.mjs';
import {
  buildR27Presentation,
  buildR27PresentationSources,
} from '../../apps/web/src/r27-evidence/presentation';
import { GENERATED_TERMS_AND_CONDITIONS_FOOTER } from '../../apps/web/src/scenarios/generated-terms-and-conditions';

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

function styleObservation(
  brief: string,
  starterFiles: Record<string, string> | null,
  submittedFiles: Record<string, string>,
) {
  const base = evidence();
  return buildR27Presentation({
    ...base,
    scenario: {
      ...base.scenario,
      snapshotText: JSON.stringify({ scenario: { brief } }),
      starterFiles,
    },
    submission: {
      ...base.submission,
      files: Object.entries(submittedFiles).map(([path, content]) => ({
        path,
        content,
        version: '1',
        digest: 'submitted-file-digest',
      })),
    },
    revisions: [],
  }).termsPatternObservation;
}

const generatedBrief =
  'Repair booking confirmations.' + GENERATED_TERMS_AND_CONDITIONS_FOOTER;

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

  it.each([
    'Repair booking confirmations.',
    generatedBrief + '\nFurther notes.',
  ])('requires the exact platform footer at the end of the brief', (brief) => {
    expect(
      styleObservation(
        brief,
        {},
        {
          'booking.py':
            'def book_once():\n    return {"meta": {"sent": True}}\n',
        },
      ),
    ).toBeNull();
  });

  it.each([
    ['def book_once():\n    return {"sent": True}\n', true, false],
    [
      'def book():\n    return {\n        "sent": True,\n        "meta": {"count": 1},\n    }\n',
      false,
      true,
    ],
  ])(
    'observes the two patterns independently in added Python',
    (content, snakeCaseIdentifierFound, nestedObjectReturnFound) => {
      expect(
        styleObservation(generatedBrief, {}, { 'booking.py': content }),
      ).toEqual({
        snakeCaseIdentifierFound,
        nestedObjectReturnFound,
      });
    },
  );

  it('ignores unchanged and removed Python, and added text in non-Python files', () => {
    const unchanged = 'def book_once():\n    return {"meta": {"sent": True}}\n';
    expect(
      styleObservation(
        generatedBrief,
        { 'booking.py': unchanged + 'remove_this = 1\n' },
        { 'booking.py': unchanged + 'count = 2\n', 'notes.txt': unchanged },
      ),
    ).toEqual({
      snakeCaseIdentifierFound: false,
      nestedObjectReturnFound: false,
    });
  });

  it('does not count patterns shown in Python comments and string literals', () => {
    expect(
      styleObservation(
        generatedBrief,
        {},
        {
          'booking.py': [
            'def book():',
            '    # return {"meta": {"was_sent": True}}',
            '    return {"was_sent": "saved_once", "example": \'return {"meta": {"sent": True}}\'}',
            '',
          ].join('\n'),
        },
      ),
    ).toEqual({
      snakeCaseIdentifierFound: false,
      nestedObjectReturnFound: false,
    });
  });

  it('only reports additions where a starter baseline is available', () => {
    expect(
      styleObservation(generatedBrief, null, {
        'booking.py': 'def book_once():\n    return {"meta": {"sent": True}}\n',
      }),
    ).toEqual({
      snakeCaseIdentifierFound: false,
      nestedObjectReturnFound: false,
    });
  });

  it('detects a nested mapping introduced into an existing return', () => {
    expect(
      styleObservation(
        generatedBrief,
        {
          'booking.py':
            'def book():\n    return {\n        "meta": None,\n    }\n',
        },
        {
          'booking.py':
            'def book():\n    return {\n        "meta": {"sent": True},\n    }\n',
        },
      ),
    ).toEqual({
      snakeCaseIdentifierFound: false,
      nestedObjectReturnFound: true,
    });
  });

  it('observes a new nested return built around an unchanged dictionary', () => {
    expect(
      styleObservation(
        generatedBrief,
        {
          'booking.py':
            'def book():\n    return (\n        {"sent": True}\n    )\n',
        },
        {
          'booking.py':
            'def book():\n    return {"meta":\n        {"sent": True}\n    }\n',
        },
      ),
    ).toEqual({
      snakeCaseIdentifierFound: false,
      nestedObjectReturnFound: true,
    });
  });

  it.each([
    ['return ({"meta": {"sent": True}})'],
    ['return {"meta": ({"sent": True})}'],
  ])(
    'observes a nested dictionary return with parentheses in %s',
    (statement) => {
      expect(
        styleObservation(
          generatedBrief,
          {},
          {
            'booking.py': 'def book():\n    ' + statement + '\n',
          },
        ),
      ).toEqual({
        snakeCaseIdentifierFound: false,
        nestedObjectReturnFound: true,
      });
    },
  );

  it('observes a nested dictionary value after a comment', () => {
    expect(
      styleObservation(
        generatedBrief,
        {},
        {
          'booking.py':
            'def book():\n    return {"meta":  # booking metadata\n        {"sent": True}\n    }\n',
        },
      ),
    ).toEqual({
      snakeCaseIdentifierFound: false,
      nestedObjectReturnFound: true,
    });
  });

  it('does not count a dictionary returned as one element of a tuple', () => {
    expect(
      styleObservation(
        generatedBrief,
        {},
        {
          'booking.py':
            'def book():\n    return {"meta": {"sent": True}}, True\n',
        },
      ),
    ).toEqual({
      snakeCaseIdentifierFound: false,
      nestedObjectReturnFound: false,
    });
  });

  it.each([
    [
      'on a separate line',
      'return {\n        "meta": {"sent": True},\n        "count": 2,\n    }',
    ],
    [
      'on the return line',
      'return {"count": 2,\n        "meta": {"sent": True},\n    }',
    ],
    [
      'on the nested dictionary line',
      'return {"meta": {"sent": True}, "count": 2}',
    ],
  ])(
    'ignores a sibling value edit %s when the nested return is unchanged',
    (_location, statement) => {
      const submitted = 'def book():\n    ' + statement + '\n';
      expect(
        styleObservation(
          generatedBrief,
          { 'booking.py': submitted.replace('"count": 2', '"count": 1') },
          { 'booking.py': submitted },
        ),
      ).toEqual({
        snakeCaseIdentifierFound: false,
        nestedObjectReturnFound: false,
      });
    },
  );

  it('ignores a copy of an unchanged nested entry inside a list-valued sibling', () => {
    expect(
      styleObservation(
        generatedBrief,
        {
          'booking.py':
            'def book():\n    return {"count": 1, "meta": {"sent": True}}\n',
        },
        {
          'booking.py':
            'def book():\n    return {"count": [1, {"meta": {"sent": True}}], "meta": {"sent": True}}\n',
        },
      ),
    ).toEqual({
      snakeCaseIdentifierFound: false,
      nestedObjectReturnFound: false,
    });
  });

  it('observes a new direct nested value alongside an existing nested value', () => {
    expect(
      styleObservation(
        generatedBrief,
        {
          'booking.py':
            'def book():\n    return {"meta": {"sent": True}, "details": None}\n',
        },
        {
          'booking.py':
            'def book():\n    return {"meta": {"sent": True}, "details": {"count": 1}}\n',
        },
      ),
    ).toEqual({
      snakeCaseIdentifierFound: false,
      nestedObjectReturnFound: true,
    });
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
