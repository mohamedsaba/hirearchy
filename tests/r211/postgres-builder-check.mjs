import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client, Pool } from 'pg';
import {
  createR23PostgresAdapter,
  assertCandidateTokenStorage,
  initializeCandidateTokenStorage,
} from '../../database/postgres/r23/adapter.mjs';
import { createR26CandidateAdapter } from '../../database/postgres/r26/adapter.mjs';
import {
  installR211AuthoringFixture,
  saveAssessmentDraft,
  getAssessmentDraft,
  listAssessmentDefinitions,
  createValidatedVersion,
  getValidatedVersion,
  R211ConcurrencyConflict,
} from '../../database/postgres/r211/adapter.mjs';
import { applyMigrations } from '../../database/postgres/migrate.mjs';

const hash = (value) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

function makeActor() {
  return {
    principalId: randomUUID(),
    subjectId: randomUUID(),
    authSessionId: randomUUID(),
    handleHash: hash(randomBytes(32).toString('hex')),
    callbackHash: hash(randomBytes(32).toString('hex')),
    identity: null,
  };
}

function assertVerifiedIdentity(identity) {
  if (
    !identity ||
    identity.expiresAt <= Math.floor(Date.now() / 1000) ||
    !['aal1', 'aal2'].includes(identity.assurance)
  ) {
    throw new Error('Synthetic verified identity rejected');
  }
  return identity;
}

