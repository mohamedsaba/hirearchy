import { readFileSync } from 'node:fs';
import {
  validateAssessmentDraft,
  computeCanonicalContentDigest,
  buildScenarioSnapshotEnvelope,
  buildTaskRubricSnapshot,
} from '../../../apps/web/src/r211-builder/validation.ts';
import {
  normalizeAssessmentTemplate,
  reservationMovesBinding,
} from './template.mjs';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class R211ConcurrencyConflict extends Error {
  constructor(
    message = 'Edit conflict: this assessment draft was updated concurrently.',
  ) {
    super(message);
    this.name = 'R211ConcurrencyConflict';
    this.code = 'DRAFT_CONCURRENCY_CONFLICT';
    this.sqlState = '23505';
    this.status = 409;
  }
}

function parseIdentity(identityInput, assertVerifiedIdentity) {
  if (assertVerifiedIdentity && typeof assertVerifiedIdentity === 'function') {
    identityInput = assertVerifiedIdentity(identityInput);
  }
  if (!identityInput || typeof identityInput !== 'object') {
    throw new TypeError('A verified authentication identity is required');
  }
  const subjectId = identityInput.subjectId;
  const sessionId = identityInput.sessionId;
  const assurance = identityInput.assurance || 'aal1';
  if (!subjectId || !sessionId) {
    throw new TypeError('Identity must contain subjectId and sessionId');
  }
  return { subjectId, sessionId, assurance };
}

function validateUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError(`Valid ${label} UUID is required`);
  }
  return value;
}

function mapDatabaseError(error) {
  if (
    error?.code === '23505' &&
    (error?.message?.includes('DRAFT_CONCURRENCY_CONFLICT') ||
      error?.message?.includes('assessment_drafts_pkey') ||
      error?.message?.includes(
        'assessment_validated_versions_definition_id_version_number_key',
      ))
  ) {
    throw new R211ConcurrencyConflict(error.message);
  }
  throw error;
}

export async function installR211AuthoringFixture(clientOrPool) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL fixture client is required');
  }
  await clientOrPool.query(
    readFileSync(new URL('./fixture.sql', import.meta.url), 'utf8'),
  );
}

