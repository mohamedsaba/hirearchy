import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID = /^sess_[A-Za-z0-9_-]{1,128}$/;
const SEQUENCE = /^(0|[1-9][0-9]{0,18})$/;
const MAX_INT8 = 9_223_372_036_854_775_807n;
const EVENT_TYPES = new Set([
  'SESSION_ACTIVATED',
  'WORKSPACE_CHANGED',
  'SESSION_SUBMITTED',
  'AI_REQUEST_STARTED',
  'AI_RESPONSE_COMPLETED',
  'AI_REQUEST_FAILED',
  'EXECUTION_REQUESTED',
  'EXECUTION_COMPLETED',
  'EXECUTION_FAILED',
]);

export class R27EvidenceIntegrityError extends Error {
  constructor() {
    super('Submitted evidence is temporarily unavailable.');
    this.name = 'R27EvidenceIntegrityError';
    this.code = 'EVIDENCE_STORAGE_UNAVAILABLE';
  }
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(value, keys) {
  return (
    isPlainObject(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}

function sameStringMap(left, right) {
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && left[key] === right[key],
    )
  );
}

function validPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 160 &&
    value.trim() === value &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.includes('//') &&
    !value.includes('\\') &&
    !value.includes(':') &&
    !value.split('/').some((part) => part === '.' || part === '..') &&
    /\.(py|md|json|txt)$/.test(value)
  );
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new R27EvidenceIntegrityError();
  }
}

function validTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validSequence(value, { allowZero = false } = {}) {
  if (typeof value !== 'string' || !SEQUENCE.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed <= MAX_INT8 && (allowZero || parsed > 0n);
  } catch {
    return false;
  }
}

function mapFiles(files, starterFiles) {
  if (!Array.isArray(files) || files.length > 20) {
    throw new R27EvidenceIntegrityError();
  }
  const seen = new Set();
  let totalBytes = 0;
  const mapped = files.map((file) => {
    if (
      !isPlainObject(file) ||
      Object.keys(file).sort().join(',') !== 'content,digest,path,version' ||
      !validPath(file.path) ||
      seen.has(file.path) ||
      typeof file.content !== 'string' ||
      Buffer.byteLength(file.content, 'utf8') > 100_000 ||
      !validSequence(file.version, { allowZero: true }) ||
      typeof file.digest !== 'string' ||
      !HASH.test(file.digest) ||
      digest(file.content) !== file.digest
    ) {
      throw new R27EvidenceIntegrityError();
    }
    seen.add(file.path);
    totalBytes += Buffer.byteLength(file.content, 'utf8');
    if (totalBytes > 1_048_576) throw new R27EvidenceIntegrityError();
    if (starterFiles && !Object.hasOwn(starterFiles, file.path)) {
      throw new R27EvidenceIntegrityError();
    }
    return {
      path: file.path,
      content: file.content,
      version: file.version,
      digest: file.digest,
    };
  });
  if (
    starterFiles &&
    (mapped.length !== Object.keys(starterFiles).length ||
      mapped.some((file) => !Object.hasOwn(starterFiles, file.path)))
  ) {
    throw new R27EvidenceIntegrityError();
  }
  if (
    mapped.some(
      (file, index) => index > 0 && mapped[index - 1].path >= file.path,
    )
  ) {
    throw new R27EvidenceIntegrityError();
  }
  return mapped;
}