async function createAuthenticatedActor(adapter, actor) {
  actor.identity = {
    subjectId: actor.subjectId,
    sessionId: actor.authSessionId,
    assurance: 'aal1',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  await adapter.createSession({
    handleHash: actor.handleHash,
    csrfHash: hash(randomBytes(32).toString('hex')),
    callbackHash: actor.callbackHash,
    credentialEnvelope: Buffer.from('synthetic R2.11 Auth envelope'),
    identity: actor.identity,
    expiresAt: new Date(Date.now() + 3_600_000),
    accessExpiresAt: new Date(Date.now() + 3_000_000),
  });
  await adapter.withActiveSession(
    { handleHash: actor.handleHash },
    async (_session, authz) => authz.consumeCallback(actor.callbackHash),
  );
}

async function inSession(gatewayPool, actor, callback) {
  const client = await gatewayPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT * FROM r23.lock_active_session($1::pg_catalog.text)',
      [actor.handleHash],
    );
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function runR211PostgresBuilderChecks({
  admin,
  connection,
  runtimePassword,
  candidateTokenKey,
}) {
  assert.ok(admin && connection && runtimePassword);
  assert.match(candidateTokenKey ?? '', /^[A-Za-z0-9+/]{43}=$/);
  await assertCandidateTokenStorage(admin, {
    key: Buffer.from(candidateTokenKey, 'base64'),
  });

  const candidatePool = new Pool({
    ...connection,
    user: 'app_candidate_gateway',
    password: runtimePassword,
    application_name: 'hirearchy-r211-candidate-check',
    max: 5,
  });

  const gatewayPool = new Pool({
    ...connection,
    user: 'r23_gateway',
    password: runtimePassword,
    application_name: 'hirearchy-r211-gateway-check',
    max: 5,
  });

  const candidateAdapter = createR26CandidateAdapter({
    connectionString: `postgres://app_candidate_gateway:${encodeURIComponent(runtimePassword)}@${connection.host}:${connection.port}/${connection.database ?? 'postgres'}`,
  });

  const authorization = createR23PostgresAdapter({
    pool: gatewayPool,
    assertVerifiedIdentity,
  });

  const orgA = randomUUID();
  const orgB = randomUUID();

  const actors = {
    recruiterA: makeActor(),
    reviewerA: makeActor(),
    adminA: makeActor(),
    reviewerRevoked: makeActor(),
    recruiterB: makeActor(),
    reviewerInOrgB: makeActor(),
  };
  const fixtureActors = Object.values(actors);

  try {
    // 0. Setup organizations, principals, and memberships
    await admin.query(
      'INSERT INTO hirearchy.organizations (id) VALUES ($1), ($2)',
      [orgA, orgB],
    );

    for (const actor of fixtureActors) {
      await admin.query(
        `INSERT INTO hirearchy.application_principals (id, auth_user_id)
         VALUES ($1, $2)`,
        [actor.principalId, actor.subjectId],
      );
    }

    const memberships = [
      [orgA, actors.recruiterA.principalId, 'recruiter', 'active', null],
      [orgA, actors.reviewerA.principalId, 'reviewer', 'active', null],
      [orgA, actors.adminA.principalId, 'admin', 'active', null],
      [
        orgA,
        actors.reviewerRevoked.principalId,
        'reviewer',
        'revoked',
        new Date(),
      ],
      [orgB, actors.recruiterB.principalId, 'recruiter', 'active', null],
      [orgB, actors.reviewerInOrgB.principalId, 'reviewer', 'active', null],
    ];

    for (const [
      organizationId,
      principalId,
      role,
      status,
      revokedAt,
    ] of memberships) {
      await admin.query(
        `INSERT INTO hirearchy.organization_memberships (
           organization_id, principal_id, role, status, joined_at,
           revoked_at, version
         ) VALUES ($1, $2, $3, $4, pg_catalog.clock_timestamp(), $5, 1)`,
        [organizationId, principalId, role, status, revokedAt],
      );
    }

    for (const actor of fixtureActors) {
      await createAuthenticatedActor(authorization, actor);
    }

    // Bind server sessions to organizations
    await authorization.withActiveSession(
      { handleHash: actors.recruiterA.handleHash },
      async (_session, authz) => {
        await authz.selectOrganization(actors.recruiterA.identity, orgA);
      },
    );
    await authorization.withActiveSession(
      { handleHash: actors.reviewerA.handleHash },
      async (_session, authz) => {
        await authz.selectOrganization(actors.reviewerA.identity, orgA);
      },
    );
    await authorization.withActiveSession(
      { handleHash: actors.adminA.handleHash },
      async (_session, authz) => {
        await authz.selectOrganization(actors.adminA.identity, orgA);
      },
    );
    // Note: reviewerRevoked has revoked membership, so authz.selectOrganization would reject them.
    // We explicitly set selected_organization_id in the session to prove that even with org selected,
    // r211 database functions reject revoked members!
    await admin.query(
      `UPDATE r23.server_sessions SET selected_organization_id = $1 WHERE handle_hash = $2`,
      [orgA, actors.reviewerRevoked.handleHash],
    );
    await authorization.withActiveSession(
      { handleHash: actors.recruiterB.handleHash },
      async (_session, authz) => {
        await authz.selectOrganization(actors.recruiterB.identity, orgB);
      },
    );
    await authorization.withActiveSession(
      { handleHash: actors.reviewerInOrgB.handleHash },
      async (_session, authz) => {
        await authz.selectOrganization(actors.reviewerInOrgB.identity, orgB);
      },
    );

    // =========================================================================
    // Check 1: Authorized draft creation by recruiter
    // =========================================================================
    const initialDraftInput = {
      title: 'Automated Booking Retry Service',
      brief:
        'Implement an exponential backoff retry mechanism for failed booking notifications.',
      expectedBehavior: [
        'Retry failed notifications up to 3 times with exponential backoff.',
        'Log each attempt with status code and error details.',
      ],
      acceptanceCriteria: [
        'Notifications succeed after temporary failure within 3 attempts.',
        'Terminal status reported accurately after 3 failed attempts.',
      ],
      primaryFilePath: 'src/service.py',
      starterFiles: [
        { path: 'README.md', content: '# Booking Service\n' },
        {
          path: 'src/service.py',
          content:
            'def notify():\n    # TODO: implement backoff retry\n    pass\n',
        },
      ],
      durationMinutes: 60,
      terminalEnabled: true,
      integratedAi: false,
      rubric: [
        {
          id: 'correctness',
          label: 'Correctness',
          description: 'Retries are attempted up to max attempts.',
          weight: 60,
          applicability: { kind: 'always', rule: 'Applies to all attempts' },
        },
        {
          id: 'logging',
          label: 'Error Logging',
          description: 'Errors are logged accurately.',
          weight: 40,
          applicability: { kind: 'always', rule: 'Applies to all attempts' },
        },
      ],
    };

    const draft1 = await inSession(gatewayPool, actors.recruiterA, (client) =>
      saveAssessmentDraft(
        client,
        actors.recruiterA.identity,
        orgA,
        initialDraftInput,
      ),
    );

    assert.ok(draft1, 'Draft must be returned after save');
    assert.match(
      draft1.definitionId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      'Draft must have valid UUID definitionId',
    );
    assert.equal(draft1.version, 1, 'Initial draft version must be 1');
    assert.equal(draft1.organizationId, orgA);
    assert.equal(
      draft1.authorPrincipalId,
      actors.recruiterA.principalId,
      'Author principal ID must match recruiter',
    );
    assert.equal(draft1.title, initialDraftInput.title);
    assert.equal(draft1.brief, initialDraftInput.brief);
    assert.equal(draft1.durationMinutes, 60);
    assert.equal(draft1.terminalEnabled, true);
    assert.equal(draft1.integratedAi, false);
    assert.ok(draft1.createdAt, 'createdAt must be defined');
    assert.ok(draft1.updatedAt, 'updatedAt must be defined');

    // Verify row in hirearchy.assessment_definitions
    const { rows: defRows } = await admin.query(
      'SELECT * FROM hirearchy.assessment_definitions WHERE id = $1',
      [draft1.definitionId],
    );
    assert.equal(defRows.length, 1);
    assert.equal(defRows[0].draft_version, '1');
    assert.equal(defRows[0].organization_id, orgA);
    assert.equal(defRows[0].author_principal_id, actors.recruiterA.principalId);

    // Verify row in hirearchy.assessment_drafts
    const { rows: draftRows } = await admin.query(
      'SELECT * FROM hirearchy.assessment_drafts WHERE definition_id = $1 AND version = 1',
      [draft1.definitionId],
    );
    assert.equal(draftRows.length, 1);
    assert.equal(draftRows[0].title, initialDraftInput.title);

    // =========================================================================
    // Check 2: Draft save and reload
    // =========================================================================
    const reloaded1 = await inSession(
      gatewayPool,
      actors.recruiterA,
      (client) =>
        getAssessmentDraft(
          client,
          actors.recruiterA.identity,
          orgA,
          draft1.definitionId,
        ),
    );
    assert.ok(reloaded1);
    assert.equal(reloaded1.definitionId, draft1.definitionId);
    assert.equal(reloaded1.version, 1);
    assert.equal(reloaded1.title, draft1.title);
    assert.equal(reloaded1.starterFiles.length, 2);

    // Reload without definitionId returns latest draft in org
    const latestInOrg = await inSession(
      gatewayPool,
      actors.recruiterA,
      (client) =>
        getAssessmentDraft(client, actors.recruiterA.identity, orgA, null),
    );
    assert.ok(latestInOrg);
    assert.equal(latestInOrg.definitionId, draft1.definitionId);

    // Save version 2
    const draftInput2 = {
      ...initialDraftInput,
      definitionId: draft1.definitionId,
      title: 'Automated Booking Retry Service v2',
      expectedVersion: 1,
    };
    const draft2 = await inSession(gatewayPool, actors.recruiterA, (client) =>
      saveAssessmentDraft(
        client,
        actors.recruiterA.identity,
        orgA,
        draftInput2,
      ),
    );
    assert.equal(draft2.definitionId, draft1.definitionId);
    assert.equal(draft2.version, 2, 'Version should increment to 2');
    assert.equal(draft2.title, 'Automated Booking Retry Service v2');

    // Reload again, should get version 2
    const reloaded2 = await inSession(
      gatewayPool,
      actors.recruiterA,
      (client) =>
        getAssessmentDraft(
          client,
          actors.recruiterA.identity,
          orgA,
          draft1.definitionId,
        ),
    );
    assert.equal(reloaded2.version, 2);
    assert.equal(reloaded2.title, 'Automated Booking Retry Service v2');

    // Check definition list
    const definitions = await inSession(
      gatewayPool,
      actors.recruiterA,
      (client) =>
        listAssessmentDefinitions(client, actors.recruiterA.identity, orgA),
    );
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].id, draft1.definitionId);
    assert.equal(definitions[0].draftVersion, 2);

    // Check assessment_drafts table has 2 rows
    const { rows: draftsCount } = await admin.query(
      'SELECT count(*)::int AS count FROM hirearchy.assessment_drafts WHERE definition_id = $1',
      [draft1.definitionId],
    );
    assert.equal(draftsCount[0].count, 2);

    // =========================================================================
    // Check 3: Optimistic concurrency conflict test
    // =========================================================================
    const staleInput = {
      ...initialDraftInput,
      definitionId: draft1.definitionId,
      title: 'Stale update attempt',
      expectedVersion: 1, // Current version is 2!
    };
    await assert.rejects(
      inSession(gatewayPool, actors.recruiterA, (client) =>
        saveAssessmentDraft(
          client,
          actors.recruiterA.identity,
          orgA,
          staleInput,
        ),
      ),
      (err) =>
        err instanceof R211ConcurrencyConflict ||
        err?.code === '23505' ||
        err?.code === 'DRAFT_CONCURRENCY_CONFLICT',
      'Stale draft save (expectedVersion=1, actual=2) must fail with DRAFT_CONCURRENCY_CONFLICT',
    );

    const nonExistentDefInput = {
      ...initialDraftInput,
      definitionId: randomUUID(),
      title: 'Missing definition',
      expectedVersion: 1,
    };
    await assert.rejects(
      inSession(gatewayPool, actors.recruiterA, (client) =>
        saveAssessmentDraft(
          client,
          actors.recruiterA.identity,
          orgA,
          nonExistentDefInput,
        ),
      ),
      (err) =>
        err instanceof R211ConcurrencyConflict ||
        err?.code === '23505' ||
        err?.code === 'DRAFT_CONCURRENCY_CONFLICT',
      'Save with expectedVersion on non-existent definition must fail with conflict',
    );

    // =========================================================================
    // Check 4: Validated version creation and immutability
    // =========================================================================
    const validated1 = await inSession(
      gatewayPool,
      actors.recruiterA,
      (client) =>
        createValidatedVersion(
          client,
          actors.recruiterA.identity,
          orgA,
          draft1.definitionId,
          2,
        ),
    );

    assert.ok(validated1);
    assert.match(
      validated1.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    assert.equal(validated1.definitionId, draft1.definitionId);
    assert.equal(validated1.organizationId, orgA);
    assert.equal(validated1.authorPrincipalId, actors.recruiterA.principalId);
    assert.equal(validated1.versionNumber, 1);
    assert.match(validated1.contentDigest, /^[0-9a-f]{64}$/);
    assert.equal(validated1.scenarioId, 'authored-assessment');
    assert.equal(validated1.scenarioVersion, '1.0.0');
    assert.equal(
      validated1.scenarioTitle,
      'Automated Booking Retry Service v2',
    );
    assert.equal(validated1.durationSeconds, 3600);
    assert.equal(validated1.terminalEnabled, true);
    assert.equal(validated1.integratedAi, false);
    assert.ok(validated1.scenarioSnapshot?.scenario);
    assert.equal(validated1.scenarioSnapshot.scenario.imageName, undefined);
    assert.ok(validated1.scenarioSnapshot?.workspaceFiles);
    assert.ok(validated1.taskRubricSnapshot?.criteria);
    assert.equal(
      validated1.validationReceipt?.executionValidationAvailable,
      false,
    );

    // Reload validated version
    const reloadedValidated = await inSession(
      gatewayPool,
      actors.recruiterA,
      (client) =>
        getValidatedVersion(
          client,
          actors.recruiterA.identity,
          orgA,
          validated1.id,
        ),
    );
    assert.deepEqual(reloadedValidated, validated1);

    // The selected template ignores client-supplied task content and binds the reviewed files.
    const templateDraft = await inSession(
      gatewayPool,
      actors.recruiterA,
      (client) =>
        saveAssessmentDraft(client, actors.recruiterA.identity, orgA, {
          ...initialDraftInput,
          templateId: 'reservation-moves-v3',
          title: 'Untrusted client title',
          starterFiles: [{ path: 'forged.py', content: 'pass' }],
        }),
    );
    assert.equal(templateDraft.templateId, 'reservation-moves-v3');
    assert.equal(templateDraft.title, 'Reservation Moves');
    assert.equal(templateDraft.starterFiles.length, 4);
    const templateVersion = await inSession(
      gatewayPool,
      actors.recruiterA,
      (client) =>
        createValidatedVersion(
          client,
          actors.recruiterA.identity,
          orgA,
          templateDraft.definitionId,
          templateDraft.version,
        ),
    );
    assert.equal(templateVersion.scenarioId, 'reservation-moves');
    assert.equal(templateVersion.scenarioVersion, 'v3');
    assert.equal(
      templateVersion.scenarioSnapshot.scenario.recipe.digest,
      'eeac2baaf62ce107c7511268e862657ae24bb171cd1dec6ca01797c16ffbaad8',
    );
    assert.deepEqual(
      Object.keys(templateVersion.scenarioSnapshot.workspaceFiles).sort(),
      [
        'src/sender.py',
        'src/service.py',
        'src/state.py',
        'tests/test_moves.py',
      ],
    );

    const forgedSnapshot = structuredClone(templateVersion.scenarioSnapshot);
    forgedSnapshot.workspaceFiles['src/service.py'] = 'forged';
    await assert.rejects(
      inSession(gatewayPool, actors.recruiterA, (client) =>
        createValidatedVersion(client, actors.recruiterA.identity, orgA, {
          definitionId: templateDraft.definitionId,
          expectedDraftVersion: templateDraft.version,
          scenarioId: templateVersion.scenarioId,
          scenarioVersion: templateVersion.scenarioVersion,
          scenarioTitle: templateVersion.scenarioTitle,
          scenarioSnapshot: forgedSnapshot,
          taskRubricSnapshot: templateVersion.taskRubricSnapshot,
          durationSeconds: templateVersion.durationSeconds,
          terminalEnabled: true,
          integratedAi: false,
          contentDigest: templateVersion.contentDigest,
        }),
      ),
      (error) => error?.code === '23514',
    );

    // Validated version immutability triggers (UPDATE and DELETE fail with 23514)
    await assert.rejects(
      admin.query(
        `UPDATE hirearchy.assessment_validated_versions
         SET scenario_title = 'Tampered Title'
         WHERE id = $1`,
        [validated1.id],
      ),
      (err) => err?.code === '23514',
      'Direct UPDATE on assessment_validated_versions must fail with trigger 23514',
    );

    await assert.rejects(
      admin.query(
        `DELETE FROM hirearchy.assessment_validated_versions
         WHERE id = $1`,
        [validated1.id],
      ),
      (err) => err?.code === '23514',
      'Direct DELETE on assessment_validated_versions must fail with trigger 23514',
    );

    // =========================================================================
    // Check 5: Subsequent draft edits do not mutate validated version
    // =========================================================================
    const draftInput3 = {
      ...initialDraftInput,
      definitionId: draft1.definitionId,
      title: 'Completely Mutated Draft Title v3',
      brief:
        'New completely different instructions for next iteration candidate test.',
      expectedVersion: 2,
    };
    const draft3 = await inSession(gatewayPool, actors.recruiterA, (client) =>
      saveAssessmentDraft(
        client,
        actors.recruiterA.identity,
        orgA,
        draftInput3,
      ),
    );
    assert.equal(draft3.version, 3);
    assert.equal(draft3.title, 'Completely Mutated Draft Title v3');

    // Reload validated version 1 again
    const postEditValidated = await inSession(
      gatewayPool,
      actors.recruiterA,
      (client) =>
        getValidatedVersion(
          client,
          actors.recruiterA.identity,
          orgA,
          validated1.id,
        ),
    );
    assert.equal(
      postEditValidated.scenarioTitle,
      'Automated Booking Retry Service v2',
      'Validated version scenarioTitle must remain unchanged after draft edit',
    );
    assert.equal(postEditValidated.contentDigest, validated1.contentDigest);
    assert.deepEqual(
      postEditValidated.scenarioSnapshot,
      validated1.scenarioSnapshot,
    );

    // =========================================================================
    // Check 6: Cross-tenant access denial
    // =========================================================================
    // Recruiter B in Org B attempts to read Org A's draft
    const crossDraft = await inSession(
      gatewayPool,
      actors.recruiterB,
      (client) =>
        getAssessmentDraft(
          client,
          actors.recruiterB.identity,
          orgB,
          draft1.definitionId,
        ),
    );
    assert.equal(
      crossDraft,
      null,
      "Recruiter B must not be able to read Org A's draft",
    );

    // Recruiter B attempts to pass Org A in selectOrganization or getAssessmentDraft
    await assert.rejects(
      inSession(gatewayPool, actors.recruiterB, (client) =>
        getAssessmentDraft(
          client,
          actors.recruiterB.identity,
          orgA,
          draft1.definitionId,
        ),
      ),
      (err) => err?.code === 'R2401' || err?.name === 'R23ScopeDenied',
      'Mismatched organization selection must be denied with R2401',
    );

    // Recruiter B attempts to save draft in Org A
    await assert.rejects(
      inSession(gatewayPool, actors.recruiterB, (client) =>
        saveAssessmentDraft(
          client,
          actors.recruiterB.identity,
          orgA,
          initialDraftInput,
        ),
      ),
      (err) => err?.code === 'R2401' || err?.name === 'R23ScopeDenied',
      'Recruiter B cannot save draft targeting Org A',
    );

    // Recruiter B attempts to get Org A's validated version
    const crossValidated = await inSession(
      gatewayPool,
      actors.recruiterB,
      (client) =>
        getValidatedVersion(
          client,
          actors.recruiterB.identity,
          orgB,
          validated1.id,
        ),
    );
    assert.equal(
      crossValidated,
      null,
      "Recruiter B must not be able to access Org A's validated version",
    );

    // Recruiter B attempts to validate Org A's definition in Org B
    await assert.rejects(
      inSession(gatewayPool, actors.recruiterB, (client) =>
        createValidatedVersion(
          client,
          actors.recruiterB.identity,
          orgB,
          draft1.definitionId,
          3,
        ),
      ),
      (err) =>
        err instanceof R211ConcurrencyConflict ||
        err?.code === '23503' ||
        err?.code === '23505',
      "Recruiter B cannot validate Org A's definition",
    );

    // =========================================================================
    // Check 7: Role denial (Reviewer and Admin)
    // =========================================================================
    // Reviewer in Org A cannot save draft
    await assert.rejects(
      inSession(gatewayPool, actors.reviewerA, (client) =>
        saveAssessmentDraft(
          client,
          actors.reviewerA.identity,
          orgA,
          initialDraftInput,
        ),
      ),
      (err) => err?.code === 'R2401' || err?.name === 'R23ScopeDenied',
      'Reviewer cannot save assessment draft',
    );

    // Reviewer in Org A cannot create validated version
    await assert.rejects(
      inSession(gatewayPool, actors.reviewerA, (client) =>
        createValidatedVersion(
          client,
          actors.reviewerA.identity,
          orgA,
          draft1.definitionId,
          3,
        ),
      ),
      (err) => err?.code === 'R2401' || err?.name === 'R23ScopeDenied',
      'Reviewer cannot create validated version',
    );

    // Org Admin in Org A cannot save draft
    await assert.rejects(
      inSession(gatewayPool, actors.adminA, (client) =>
        saveAssessmentDraft(
          client,
          actors.adminA.identity,
          orgA,
          initialDraftInput,
        ),
      ),
      (err) => err?.code === 'R2401' || err?.name === 'R23ScopeDenied',
      'Org Admin cannot save assessment draft',
    );

    // Org Admin in Org A cannot create validated version
    await assert.rejects(
      inSession(gatewayPool, actors.adminA, (client) =>
        createValidatedVersion(
          client,
          actors.adminA.identity,
          orgA,
          draft1.definitionId,
          3,
        ),
      ),
      (err) => err?.code === 'R2401' || err?.name === 'R23ScopeDenied',
      'Org Admin cannot create validated version',
    );

    // Reviewer CAN read draft and validated version
    const reviewerReadDraft = await inSession(
      gatewayPool,
      actors.reviewerA,
      (client) =>
        getAssessmentDraft(
          client,
          actors.reviewerA.identity,
          orgA,
          draft1.definitionId,
        ),
    );
    assert.ok(reviewerReadDraft);
    assert.equal(reviewerReadDraft.definitionId, draft1.definitionId);

    const reviewerReadValidated = await inSession(
      gatewayPool,
      actors.reviewerA,
      (client) =>
        getValidatedVersion(
          client,
          actors.reviewerA.identity,
          orgA,
          validated1.id,
        ),
    );
    assert.ok(reviewerReadValidated);
    assert.equal(reviewerReadValidated.id, validated1.id);

    // =========================================================================
    // Check 8: Revocation denial
    // =========================================================================
    // Member revoked before test
    await assert.rejects(
      inSession(gatewayPool, actors.reviewerRevoked, (client) =>
        getAssessmentDraft(
          client,
          actors.reviewerRevoked.identity,
          orgA,
          draft1.definitionId,
        ),
      ),
      (err) => err?.code === 'R2401' || err?.name === 'R23ScopeDenied',
      'Revoked reviewer cannot read draft',
    );

    // Revoke Recruiter A now
    await admin.query(
      `UPDATE hirearchy.organization_memberships
       SET revoked_at = pg_catalog.clock_timestamp(), status = 'revoked'
       WHERE organization_id = $1 AND principal_id = $2`,
      [orgA, actors.recruiterA.principalId],
    );

    await assert.rejects(
      inSession(gatewayPool, actors.recruiterA, (client) =>
        saveAssessmentDraft(
          client,
          actors.recruiterA.identity,
          orgA,
          initialDraftInput,
        ),
      ),
      (err) => err?.code === 'R2401' || err?.name === 'R23ScopeDenied',
      'Revoked recruiter cannot save draft',
    );

    await assert.rejects(
      inSession(gatewayPool, actors.recruiterA, (client) =>
        getAssessmentDraft(
          client,
          actors.recruiterA.identity,
          orgA,
          draft1.definitionId,
        ),
      ),
      (err) => err?.code === 'R2401' || err?.name === 'R23ScopeDenied',
      'Revoked recruiter cannot get draft',
    );

    await assert.rejects(
      inSession(gatewayPool, actors.recruiterA, (client) =>
        createValidatedVersion(
          client,
          actors.recruiterA.identity,
          orgA,
          draft1.definitionId,
          3,
        ),
      ),
      (err) => err?.code === 'R2401' || err?.name === 'R23ScopeDenied',
      'Revoked recruiter cannot create validated version',
    );

    await assert.rejects(
      inSession(gatewayPool, actors.recruiterA, (client) =>
        getValidatedVersion(
          client,
          actors.recruiterA.identity,
          orgA,
          validated1.id,
        ),
      ),
      (err) => err?.code === 'R2401' || err?.name === 'R23ScopeDenied',
      'Revoked recruiter cannot get validated version',
    );

    // =========================================================================
    // Check 9: Direct SQL access denial (42501)
    // =========================================================================
    await assert.rejects(
      gatewayPool.query('SELECT * FROM hirearchy.assessment_definitions'),
      (err) => err?.code === '42501',
      'Direct table SELECT on assessment_definitions by r23_gateway must be denied (42501)',
    );
    await assert.rejects(
      gatewayPool.query('SELECT * FROM hirearchy.assessment_drafts'),
      (err) => err?.code === '42501',
      'Direct table SELECT on assessment_drafts by r23_gateway must be denied (42501)',
    );
    await assert.rejects(
      gatewayPool.query(
        'SELECT * FROM hirearchy.assessment_validated_versions',
      ),
      (err) => err?.code === '42501',
      'Direct table SELECT on assessment_validated_versions by r23_gateway must be denied (42501)',
    );

    await assert.rejects(
      candidatePool.query('SELECT * FROM hirearchy.assessment_definitions'),
      (err) => err?.code === '42501',
      'Direct table SELECT by app_candidate_gateway must be denied (42501)',
    );
    await assert.rejects(
      candidatePool.query('SELECT * FROM hirearchy.assessment_drafts'),
      (err) => err?.code === '42501',
      'Direct table SELECT by app_candidate_gateway must be denied (42501)',
    );
    await assert.rejects(
      candidatePool.query(
        'SELECT * FROM hirearchy.assessment_validated_versions',
      ),
      (err) => err?.code === '42501',
      'Direct table SELECT by app_candidate_gateway must be denied (42501)',
    );

    // =========================================================================
    // Check 10: Immutable column triggers on definitions and drafts (23514)
    // =========================================================================
    await assert.rejects(
      admin.query(
        `UPDATE hirearchy.assessment_definitions
         SET organization_id = $1
         WHERE id = $2`,
        [orgB, draft1.definitionId],
      ),
      (err) => err?.code === '23514',
      'Updating immutable organization_id on assessment_definitions must fail with 23514',
    );

    await assert.rejects(
      admin.query(
        `UPDATE hirearchy.assessment_definitions
         SET author_principal_id = $1
         WHERE id = $2`,
        [actors.recruiterB.principalId, draft1.definitionId],
      ),
      (err) => err?.code === '23514',
      'Updating immutable author_principal_id on assessment_definitions must fail with 23514',
    );

    await assert.rejects(
      admin.query(
        `UPDATE hirearchy.assessment_drafts
         SET organization_id = $1
         WHERE definition_id = $2 AND version = 1`,
        [orgB, draft1.definitionId],
      ),
      (err) => err?.code === '23514',
      'Updating immutable organization_id on assessment_drafts must fail with 23514',
    );

    await assert.rejects(
      admin.query(
        `UPDATE hirearchy.assessment_drafts
         SET version = 99
         WHERE definition_id = $1 AND version = 1`,
        [draft1.definitionId],
      ),
      (err) => err?.code === '23514',
      'Updating immutable version on assessment_drafts must fail with 23514',
    );

    // =========================================================================
    // Check 11: Validated version second version & uniqueness
    // =========================================================================
    // Recruiter B in Org B creates draft and validates it twice
    const orgBDraftInput = {
      ...initialDraftInput,
      title: 'Org B Challenge Task',
    };
    const draftOrgB = await inSession(
      gatewayPool,
      actors.recruiterB,
      (client) =>
        saveAssessmentDraft(
          client,
          actors.recruiterB.identity,
          orgB,
          orgBDraftInput,
        ),
    );

    const valB1 = await inSession(gatewayPool, actors.recruiterB, (client) =>
      createValidatedVersion(
        client,
        actors.recruiterB.identity,
        orgB,
        draftOrgB.definitionId,
        1,
      ),
    );
    assert.equal(valB1.versionNumber, 1);

    // Validate a second time
    const valB2 = await inSession(gatewayPool, actors.recruiterB, (client) =>
      createValidatedVersion(
        client,
        actors.recruiterB.identity,
        orgB,
        draftOrgB.definitionId,
        1,
      ),
    );
    assert.equal(valB2.versionNumber, 2);

    // Direct insert with duplicate (definition_id, version_number) violates UNIQUE constraint
    await assert.rejects(
      admin.query(
        `INSERT INTO hirearchy.assessment_validated_versions (
           definition_id, organization_id, author_principal_id, version_number,
           content_digest, scenario_id, scenario_version, scenario_title,
           scenario_snapshot, task_rubric_snapshot, duration_seconds,
           terminal_enabled, integrated_ai, validation_receipt
         ) VALUES ($1, $2, $3, 1, $4, 'sc-1', '1.0', 'dup', '{}', '{}', 3600, true, false, '{}')`,
        [
          draftOrgB.definitionId,
          orgB,
          actors.recruiterB.principalId,
          valB1.contentDigest,
        ],
      ),
      (err) => err?.code === '23505',
      'Duplicate (definition_id, version_number) must fail with unique violation 23505',
    );

    console.log(
      'PASS R2.11 PostgreSQL assessment authoring, draft concurrency, validated version immutability, and tenant/role isolation',
    );
  } finally {
    await candidateAdapter?.close().catch(() => {});
    await authorization?.close().catch(() => {});
    await candidatePool?.end().catch(() => {});
    await gatewayPool?.end().catch(() => {});
  }
}

