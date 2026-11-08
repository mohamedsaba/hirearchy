import assert from 'node:assert/strict';
import {
  createCipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { applyMigrations } from '../database/postgres/migrate.mjs';
import {
  APPROVED_ASSESSMENT_TEMPLATES,
  expectedBriefDigest,
  expectedWorkspaceDigest,
  getApprovedTemplate,
  listApprovedTemplates,
  normalizeAssessmentTemplate,
  reservationMovesBinding,
} from '../database/postgres/r211/template.mjs';
import {
  buildScenarioSnapshotEnvelope,
  buildTaskRubricSnapshot,
  computeCanonicalContentDigest,
  validateAssessmentDraft,
} from '../apps/web/src/r211-builder/validation.ts';
import {
  candidateTokenHash,
  encryptCandidateToken,
} from '../apps/web/src/sessions/candidate-token-storage.mjs';

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

const image = 'hirearchy-staging-postgres-local:latest';
const runId = randomBytes(4).toString('hex');
const containerName = `hirearchy-res-wt-b-${runId}`;
const restoredContainerName = `hirearchy-res-wt-b-restored-${runId}`;
const volumeName = `${containerName}-data`;
const restoredVolumeName = `${restoredContainerName}-data`;
const pgPassword = randomBytes(32).toString('hex');
const migratorPassword = randomBytes(32).toString('hex');
const gatewayPassword = randomBytes(32).toString('hex');
const candidatePassword = randomBytes(32).toString('hex');
const candidateEncryptionKey = randomBytes(32).toString('base64');

const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();

const sqlFile = async (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

const waitFor = async (check, maxAttempts = 120, intervalMs = 250) => {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      if (await check()) return;
    } catch {
      // keep probing
    }
    await delay(intervalMs);
  }
  throw new Error('Readiness deadline exceeded');
};

async function spawnPostgres(name, volume, hostPort = '127.0.0.1::5432') {
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--label',
    `hirearchy.test.owner=${containerName}`,
    '-p',
    hostPort,
    '-e',
    `POSTGRES_PASSWORD=${pgPassword}`,
    '-v',
    `${volume}:/var/lib/postgresql/data`,
    image,
  );

  await waitFor(() =>
    docker('exec', name, 'pg_isready', '-U', 'postgres').includes(
      'accepting connections',
    ),
  );

  const port = Number(/:(\d+)$/.exec(docker('port', name, '5432/tcp'))[1]);
  await waitFor(async () => {
    const probe = new Client({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password: pgPassword,
      database: 'postgres',
      connectionTimeoutMillis: 1000,
    });
    try {
      await probe.connect();
      await probe.query('SELECT 1');
      return true;
    } finally {
      await probe.end().catch(() => {});
    }
  });

  const connect = async (user = 'postgres', rolePassword = pgPassword) => {
    const client = new Client({
      host: '127.0.0.1',
      port,
      user,
      password: rolePassword,
      database: 'postgres',
    });
    await client.connect();
    return client;
  };

  return { name, port, connect, admin: await connect() };
}

async function cleanupPostgres(name, volume) {
  try {
    docker('rm', '-f', name);
  } catch {}
  try {
    docker('volume', 'rm', '-f', volume);
  } catch {}
}