function mapEvents(events, { afterSequence, limit }) {
  if (!Array.isArray(events) || events.length > limit) {
    throw new R27EvidenceIntegrityError();
  }
  let previous = BigInt(afterSequence);
  return events.map((event) => {
    if (
      !isPlainObject(event) ||
      !validSequence(event.sequence) ||
      BigInt(event.sequence) <= previous ||
      !EVENT_TYPES.has(event.type) ||
      !validTime(event.timestamp) ||
      !isPlainObject(event.payload)
    ) {
      throw new R27EvidenceIntegrityError();
    }
    previous = BigInt(event.sequence);
    const payload = event.payload;
    if (event.type === 'SESSION_ACTIVATED') {
      if (
        Object.keys(payload).some((key) => key !== 'scenarioDigest') ||
        typeof payload.scenarioDigest !== 'string' ||
        !HASH.test(payload.scenarioDigest)
      ) {
        throw new R27EvidenceIntegrityError();
      }
    } else if (event.type === 'WORKSPACE_CHANGED') {
      if (
        Object.keys(payload).some(
          (key) =>
            ![
              'requestId',
              'path',
              'previousVersion',
              'version',
              'previousDigest',
              'digest',
            ].includes(key),
        ) ||
        typeof payload.requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(payload.requestId) ||
        !validPath(payload.path) ||
        !validSequence(payload.previousVersion, { allowZero: true }) ||
        !validSequence(payload.version) ||
        BigInt(payload.version) !== BigInt(payload.previousVersion) + 1n ||
        typeof payload.previousDigest !== 'string' ||
        !HASH.test(payload.previousDigest) ||
        typeof payload.digest !== 'string' ||
        !HASH.test(payload.digest)
      ) {
        throw new R27EvidenceIntegrityError();
      }
    } else if (
      event.type === 'AI_REQUEST_STARTED' ||
      event.type === 'AI_RESPONSE_COMPLETED' ||
      event.type === 'AI_REQUEST_FAILED'
    ) {
      if (
        typeof payload.requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(payload.requestId) ||
        typeof payload.interactionId !== 'string'
      ) {
        throw new R27EvidenceIntegrityError();
      }
    } else if (
      event.type === 'EXECUTION_REQUESTED' ||
      event.type === 'EXECUTION_COMPLETED' ||
      event.type === 'EXECUTION_FAILED'
    ) {
      if (
        typeof payload.operationId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(payload.operationId)
      ) {
        throw new R27EvidenceIntegrityError();
      }
    } else if (
      Object.keys(payload).sort().join(',') !==
        'closureReason,manifestDigest,workspaceDigest' ||
      !['candidate_submission', 'timeout'].includes(payload.closureReason) ||
      typeof payload.manifestDigest !== 'string' ||
      !HASH.test(payload.manifestDigest) ||
      typeof payload.workspaceDigest !== 'string' ||
      !HASH.test(payload.workspaceDigest)
    ) {
      throw new R27EvidenceIntegrityError();
    }
    return {
      sequence: event.sequence,
      type: event.type,
      timestamp: event.timestamp,
      payload,
      provenance: 'hirearchy.candidate_session_events',
    };
  });
}