// =============================================================================
// Standalone runner when executed directly via node
// =============================================================================
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const POSTGRES_IMAGE =
    'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';
  const containerName = `hirearchy-r211-pg-test-${process.pid}-${randomBytes(4).toString('hex')}`;
  const password = randomBytes(30).toString('base64url');
  const runtimePassword = randomBytes(30).toString('base64url');
  const candidateTokenKey = randomBytes(32).toString('base64');

  const docker = (...args) =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  let adminClient;
  try {
    console.log(
      `Starting disposable PostgreSQL container: ${containerName}...`,
    );
    docker(
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--tmpfs',
      '/var/lib/postgresql/data',
      POSTGRES_IMAGE,
    );

    const portOutput = docker('port', containerName, '5432/tcp');
    const portMatch = /^127\.0\.0\.1:(\d+)$/.exec(portOutput);
    if (!portMatch)
      throw new Error(
        'Disposable PostgreSQL container did not bind to loopback',
      );

    const connection = {
      host: '127.0.0.1',
      port: Number(portMatch[1]),
      database: 'postgres',
      connectionTimeoutMillis: 3000,
    };

    // Wait for connection
    let connected = false;
    for (let i = 0; i < 50; i++) {
      try {
        const probe = new Client({
          ...connection,
          user: 'postgres',
          password,
        });
        await probe.connect();
        await probe.query('SELECT 1');
        await probe.end();
        connected = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (!connected) throw new Error('Postgres failed to start in time');

    adminClient = new Client({ ...connection, user: 'postgres', password });
    await adminClient.connect();

    // Bootstrap roles
    await adminClient.query(
      readFileSync(
        new URL('../../database/postgres/bootstrap-roles.sql', import.meta.url),
        'utf8',
      ),
    );
    await adminClient.query(`
      ALTER ROLE hirearchy_migrator PASSWORD '${password}';
      ALTER ROLE app_evaluator PASSWORD '${runtimePassword}';
      ALTER ROLE app_candidate_gateway PASSWORD '${runtimePassword}';
      ALTER ROLE app_control_worker PASSWORD '${runtimePassword}';
      CREATE ROLE r23_gateway LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
      CREATE ROLE supabase_auth_admin LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
      ALTER ROLE supabase_auth_admin SET search_path = auth;
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    `);

    // Apply migrations 0001 through 0008
    const migrator = new Client({
      ...connection,
      user: 'hirearchy_migrator',
      password,
    });
    await migrator.connect();
    await applyMigrations(migrator);
    await migrator.end();

    // Initialize candidate token storage
    await initializeCandidateTokenStorage(adminClient, {
      key: Buffer.from(candidateTokenKey, 'base64'),
    });

    // Install fixtures r23, r26, r27, r28, r29, r210, r211
    const { installR27EvidenceFixture } =
      await import('../../database/postgres/r27/adapter.mjs');
    const { installR28RevisionFixture } =
      await import('../../database/postgres/r28/adapter.mjs');
    const { installR29ObservationFixture } =
      await import('../../database/postgres/r29/adapter.mjs');
    const { installR210ReviewPacketFixture } =
      await import('../../database/postgres/r210/adapter.mjs');

    await adminClient.query(
      readFileSync(
        new URL('../../database/postgres/r23/fixture.sql', import.meta.url),
        'utf8',
      ),
    );
    await installR27EvidenceFixture(adminClient);
    await installR28RevisionFixture(adminClient);
    await installR29ObservationFixture(adminClient);
    await installR210ReviewPacketFixture(adminClient);
    await installR211AuthoringFixture(adminClient);

    // Run tests
    await runR211PostgresBuilderChecks({
      admin: adminClient,
      connection,
      runtimePassword,
      candidateTokenKey,
    });

    console.log('ALL R2.11 POSTGRES AUTHORING CHECKS PASSED SUCCESSFULLY!');
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exitCode = 1;
  } finally {
    await adminClient?.end().catch(() => {});
    try {
      docker('stop', '--time', '2', containerName);
    } catch {
      // Container may have already exited.
    }
  }
}