async function run() {
  console.log('--- Reservation Moves v3 Durable Journey Integration Test ---');
  let pg = null;
  let restoredPg = null;
  const clients = [];

  try {
    // -------------------------------------------------------------------------
    // Setup: Isolated PostgreSQL instance with migrations and staging API
    // -------------------------------------------------------------------------
    console.log(
      '[Setup 1/4] Spawning isolated staging PostgreSQL container...',
    );
    pg = await spawnPostgres(containerName, volumeName);
    clients.push(pg.admin);

    console.log('[Setup 2/4] Bootstrapping roles and installing migrations...');
    for (const file of [
      'database/postgres/bootstrap-roles.sql',
      'database/postgres/bootstrap-internal-roles.sql',
      'database/postgres/staging/bootstrap-verifier.sql',
    ]) {
      await pg.admin.query(await sqlFile(file));
    }

    await pg.admin.query(`
      ALTER ROLE hirearchy_migrator PASSWORD '${migratorPassword}';
      ALTER ROLE r23_gateway PASSWORD '${gatewayPassword}';
      ALTER ROLE app_candidate_gateway PASSWORD '${candidatePassword}';
    `);

    // Migration apply
    const migratorClient = await pg.connect(
      'hirearchy_migrator',
      migratorPassword,
    );
    clients.push(migratorClient);
    const initialMigration = await applyMigrations(migratorClient);
    assert.ok(initialMigration.appliedVersions.length >= 16);

    // Migration idempotency rehearsal: second run must succeed and verify all migrations
    const idempotentResult = await applyMigrations(migratorClient);
    assert.equal(
      idempotentResult.appliedVersions.length,
      initialMigration.appliedVersions.length,
      'Re-running migrations must be idempotent and succeed without error',
    );

    console.log('[Setup 3/4] Setting up synthetic Auth schema & tables...');
    await pg.admin.query(`
      CREATE ROLE supabase_auth_admin LOGIN PASSWORD '${pgPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
      ALTER ROLE supabase_auth_admin SET search_path=auth;

      CREATE TABLE auth.users (
        id uuid PRIMARY KEY,
        email text UNIQUE NOT NULL,
        email_confirmed_at timestamptz DEFAULT now(),
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );

      CREATE TABLE auth.sessions (
        id uuid PRIMARY KEY,
        user_id uuid REFERENCES auth.users(id) NOT NULL,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        not_after timestamptz
      );

      ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
      GRANT ALL ON SCHEMA auth TO supabase_auth_admin;
      GRANT ALL ON ALL TABLES IN SCHEMA auth TO supabase_auth_admin;
    `);

    console.log('[Setup 4/4] Installing staging API & verifier keys...');
    await pg.admin.query(
      await sqlFile('database/postgres/staging/install-api.sql'),
    );

    const edKeys = generateKeyPairSync('ed25519');
    const rawPublicKey = edKeys.publicKey
      .export({ format: 'der', type: 'spki' })
      .subarray(-32);

    await pg.admin.query(
      `INSERT INTO hirearchy.staging_verification_keys(
         key_id, issuer, audience, public_key, valid_from, valid_until
       ) VALUES ($1, $2, $3, $4, now() - interval '1 minute', now() + interval '30 days')`,
      ['key-res-1', 'hirearchy-staging', 'hirearchy-postgres', rawPublicKey],
    );

    // Gateway client for recruiter/reviewer staging operations
    const gateway = await pg.connect('r23_gateway', gatewayPassword);
    clients.push(gateway);

    // Candidate gateway client for candidate workspace operations
    const candidateGateway = await pg.connect(
      'app_candidate_gateway',
      candidatePassword,
    );
    clients.push(candidateGateway);

    // Provision test tenants and principals
    const orgIdA = randomUUID();
    const orgIdB = randomUUID();

    const recruiterA = {
      userId: randomUUID(),
      email: 'recruiter-a@example.test',
      authSessionId: randomUUID(),
      authExp: Math.floor(Date.now() / 1000) + 3600,
    };
    const reviewerA1 = {
      userId: randomUUID(),
      email: 'reviewer-a1@example.test',
      authSessionId: randomUUID(),
      authExp: Math.floor(Date.now() / 1000) + 3600,
    };
    const reviewerA2 = {
      userId: randomUUID(),
      email: 'reviewer-a2-unassigned@example.test',
      authSessionId: randomUUID(),
      authExp: Math.floor(Date.now() / 1000) + 3600,
    };
    const recruiterB = {
      userId: randomUUID(),
      email: 'recruiter-b-cross@example.test',
      authSessionId: randomUUID(),
      authExp: Math.floor(Date.now() / 1000) + 3600,
    };

    // Insert Auth records and Hirearchy principals
    for (const u of [recruiterA, reviewerA1, reviewerA2, recruiterB]) {
      await pg.admin.query(
        'INSERT INTO auth.users(id, email) VALUES ($1, $2)',
        [u.userId, u.email],
      );
      await pg.admin.query(
        "INSERT INTO auth.sessions(id, user_id, not_after) VALUES ($1, $2, now() + interval '2 hours')",
        [u.authSessionId, u.userId],
      );
      await pg.admin.query(
        'INSERT INTO hirearchy.application_principals(id, auth_user_id) VALUES ($1, $1)',
        [u.userId],
      );
      u.principalId = u.userId;
    }

    // Insert organizations and memberships
    await pg.admin.query(
      'INSERT INTO hirearchy.organizations(id) VALUES ($1), ($2)',
      [orgIdA, orgIdB],
    );
    await pg.admin.query(
      `INSERT INTO hirearchy.organization_memberships(organization_id, principal_id, role, status, joined_at, version)
       VALUES ($1, $2, 'recruiter', 'active', now(), 1),
              ($1, $3, 'reviewer', 'active', now(), 1),
              ($1, $4, 'reviewer', 'active', now(), 1),
              ($5, $6, 'recruiter', 'active', now(), 1)`,
      [
        orgIdA,
        recruiterA.principalId,
        reviewerA1.principalId,
        reviewerA2.principalId,
        orgIdB,
        recruiterB.principalId,
      ],
    );

    // Proof dispatch helper
    const dispatch = async (user, operation, args, overrides = {}) => {
      const now = Math.floor(Date.now() / 1000);
      const payloadObj = {
        v: 2,
        isRecovery: false,
        iss: 'hirearchy-staging',
        aud: 'hirearchy-postgres',
        kid: 'key-res-1',
        iat: now,
        exp: now + 60,
        auth_exp: user.authExp,
        jti: randomUUID(),
        sub: user.userId,
        sid: user.authSessionId,
        op: operation,
        args,
        ...overrides,
      };
      const payloadBytes = Buffer.from(canonical(payloadObj));
      const sig = sign(null, payloadBytes, edKeys.privateKey);
      const res = await gateway.query(
        'SELECT staging.dispatch($1::bytea, $2::bytea) AS result',
        [payloadBytes, sig],
      );
      return res.rows[0].result;
    };

    // Candidate command helper
    const candidateCommand = async (
      action,
      tokenHash,
      sessionId,
      input = {},
    ) => {
      const res = await candidateGateway.query(
        'SELECT hirearchy.r26_candidate_command($1, $2, $3, $4::pg_catalog.jsonb) AS view',
        [tokenHash, sessionId, action, JSON.stringify(input)],
      );
      return res.rows[0].view;
    };

    // =========================================================================
    // Stage 1: Approved-Template Catalog Exposure & Selection
    // =========================================================================
    console.log(
      'Stage 1: Testing approved-template catalog exposure & selection...',
    );
    await dispatch(recruiterA, 'session.open', { organizationId: orgIdA });
    const orgContext = await dispatch(recruiterA, 'organization.context', {
      organizationId: orgIdA,
    });

    assert.ok(
      Array.isArray(orgContext.availableTemplates),
      'organization.context must expose availableTemplates array',
    );
    const reservationTemplateMeta = orgContext.availableTemplates.find(
      (t) => t.templateId === 'reservation-moves-v3',
    );
    assert.ok(
      reservationTemplateMeta,
      'Reservation Moves v3 must be present in availableTemplates',
    );
    assert.equal(reservationTemplateMeta.scenarioId, 'reservation-moves');
    assert.equal(reservationTemplateMeta.scenarioVersion, 'v3');
    assert.equal(reservationTemplateMeta.title, 'Reservation Moves v3');

    // Domain catalog check
    const domainCatalog = listApprovedTemplates();
    assert.equal(domainCatalog.length, 1);
    const domainTemplate = getApprovedTemplate('reservation-moves-v3');
    assert.ok(domainTemplate);
    assert.equal(domainTemplate.recipeId, 'reservation-moves.pytest');
    assert.equal(
      domainTemplate.starterWorkspaceDigest,
      expectedWorkspaceDigest,
    );
    assert.deepEqual(domainTemplate.starterFilePaths, [
      'src/sender.py',
      'src/service.py',
      'src/state.py',
      'tests/test_moves.py',
    ]);

    // =========================================================================
    // Stage 2: Assessment Draft Creation with Reservation Moves v3
    // =========================================================================
    console.log('Stage 2: Creating template-backed draft...');
    const normalizedDraft = normalizeAssessmentTemplate({
      templateId: 'reservation-moves-v3',
      durationMinutes: 60,
      terminalEnabled: true,
      integratedAi: false,
    });
    assert.equal(normalizedDraft.title, 'Reservation Moves');
    assert.equal(normalizedDraft.primaryFilePath, 'src/service.py');
    assert.equal(normalizedDraft.starterFiles.length, 4);

    const createResult = await dispatch(recruiterA, 'assessment.create', {
      organizationId: orgIdA,
      content: normalizedDraft,
    });
    const assessmentId = createResult.assessmentId;
    assert.match(assessmentId, /^[0-9a-f-]{36}$/i);

    const draftInDb = await pg.admin.query(
      'SELECT template_id, title, primary_file_path FROM hirearchy.assessment_drafts WHERE definition_id = $1',
      [assessmentId],
    );
    assert.equal(draftInDb.rows[0].template_id, 'reservation-moves-v3');
    assert.equal(draftInDb.rows[0].title, 'Reservation Moves');
    assert.equal(draftInDb.rows[0].primary_file_path, 'src/service.py');

    // =========================================================================
    // Stage 3: Static Validation of the Template-Backed Assessment
    // =========================================================================
    console.log('Stage 3: Validating template-backed assessment...');
    const validationCheck = validateAssessmentDraft(normalizedDraft);
    assert.equal(validationCheck.valid, true);
    assert.equal(validationCheck.executionValidationAvailable, false);

    const binding = reservationMovesBinding();
    assert.equal(binding.templateId, 'reservation-moves-v3');
    assert.equal(binding.recipe.id, 'reservation-moves.pytest');
    assert.equal(binding.starterWorkspaceDigest, expectedWorkspaceDigest);

    const scenarioSnapshot = buildScenarioSnapshotEnvelope(
      'reservation-moves',
      'v3',
      normalizedDraft,
    );
    Object.assign(scenarioSnapshot.scenario, binding);

    const validatedVersionPayload = {
      contentDigest: computeCanonicalContentDigest(normalizedDraft, binding),
      scenarioId: 'reservation-moves',
      scenarioVersion: 'v3',
      scenarioTitle: normalizedDraft.title.trim(),
      scenarioSnapshot,
      taskRubricSnapshot: buildTaskRubricSnapshot(normalizedDraft),
      durationSeconds: normalizedDraft.durationMinutes * 60,
      terminalEnabled: normalizedDraft.terminalEnabled,
      integratedAi: normalizedDraft.integratedAi,
      validationReceipt: {
        validatedAt: new Date().toISOString(),
        checks: [
          'structural_schema',
          'file_boundaries',
          'rubric_weights',
          'duration_limits',
        ],
        executionValidationAvailable: false,
      },
    };

    const validateResult = await dispatch(recruiterA, 'assessment.validate', {
      organizationId: orgIdA,
      assessmentId,
      content: normalizedDraft,
      validatedVersion: validatedVersionPayload,
    });
    assert.equal(validateResult.validation.valid, true);
    assert.equal(validateResult.validation.executionValidationAvailable, false);
    assert.ok(validateResult.validatedVersionId);

    // =========================================================================
    // Stage 4: Assessment Issuance & Candidate Invitation Security
    // =========================================================================
    console.log(
      'Stage 4: Issuing assessment to Reviewer A1 & generating invitation...',
    );
    const issueResult = await dispatch(recruiterA, 'assessment.issue', {
      organizationId: orgIdA,
      assessmentId,
      reviewerPrincipalId: reviewerA1.principalId,
    });
    const sessionId = issueResult.sessionId;
    assert.match(sessionId, /^sess_[0-9a-f-]{36}$/i);
    assert.equal(issueResult.terminalEnabled, false);
    assert.equal(issueResult.integratedAi, false);

    // Verify session row in PostgreSQL
    const sessionRow = (
      await pg.admin.query(
        'SELECT scenario_id, scenario_version, scenario_title, status, terminal_enabled, ai_capability_snapshot FROM hirearchy.assessment_sessions WHERE id = $1',
        [sessionId],
      )
    ).rows[0];
    assert.equal(sessionRow.scenario_id, 'reservation-moves');
    assert.equal(sessionRow.scenario_version, 'v3');
    assert.equal(sessionRow.scenario_title, 'Reservation Moves');
    assert.equal(sessionRow.status, 'CREATED');
    assert.equal(sessionRow.terminal_enabled, false);
    assert.equal(sessionRow.ai_capability_snapshot.enabled, false);

    // Candidate token encryption and invitation lifecycle
    const rawCandidateToken = randomBytes(32).toString('base64url');
    const tokenHash = candidateTokenHash(rawCandidateToken);
    const keyBuffer = Buffer.from(candidateEncryptionKey, 'base64');
    const tokenCiphertext = encryptCandidateToken(
      rawCandidateToken,
      sessionId,
      keyBuffer,
    );

    const idempotencyKey = `inv-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    const inviteResult = await dispatch(
      recruiterA,
      'candidate.invitation.create',
      {
        organizationId: orgIdA,
        sessionId,
        idempotencyKey,
        expiresAt,
        candidateTokenHash: tokenHash,
        candidateTokenCiphertext: tokenCiphertext,
      },
    );
    assert.equal(inviteResult.status, 'active');
    assert.equal(inviteResult.sessionId, sessionId);

    // Revocation verification on a disposable envelope
    const disposableSessionId = `sess_disp_${randomUUID()}`;
    await pg.admin.query(
      `INSERT INTO hirearchy.assessment_sessions(id, organization_id, issuer_principal_id, status)
       VALUES ($1, $2, $3, 'CREATED')`,
      [disposableSessionId, orgIdA, recruiterA.principalId],
    );
    await pg.admin.query(
      `INSERT INTO hirearchy.candidate_token_envelopes(organization_id, session_id, candidate_token_hash, candidate_token_ciphertext, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [
        orgIdA,
        disposableSessionId,
        randomBytes(32).toString('hex'),
        tokenCiphertext,
      ],
    );
    const revokeRes = await dispatch(
      recruiterA,
      'candidate.invitation.revoke',
      {
        organizationId: orgIdA,
        sessionId: disposableSessionId,
      },
    );
    assert.equal(revokeRes.status, 'revoked');

    // =========================================================================
    // Stage 5: Candidate Access & Explicit Consent Persistence
    // =========================================================================
    console.log('Stage 5: Verifying affirmative consent enforcement...');
    // 5A: Rejection of invalid / string consent
    await assert.rejects(
      candidateCommand('activate', tokenHash, sessionId, {
        consent: {
          version: 'candidate-data-v1',
          digest: 'a'.repeat(64),
          accepted: 'true', // string must be rejected
        },
      }),
      (err) => err?.code === 'R2603',
      'Candidate activation must reject non-boolean string consent with R2603',
    );

    const sessionBeforeConsent = (
      await pg.admin.query(
        'SELECT status, activated_at FROM hirearchy.assessment_sessions WHERE id = $1',
        [sessionId],
      )
    ).rows[0];
    assert.equal(sessionBeforeConsent.status, 'CREATED');
    assert.equal(sessionBeforeConsent.activated_at, null);

    // 5B: Valid affirmative boolean consent persists
    const consentDigest =
      '9bfa590ff8fe9f3af6c9d020d9641bb736340b3f4ca03bc9e7aac3a0a1e22059';
    const activeView = await candidateCommand(
      'activate',
      tokenHash,
      sessionId,
      {
        consent: {
          version: 'candidate-data-v1',
          digest: consentDigest,
          accepted: true,
        },
      },
    );

    assert.equal(activeView.status, 'ACTIVE');
    assert.ok(activeView.activatedAt);

    const consentRows = (
      await pg.admin.query(
        'SELECT notice_version, notice_digest FROM hirearchy.candidate_data_consents WHERE session_id = $1',
        [sessionId],
      )
    ).rows;
    assert.equal(consentRows.length, 1);
    assert.equal(consentRows[0].notice_version, 'candidate-data-v1');
    assert.equal(consentRows[0].notice_digest, consentDigest);

    // =========================================================================
    // Stage 6: Candidate Workspace Initial Files & Save/Resume
    // =========================================================================
    console.log(
      'Stage 6: Checking Reservation Moves v3 starter files & durable save/resume...',
    );
    const initialWorkspace = await candidateCommand(
      'read',
      tokenHash,
      sessionId,
    );
    const workspacePaths = initialWorkspace.files.map((f) => f.path).sort();
    assert.deepEqual(
      workspacePaths,
      [
        'src/sender.py',
        'src/service.py',
        'src/state.py',
        'tests/test_moves.py',
      ],
      'Candidate workspace must unpack exactly the 4 Reservation Moves v3 files',
    );

    for (const f of initialWorkspace.files) {
      assert.equal(
        Number(f.version),
        0,
        `File ${f.path} must start at version 0`,
      );
      assert.ok(
        f.content.length > 0,
        `File ${f.path} must contain template code`,
      );
      assert.equal(
        createHash('sha256').update(f.content).digest('hex'),
        f.digest,
      );
    }

    // Candidate edits src/service.py to fix capacity preservation
    const serviceFile = initialWorkspace.files.find(
      (f) => f.path === 'src/service.py',
    );
    const fixedServiceCode = `${serviceFile.content}\n# Capacity preservation fix applied\ndef fixed_move_helper(): pass\n`;

    const saveRequestId = randomUUID();
    const saveResult = await candidateCommand('save', tokenHash, sessionId, {
      requestId: saveRequestId,
      path: 'src/service.py',
      content: fixedServiceCode,
      expectedVersion: '0',
    });
    assert.equal(saveResult.status, 'ACTIVE');

    // Verify file revision persistence in PostgreSQL
    const revisionRows = (
      await pg.admin.query(
        'SELECT version, file_path, content_digest FROM hirearchy.candidate_file_revisions WHERE session_id = $1 AND file_path = $2 ORDER BY version',
        [sessionId, 'src/service.py'],
      )
    ).rows;
    assert.equal(revisionRows.length, 1);
    assert.equal(Number(revisionRows[0].version), 1);
    assert.equal(
      revisionRows[0].content_digest,
      createHash('sha256').update(fixedServiceCode).digest('hex'),
    );

    // Verify workspace event recorded
    const eventRows = (
      await pg.admin.query(
        'SELECT sequence, event_type FROM hirearchy.candidate_session_events WHERE session_id = $1 ORDER BY sequence',
        [sessionId],
      )
    ).rows;
    assert.equal(eventRows.length, 2); // 1: SESSION_ACTIVATED, 2: WORKSPACE_CHANGED
    assert.equal(eventRows[0].event_type, 'SESSION_ACTIVATED');
    assert.equal(eventRows[1].event_type, 'WORKSPACE_CHANGED');

    // Resume / read returns the updated version 1 of src/service.py
    const resumedWorkspace = await candidateCommand(
      'read',
      tokenHash,
      sessionId,
    );
    const resumedService = resumedWorkspace.files.find(
      (f) => f.path === 'src/service.py',
    );
    assert.equal(Number(resumedService.version), 1);
    assert.equal(resumedService.content, fixedServiceCode);

    // =========================================================================
    // Stage 7: Durable Submission Capture
    // =========================================================================
    console.log(
      'Stage 7: Submitting candidate assessment and checking finality...',
    );
    const submitResult = await candidateCommand(
      'submit',
      tokenHash,
      sessionId,
      {
        requestId: randomUUID(),
        expectedWorkspaceDigest: resumedWorkspace.workspaceDigest,
      },
    );
    assert.equal(submitResult.status, 'SUBMITTED');

    const submittedSessionDb = (
      await pg.admin.query(
        'SELECT status, closure_reason, submitted_at FROM hirearchy.assessment_sessions WHERE id = $1',
        [sessionId],
      )
    ).rows[0];
    assert.equal(submittedSessionDb.status, 'SUBMITTED');
    assert.equal(submittedSessionDb.closure_reason, 'candidate_submission');
    assert.ok(submittedSessionDb.submitted_at);

    const submissionRows = (
      await pg.admin.query(
        'SELECT closure_reason, workspace_digest, manifest_digest FROM hirearchy.candidate_session_submissions WHERE session_id = $1',
        [sessionId],
      )
    ).rows;
    assert.equal(submissionRows.length, 1);
    assert.equal(submissionRows[0].closure_reason, 'candidate_submission');

    // Post-submission mutation must be rejected with R2605
    await assert.rejects(
      candidateCommand('save', tokenHash, sessionId, {
        requestId: randomUUID(),
        path: 'src/service.py',
        content: 'def late_edit(): pass',
        expectedVersion: '1',
      }),
      (err) => err?.code === 'R2605',
      'Modifying workspace after submission must fail with R2605 (session already final)',
    );

    // =========================================================================
    // Stage 8: Evidence Provenance & Truthful Capability Restrictions
    // =========================================================================
    console.log(
      'Stage 8: Verifying evidence provenance and truthful restrictions...',
    );
    await dispatch(reviewerA1, 'session.open', { organizationId: orgIdA });
    const evidence = await dispatch(reviewerA1, 'evidence.read', {
      organizationId: orgIdA,
      sessionId,
    });

    assert.equal(evidence.session.id, sessionId);
    assert.equal(evidence.session.scenarioId, 'reservation-moves');
    assert.equal(evidence.session.scenarioVersion, 'v3');
    assert.equal(evidence.session.scenarioTitle, 'Reservation Moves');
    assert.equal(evidence.session.status, 'SUBMITTED');
    assert.equal(evidence.session.terminalEnabled, false);
    assert.equal(evidence.session.aiCapabilitySnapshot.enabled, false);
    assert.match(
      evidence.captureLimitation,
      /Candidate execution is disabled in this staging lane/i,
    );

    assert.equal(evidence.events.length, 3); // ACTIVATED, CHANGED, SUBMITTED
    assert.equal(evidence.fileRevisions.length, 1); // src/service.py v1
    assert.equal(evidence.submissions.length, 1);

    // Non-negotiable rule: No automated competence scores or rankings in evidence
    const evidenceJson = JSON.stringify(evidence);
    assert.equal(
      evidenceJson.includes('competenceScore'),
      false,
      'Evidence must not contain automated competenceScore',
    );
    assert.equal(
      evidenceJson.includes('ranking'),
      false,
      'Evidence must not contain ranking',
    );

    // =========================================================================
    // Stage 9: Evaluator Access & Authorization Boundaries
    // =========================================================================
    console.log('Stage 9: Checking evaluator authorization boundaries...');
    // 9A: Recruiter cannot read evidence (recruiter != reviewer)
    await assert.rejects(
      dispatch(recruiterA, 'evidence.read', {
        organizationId: orgIdA,
        sessionId,
      }),
      (err) => err?.code === '42501',
      'Recruiter role must be denied evidence.read with 42501',
    );

    // 9B: Unassigned reviewer cannot read evidence
    await dispatch(reviewerA2, 'session.open', { organizationId: orgIdA });
    await assert.rejects(
      dispatch(reviewerA2, 'evidence.read', {
        organizationId: orgIdA,
        sessionId,
      }),
      (err) => err?.code === '42501',
      'Unassigned reviewer must be denied evidence.read with 42501',
    );

    // 9C: Unassigned reviewer cannot write review packet
    await assert.rejects(
      dispatch(reviewerA2, 'review.packet.save', {
        organizationId: orgIdA,
        sessionId,
        input: {
          summary: 'Unassigned review attempt',
          strengths: [],
          concerns: [],
          unresolvedQuestions: [],
          referencedObservationIds: [],
          referencedEvidence: [],
        },
      }),
      (err) => err?.code === '42501',
      'Unassigned reviewer must be denied review.packet.save with 42501',
    );

    // 9D: Cross-org recruiter cannot access session
    await dispatch(recruiterB, 'session.open', { organizationId: orgIdB });
    await assert.rejects(
      dispatch(recruiterB, 'evidence.read', {
        organizationId: orgIdB,
        sessionId,
      }),
      (err) => err?.code === '42501',
      'Cross-org recruiter must be denied access with 42501',
    );

    // 9E: Recovery credential proof must be denied at proof boundary
    await assert.rejects(
      dispatch(
        reviewerA1,
        'evidence.read',
        { organizationId: orgIdA, sessionId },
        { isRecovery: true }, // Forged or recovery proof
      ),
      (err) => err?.code === '28000',
      'Proof with isRecovery: true must be rejected with 28000 (Authentication Denied)',
    );

    // =========================================================================
    // Stage 10: Human Review Lifecycle
    // =========================================================================
    console.log(
      'Stage 10: Testing human review lifecycle (observations, draft, finalize)...',
    );
    const fileRevisionDigest = evidence.fileRevisions[0].contentDigest;
    const observationCreate = await dispatch(
      reviewerA1,
      'evidence.observation.create',
      {
        organizationId: orgIdA,
        sessionId,
        input: {
          evidenceSourceType: 'file_revision',
          eventSequence: '2',
          filePath: 'src/service.py',
          fileVersion: '1',
          evidenceDigest: fileRevisionDigest,
          body: 'Candidate preserved booking capacity and verified idempotency in service.py.',
        },
      },
    );
    const observationId = observationCreate.id;
    assert.match(observationId, /^[0-9a-f-]{36}$/i);

    // Update observation
    await dispatch(reviewerA1, 'evidence.observation.update', {
      organizationId: orgIdA,
      sessionId,
      observationId,
      input: {
        expectedVersion: 1,
        body: 'Candidate preserved booking capacity and verified idempotency in service.py (reviewed with full history).',
      },
    });

    // Save draft human review packet
    const savePacketRes = await dispatch(reviewerA1, 'review.packet.save', {
      organizationId: orgIdA,
      sessionId,
      input: {
        summary:
          'Evaluator human review: candidate demonstrated competent concurrency and capacity management.',
        strengths: [
          'Correctly retained existing slot capacity during replay.',
          'Maintained immutable attempt history.',
        ],
        concerns: ['Could extend test suite to assert multi-tenant isolation.'],
        unresolvedQuestions: ['How does service behave under process crash?'],
        referencedObservationIds: [observationId],
        referencedEvidence: [
          {
            evidenceSourceType: 'file_revision',
            eventSequence: '2',
            filePath: 'src/service.py',
            fileVersion: '1',
            evidenceDigest: fileRevisionDigest,
          },
        ],
      },
    });
    assert.equal(savePacketRes.reviewPacket.status, 'DRAFT');
    assert.equal(savePacketRes.reviewPacket.version, 1);

    // Finalize human review packet
    const finalizePacketRes = await dispatch(
      reviewerA1,
      'review.packet.finalize',
      {
        organizationId: orgIdA,
        sessionId,
        input: {
          expectedVersion: 1,
        },
      },
    );
    assert.equal(finalizePacketRes.reviewPacket.status, 'FINALIZED');
    assert.ok(finalizePacketRes.reviewPacket.finalizedAt);
    assert.ok(finalizePacketRes.reviewPacket.finalDigest);

    // Reviewer reads review
    const finalReviewRead = await dispatch(reviewerA1, 'review.read', {
      organizationId: orgIdA,
      sessionId,
    });
    assert.equal(finalReviewRead.packets.length, 1);
    assert.equal(finalReviewRead.packets[0].status, 'FINALIZED');
    assert.equal(
      finalReviewRead.packets[0].summary,
      'Evaluator human review: candidate demonstrated competent concurrency and capacity management.',
    );
    assert.ok(
      finalReviewRead.history.length >= 1,
      'Review history must record draft and finalized versions',
    );

    // Mutation of finalized review packet must be rejected with R2105
    await assert.rejects(
      dispatch(reviewerA1, 'review.packet.save', {
        organizationId: orgIdA,
        sessionId,
        input: {
          expectedVersion: 2,
          summary: 'Attempt to overwrite finalized review',
          strengths: [],
          concerns: [],
          unresolvedQuestions: [],
          referencedObservationIds: [],
          referencedEvidence: [],
        },
      }),
      (err) => err?.code === 'R2105',
      'Overwriting or mutating a finalized review packet must be rejected with R2105',
    );

    // =========================================================================
    // Stage 11: Application Restart and PostgreSQL Backup/Restore Rehearsal
    // =========================================================================
    console.log(
      'Stage 11: Rehearsing application restart and PostgreSQL backup/restore...',
    );
    // Disconnect clients to simulate application shutdown
    await gateway.end();
    await candidateGateway.end();
    await migratorClient.end();

    // Reconnect to simulate restart
    const restartedGateway = await pg.connect('r23_gateway', gatewayPassword);
    clients.push(restartedGateway);

    // Verify evidence and review after restart
    const restartedProof = async (operation, args) => {
      const now = Math.floor(Date.now() / 1000);
      const payloadObj = {
        v: 2,
        isRecovery: false,
        iss: 'hirearchy-staging',
        aud: 'hirearchy-postgres',
        kid: 'key-res-1',
        iat: now,
        exp: now + 60,
        auth_exp: reviewerA1.authExp,
        jti: randomUUID(),
        sub: reviewerA1.userId,
        sid: reviewerA1.authSessionId,
        op: operation,
        args,
      };
      const payloadBytes = Buffer.from(canonical(payloadObj));
      const sig = sign(null, payloadBytes, edKeys.privateKey);
      const res = await restartedGateway.query(
        'SELECT staging.dispatch($1::bytea, $2::bytea) AS result',
        [payloadBytes, sig],
      );
      return res.rows[0].result;
    };

    await restartedProof('session.open', { organizationId: orgIdA });
    const restartEvidence = await restartedProof('evidence.read', {
      organizationId: orgIdA,
      sessionId,
    });
    assert.equal(restartEvidence.session.id, sessionId);
    assert.equal(restartEvidence.session.scenarioId, 'reservation-moves');
    assert.equal(restartEvidence.session.scenarioVersion, 'v3');
    assert.equal(restartEvidence.events.length, 3);
    assert.equal(restartEvidence.fileRevisions.length, 1);
    assert.equal(restartEvidence.submissions.length, 1);

    // Capture globals and binary dump via pg_dumpall / pg_dump
    console.log('Capturing database cluster globals and backup dump...');
    const globalsBytes = execFileSync(
      'docker',
      ['exec', pg.name, 'pg_dumpall', '-U', 'postgres', '--globals-only'],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const dumpBytes = execFileSync(
      'docker',
      ['exec', pg.name, 'pg_dump', '-U', 'postgres', '-Fc', 'postgres'],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    assert.ok(
      globalsBytes.length > 0,
      'Globals dump must produce non-empty script',
    );
    assert.ok(
      dumpBytes.length > 0,
      'Backup dump must produce non-empty archive',
    );

    // Spawn separate restored PostgreSQL instance
    console.log('Restoring backup into a separate PostgreSQL instance...');
    restoredPg = await spawnPostgres(restoredContainerName, restoredVolumeName);
    clients.push(restoredPg.admin);

    // Restore cluster globals first (roles and permissions)
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        restoredPg.name,
        'psql',
        '-U',
        'postgres',
        '-d',
        'postgres',
      ],
      { input: globalsBytes, maxBuffer: 64 * 1024 * 1024 },
    );

    // Execute pg_restore on the restored container
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        restoredPg.name,
        'pg_restore',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '--clean',
        '--if-exists',
      ],
      { input: dumpBytes, maxBuffer: 64 * 1024 * 1024 },
    );

    // Re-verify roles in restored database
    await restoredPg.admin.query(`
      ALTER ROLE hirearchy_migrator PASSWORD '${migratorPassword}';
      ALTER ROLE r23_gateway PASSWORD '${gatewayPassword}';
      ALTER ROLE app_candidate_gateway PASSWORD '${candidatePassword}';
    `);

    const restoredGateway = await restoredPg.connect(
      'r23_gateway',
      gatewayPassword,
    );
    clients.push(restoredGateway);

    const restoredProof = async (operation, args) => {
      const now = Math.floor(Date.now() / 1000);
      const payloadObj = {
        v: 2,
        isRecovery: false,
        iss: 'hirearchy-staging',
        aud: 'hirearchy-postgres',
        kid: 'key-res-1',
        iat: now,
        exp: now + 60,
        auth_exp: reviewerA1.authExp,
        jti: randomUUID(),
        sub: reviewerA1.userId,
        sid: reviewerA1.authSessionId,
        op: operation,
        args,
      };
      const payloadBytes = Buffer.from(canonical(payloadObj));
      const sig = sign(null, payloadBytes, edKeys.privateKey);
      const res = await restoredGateway.query(
        'SELECT staging.dispatch($1::bytea, $2::bytea) AS result',
        [payloadBytes, sig],
      );
      return res.rows[0].result;
    };

    await restoredProof('session.open', { organizationId: orgIdA });
    const restoredEvidence = await restoredProof('evidence.read', {
      organizationId: orgIdA,
      sessionId,
    });
    assert.equal(restoredEvidence.session.id, sessionId);
    assert.equal(restoredEvidence.session.scenarioId, 'reservation-moves');
    assert.equal(restoredEvidence.session.scenarioVersion, 'v3');
    assert.equal(restoredEvidence.events.length, 3);
    assert.equal(restoredEvidence.fileRevisions.length, 1);
    assert.equal(restoredEvidence.submissions.length, 1);

    const restoredReview = await restoredProof('review.read', {
      organizationId: orgIdA,
      sessionId,
    });
    assert.equal(restoredReview.packets.length, 1);
    assert.equal(restoredReview.packets[0].status, 'FINALIZED');
    assert.equal(
      restoredReview.packets[0].summary,
      'Evaluator human review: candidate demonstrated competent concurrency and capacity management.',
    );
    assert.ok(restoredReview.history.length >= 1);

    console.log(
      '✓ ALL 11 STAGES OF RESERVATION MOVES V3 DURABLE JOURNEY PASSED SUCCESSFULLY!',
    );
  } finally {
    // Graceful cleanup of clients
    for (const c of clients) {
      await c.end().catch(() => {});
    }
    // Safe removal of test containers and volumes
    if (pg) {
      await cleanupPostgres(pg.name, volumeName);
    }
    if (restoredPg) {
      await cleanupPostgres(restoredPg.name, restoredVolumeName);
    }
  }
}

run().catch((error) => {
  console.error('FAILED with error:', error);
  process.exit(1);
});