export function mapR27Evidence(
  value,
  { afterSequence = '0', limit = 50 } = {},
) {
  if (value === null || value === undefined) return null;
  try {
    const allowedKeysA = [
      'permission',
      'reviewer',
      'organizationId',
      'sessionId',
      'assignment',
      'scenario',
      'status',
      'durationSeconds',
      'createdAt',
      'activatedAt',
      'submittedAt',
      'closureReason',
      'submission',
      'manifestText',
      'identityText',
      'events',
      'pagination',
    ];
    const allowedKeysB = [...allowedKeysA, 'aiInteractions'];
    const allowedKeysC = [...allowedKeysB, 'executions'];
    const allowedKeysD = [...allowedKeysA, 'executions'];
    if (
      !isPlainObject(value) ||
      (!hasExactKeys(value, allowedKeysA) &&
        !hasExactKeys(value, allowedKeysB) &&
        !hasExactKeys(value, allowedKeysC) &&
        !hasExactKeys(value, allowedKeysD)) ||
      value.permission !== 'assigned_reviewer' ||
      !hasExactKeys(value.reviewer, ['subjectId', 'principalId']) ||
      !UUID.test(value.reviewer.subjectId ?? '') ||
      !UUID.test(value.reviewer.principalId ?? '') ||
      typeof value.reviewer.subjectId !== 'string' ||
      typeof value.reviewer.principalId !== 'string' ||
      typeof value.organizationId !== 'string' ||
      !UUID.test(value.organizationId) ||
      typeof value.sessionId !== 'string' ||
      !SESSION_ID.test(value.sessionId) ||
      value.status !== 'SUBMITTED' ||
      !['candidate_submission', 'timeout'].includes(value.closureReason) ||
      !validTime(value.createdAt) ||
      !validTime(value.activatedAt) ||
      !validTime(value.submittedAt) ||
      !Number.isInteger(value.durationSeconds) ||
      value.durationSeconds <= 0 ||
      !hasExactKeys(value.assignment, ['id', 'version', 'assignedAt']) ||
      typeof value.assignment.id !== 'string' ||
      value.assignment.id.trim() === '' ||
      !validSequence(value.assignment.version) ||
      !validTime(value.assignment.assignedAt) ||
      !hasExactKeys(value.scenario, [
        'id',
        'version',
        'title',
        'snapshotText',
        'snapshotDigest',
        'starterFiles',
      ]) ||
      typeof value.scenario.id !== 'string' ||
      typeof value.scenario.version !== 'string' ||
      typeof value.scenario.title !== 'string' ||
      typeof value.scenario.snapshotText !== 'string' ||
      typeof value.scenario.snapshotDigest !== 'string' ||
      !HASH.test(value.scenario.snapshotDigest) ||
      digest(value.scenario.snapshotText) !== value.scenario.snapshotDigest ||
      !hasExactKeys(value.submission, [
        'submittedAt',
        'closureReason',
        'workspaceDigest',
        'manifestDigest',
        'files',
      ]) ||
      value.submission.submittedAt !== value.submittedAt ||
      value.submission.closureReason !== value.closureReason ||
      typeof value.submission.workspaceDigest !== 'string' ||
      !HASH.test(value.submission.workspaceDigest) ||
      typeof value.submission.manifestDigest !== 'string' ||
      !HASH.test(value.submission.manifestDigest) ||
      typeof value.manifestText !== 'string' ||
      typeof value.identityText !== 'string' ||
      !hasExactKeys(value.pagination, ['limit', 'nextAfterSequence']) ||
      value.pagination.limit !== limit
    ) {
      throw new R27EvidenceIntegrityError();
    }

    const snapshot = parseJson(value.scenario.snapshotText);
    if (
      !isPlainObject(snapshot) ||
      !isPlainObject(snapshot.scenario) ||
      snapshot.scenario.id !== value.scenario.id ||
      snapshot.scenario.version !== value.scenario.version ||
      snapshot.scenario.title !== value.scenario.title ||
      snapshot.scenario.durationSeconds !== value.durationSeconds
    ) {
      throw new R27EvidenceIntegrityError();
    }
    let starterFiles = null;
    if (Object.hasOwn(snapshot, 'workspaceFiles')) {
      if (!isPlainObject(snapshot.workspaceFiles)) {
        throw new R27EvidenceIntegrityError();
      }
      const entries = Object.entries(snapshot.workspaceFiles);
      let starterBytes = 0;
      if (entries.length > 20) throw new R27EvidenceIntegrityError();
      for (const [path, content] of entries) {
        if (!validPath(path) || typeof content !== 'string') {
          throw new R27EvidenceIntegrityError();
        }
        const bytes = Buffer.byteLength(content, 'utf8');
        starterBytes += bytes;
        if (bytes > 100_000 || starterBytes > 1_048_576) {
          throw new R27EvidenceIntegrityError();
        }
      }
      starterFiles = snapshot.workspaceFiles;
    }
    if (
      value.scenario.starterFiles !== null &&
      !sameStringMap(value.scenario.starterFiles, starterFiles)
    ) {
      throw new R27EvidenceIntegrityError();
    }

    const files = mapFiles(value.submission.files, starterFiles);
    const manifest = parseJson(value.manifestText);
    if (
      !Array.isArray(manifest) ||
      JSON.stringify(manifest) !== JSON.stringify(value.submission.files) ||
      digest(value.manifestText) !== value.submission.manifestDigest
    ) {
      throw new R27EvidenceIntegrityError();
    }
    const identity = parseJson(value.identityText);
    if (
      !Array.isArray(identity) ||
      identity.length !== files.length ||
      digest(value.identityText) !== value.submission.workspaceDigest ||
      identity.some(
        (entry, index) =>
          !isPlainObject(entry) ||
          entry.path !== files[index].path ||
          entry.version !== files[index].version ||
          entry.digest !== files[index].digest ||
          Object.keys(entry).length !== 3,
      )
    ) {
      throw new R27EvidenceIntegrityError();
    }

    const events = mapEvents(value.events, { afterSequence, limit });
    const nextAfterSequence = value.pagination.nextAfterSequence;
    if (
      nextAfterSequence !== null &&
      (events.length !== limit ||
        !validSequence(nextAfterSequence) ||
        events.at(-1)?.sequence !== nextAfterSequence ||
        BigInt(nextAfterSequence) <= BigInt(afterSequence))
    ) {
      throw new R27EvidenceIntegrityError();
    }

    const revisions = [];
    if (starterFiles) {
      for (const path of Object.keys(starterFiles).sort()) {
        const content = starterFiles[path];
        revisions.push({
          path,
          version: '0',
          digest: digest(content),
          content,
          source: 'starter',
        });
      }
    }
    for (const event of events) {
      if (event.type === 'WORKSPACE_CHANGED') {
        revisions.push({
          path: event.payload.path,
          version: event.payload.version,
          digest: event.payload.digest,
          content: null,
          source: 'event_metadata',
        });
      }
    }
    for (const file of files) revisions.push({ ...file, source: 'submitted' });

    return {
      permission: value.permission,
      reviewer: {
        subjectId: value.reviewer.subjectId,
        principalId: value.reviewer.principalId,
      },
      organizationId: value.organizationId,
      sessionId: value.sessionId,
      assignment: {
        id: value.assignment.id,
        version: value.assignment.version,
        assignedAt: value.assignment.assignedAt,
      },
      scenario: {
        id: value.scenario.id,
        version: value.scenario.version,
        title: value.scenario.title,
        snapshotText: value.scenario.snapshotText,
        snapshotDigest: value.scenario.snapshotDigest,
        starterFiles,
      },
      status: 'SUBMITTED',
      createdAt: value.createdAt,
      activatedAt: value.activatedAt,
      submittedAt: value.submittedAt,
      closureReason: value.closureReason,
      submission: {
        submittedAt: value.submission.submittedAt,
        closureReason: value.submission.closureReason,
        workspaceDigest: value.submission.workspaceDigest,
        manifestDigest: value.submission.manifestDigest,
        files,
      },
      revisions,
      events,
      aiInteractions: Array.isArray(value.aiInteractions)
        ? value.aiInteractions
        : [],
      executions: Array.isArray(value.executions) ? value.executions : [],
      pagination: { limit, nextAfterSequence },
      availability: {
        terminal:
          value.executions && value.executions.length > 0
            ? 'available'
            : 'unavailable',
        ai:
          value.aiInteractions && value.aiInteractions.length > 0
            ? 'available'
            : 'unavailable',
        verification: 'unavailable',
        history: 'metadata_only',
        limitations: [
          'Intermediate file contents were not retained; save events provide metadata only.',
          ...(starterFiles
            ? []
            : [
                'The issued snapshot contains no starter file content for diffs.',
              ]),
          ...(value.executions && value.executions.length > 0
            ? value.aiInteractions && value.aiInteractions.length > 0
              ? ['Verification evidence is unavailable in this lane.']
              : ['AI and verification evidence is unavailable in this lane.']
            : value.aiInteractions && value.aiInteractions.length > 0
              ? [
                  'Terminal and verification evidence is unavailable in this lane.',
                ]
              : [
                  'Terminal, AI, and verification evidence is unavailable in this lane.',
                ]),
        ],
      },
    };
  } catch (error) {
    if (error instanceof R27EvidenceIntegrityError) throw error;
    throw new R27EvidenceIntegrityError();
  }
}

export async function installR27EvidenceFixture(clientOrPool) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL fixture client is required');
  }
  await clientOrPool.query(
    readFileSync(new URL('./fixture.sql', import.meta.url), 'utf8'),
  );
}