export async function saveAssessmentDraft(
  client,
  identityInput,
  organizationId,
  input,
  assertVerifiedIdentity,
) {
  const identity = parseIdentity(identityInput, assertVerifiedIdentity);
  const orgId = validateUuid(organizationId, 'organization ID');
  if (!input || typeof input !== 'object') {
    throw new TypeError('Draft input object is required');
  }

  const draftInput = normalizeAssessmentTemplate(input);
  const payload = {
    templateId: draftInput.templateId,
    definitionId: draftInput.definitionId
      ? String(draftInput.definitionId)
      : null,
    title: String(draftInput.title ?? ''),
    brief: String(draftInput.brief ?? ''),
    expectedBehavior: Array.isArray(draftInput.expectedBehavior)
      ? draftInput.expectedBehavior
      : [],
    acceptanceCriteria: Array.isArray(draftInput.acceptanceCriteria)
      ? draftInput.acceptanceCriteria
      : [],
    primaryFilePath: String(draftInput.primaryFilePath ?? ''),
    starterFiles: Array.isArray(draftInput.starterFiles)
      ? draftInput.starterFiles
      : [],
    durationMinutes: Number(draftInput.durationMinutes ?? 60),
    terminalEnabled: Boolean(draftInput.terminalEnabled ?? true),
    integratedAi: Boolean(draftInput.integratedAi ?? false),
    rubric: Array.isArray(draftInput.rubric) ? draftInput.rubric : [],
    expectedVersion:
      typeof draftInput.expectedVersion === 'number'
        ? draftInput.expectedVersion
        : null,
  };

  try {
    const { rows } = await client.query(
      `SELECT r211.save_assessment_draft(
         $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
         $4::pg_catalog.uuid, $5::pg_catalog.jsonb
       ) AS draft`,
      [
        identity.subjectId,
        identity.sessionId,
        identity.assurance,
        orgId,
        JSON.stringify(payload),
      ],
    );
    return rows[0]?.draft ?? null;
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function getAssessmentDraft(
  client,
  identityInput,
  organizationId,
  definitionId,
  assertVerifiedIdentity,
) {
  const identity = parseIdentity(identityInput, assertVerifiedIdentity);
  const orgId = validateUuid(organizationId, 'organization ID');
  const defId = definitionId
    ? validateUuid(definitionId, 'definition ID')
    : null;

  try {
    const { rows } = await client.query(
      `SELECT r211.get_assessment_draft(
         $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
         $4::pg_catalog.uuid, $5::pg_catalog.uuid
       ) AS draft`,
      [
        identity.subjectId,
        identity.sessionId,
        identity.assurance,
        orgId,
        defId,
      ],
    );
    return rows[0]?.draft ?? null;
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function listAssessmentDefinitions(
  client,
  identityInput,
  organizationId,
  assertVerifiedIdentity,
) {
  const identity = parseIdentity(identityInput, assertVerifiedIdentity);
  const orgId = validateUuid(organizationId, 'organization ID');

  try {
    const { rows } = await client.query(
      `SELECT r211.list_assessment_definitions(
         $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
         $4::pg_catalog.uuid
       ) AS definitions`,
      [identity.subjectId, identity.sessionId, identity.assurance, orgId],
    );
    return rows[0]?.definitions ?? [];
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function createValidatedVersion(
  client,
  identityInput,
  organizationId,
  definitionIdOrPayload,
  expectedDraftVersion,
  assertVerifiedIdentity,
) {
  const identity = parseIdentity(identityInput, assertVerifiedIdentity);
  const orgId = validateUuid(organizationId, 'organization ID');

  let versionPayload;

  if (
    typeof definitionIdOrPayload === 'object' &&
    definitionIdOrPayload !== null
  ) {
    versionPayload = definitionIdOrPayload;
  } else {
    const definitionId = validateUuid(definitionIdOrPayload, 'definition ID');
    const draft = await getAssessmentDraft(
      client,
      identityInput,
      orgId,
      definitionId,
      assertVerifiedIdentity,
    );
    if (!draft) {
      throw new R211ConcurrencyConflict('DRAFT_CONCURRENCY_CONFLICT');
    }
    if (
      typeof expectedDraftVersion === 'number' &&
      draft.version !== expectedDraftVersion
    ) {
      throw new R211ConcurrencyConflict('DRAFT_CONCURRENCY_CONFLICT');
    }

    const approvedDraft = normalizeAssessmentTemplate(draft);
    const validationResult = validateAssessmentDraft(approvedDraft);
    if (!validationResult.valid) {
      const err = new Error(
        `Draft validation failed: ${validationResult.issues.map((i) => i.message).join('; ')}`,
      );
      err.issues = validationResult.issues;
      throw err;
    }

    const isReservationMoves =
      approvedDraft.templateId === 'reservation-moves-v3';
    const contentDigest = computeCanonicalContentDigest(
      approvedDraft,
      isReservationMoves ? reservationMovesBinding() : undefined,
    );
    const scenarioId = isReservationMoves
      ? 'reservation-moves'
      : 'authored-assessment';
    const scenarioVersion = isReservationMoves ? 'v3' : '1.0.0';
    const scenarioTitle = approvedDraft.title.trim();
    const envelope = buildScenarioSnapshotEnvelope(
      scenarioId,
      scenarioVersion,
      approvedDraft,
    );
    if (isReservationMoves) {
      Object.assign(envelope.scenario, reservationMovesBinding());
    }
    const taskRubricSnapshot = buildTaskRubricSnapshot(approvedDraft);
    const validationReceipt = {
      validatedAt: new Date().toISOString(),
      checks: [
        'structural_schema',
        'file_boundaries',
        'rubric_weights',
        'duration_limits',
      ],
      executionValidationAvailable: false,
    };

    versionPayload = {
      definitionId: draft.definitionId,
      expectedDraftVersion: expectedDraftVersion ?? draft.version,
      scenarioId,
      scenarioVersion,
      scenarioTitle,
      scenarioSnapshot: JSON.stringify(envelope),
      taskRubricSnapshot,
      durationSeconds: approvedDraft.durationMinutes * 60,
      terminalEnabled: approvedDraft.terminalEnabled,
      integratedAi: approvedDraft.integratedAi,
      contentDigest,
      validationReceipt,
    };
  }

  try {
    const { rows } = await client.query(
      `SELECT r211.create_validated_version(
         $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
         $4::pg_catalog.uuid, $5::pg_catalog.jsonb
       ) AS validated`,
      [
        identity.subjectId,
        identity.sessionId,
        identity.assurance,
        orgId,
        JSON.stringify(versionPayload),
      ],
    );
    return rows[0]?.validated ?? null;
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function getValidatedVersion(
  client,
  identityInput,
  organizationId,
  versionId,
  assertVerifiedIdentity,
) {
  const identity = parseIdentity(identityInput, assertVerifiedIdentity);
  const orgId = validateUuid(organizationId, 'organization ID');
  const vId = validateUuid(versionId, 'version ID');

  try {
    const { rows } = await client.query(
      `SELECT r211.get_validated_version(
         $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
         $4::pg_catalog.uuid, $5::pg_catalog.uuid
       ) AS validated`,
      [identity.subjectId, identity.sessionId, identity.assurance, orgId, vId],
    );
    return rows[0]?.validated ?? null;
  } catch (error) {
    mapDatabaseError(error);
  }
}

export function createR211Adapter(clientOrPool) {
  return createR211PostgresAdapter({ pool: clientOrPool });
}

export function createR211PostgresAdapter({ pool, assertVerifiedIdentity }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL pool or client is required');
  }

  return {
    async saveAssessmentDraft(identityInput, organizationId, input) {
      return saveAssessmentDraft(
        pool,
        identityInput,
        organizationId,
        input,
        assertVerifiedIdentity,
      );
    },

    async getAssessmentDraft(identityInput, organizationId, definitionId) {
      return getAssessmentDraft(
        pool,
        identityInput,
        organizationId,
        definitionId,
        assertVerifiedIdentity,
      );
    },

    async listAssessmentDefinitions(identityInput, organizationId) {
      return listAssessmentDefinitions(
        pool,
        identityInput,
        organizationId,
        assertVerifiedIdentity,
      );
    },

    async createValidatedVersion(
      identityInput,
      organizationId,
      definitionId,
      expectedDraftVersion,
    ) {
      return createValidatedVersion(
        pool,
        identityInput,
        organizationId,
        definitionId,
        expectedDraftVersion,
        assertVerifiedIdentity,
      );
    },

    async getValidatedVersion(identityInput, organizationId, versionId) {
      return getValidatedVersion(
        pool,
        identityInput,
        organizationId,
        versionId,
        assertVerifiedIdentity,
      );
    },
  };
}
