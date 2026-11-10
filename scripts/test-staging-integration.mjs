// Owned disposable resources; real Auth and persistent application recovery.
import assert from 'node:assert/strict';
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFile,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { applyMigrations } from '../database/postgres/migrate.mjs';
import { provisionStaging } from './provision-staging.mjs';
import { checkPrivateReview } from '../tests/staging/private-review.mjs';
import { captureRelease } from '../tests/staging/release.mjs';
import {
  checkInstallerBoundary,
  checkProofBoundary,
  checkReviewPacketPersistence,
  checkReviewerRowLockBoundary,
} from '../tests/staging/security.mjs';
import { checkReadinessBoundary } from '../tests/staging/readiness-boundary.mjs';
import {
  checkBrowserAcceptance,
  createActiveCandidateInvitationFingerprint,
  verifyCandidateInvitationRecovery,
  stagingFailureSource,
} from '../tests/staging/browser.mjs';
import {
  candidateReviewApiHash,
  candidateReviewRecoveryHash,
} from '../tests/staging/candidate-review-recovery.mjs';
const name = `hirearchy-r215-${randomBytes(6).toString('hex')}`;
const presentationMode = process.argv.includes('--presentation');
const presentationReadyFile = process.env.HIREARCHY_PRESENTATION_READY_FILE;
const image = 'hirearchy-staging-postgres-local';
const authImage =
  'supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b';
const password = randomBytes(32).toString('hex');
const candidatePassword = randomBytes(32).toString('hex');
const candidateTokenEncryptionKey = randomBytes(32).toString('base64');
const jwtSecret = randomBytes(48).toString('hex');
const issuer = 'https://auth.hirearchy.test/auth/v1';
const keys = generateKeyPairSync('ed25519');
const proofPrivateKey = keys.privateKey
  .export({ format: 'der', type: 'pkcs8' })
  .toString('base64');
const artifact = new URL(`../.data/${name}/`, import.meta.url);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const artifactPath = fileURLToPath(artifact);
const browserEvidence = new URL('browser-evidence/', artifact);
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
const sqlFile = async (file) =>
  readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const resources = [];
const volumes = [];
let networkCreated = false;
const clients = [];
let app;
let appLog = '';
let stage = 'setup';
let presenterFile;
const waitFor = async (check) => {
  for (let i = 0; i < 150; i++) {
    try {
      if (await check()) return;
    } catch {
      /* Startup only. */
    }
    await delay(200);
  }
  throw new Error('Readiness deadline exceeded');
};
async function reserveLoopbackPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
async function db(container) {
  const port = await reserveLoopbackPort();
  docker(
    'run',
    '-d',
    '--name',
    container,
    '--label',
    `hirearchy.r215.owner=${name}`,
    '--network',
    name,
    '--network-alias',
    container,
    '-p',
    `127.0.0.1:${port}:5432`,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-v',
    `${container}-data:/var/lib/postgresql/data`,
    image,
  );
  resources.push(container);
  volumes.push(`${container}-data`);
  await waitFor(() =>
    docker('exec', container, 'pg_isready', '-U', 'postgres').includes(
      'accepting connections',
    ),
  );
  assert.equal(
    docker('port', container, '5432/tcp'),
    `127.0.0.1:${port}`,
    'PostgreSQL uses its reserved loopback-only host port',
  );
  // pg_isready on the local socket can observe initdb's temporary server.
  // Wait for the final TCP listener used by the application, not that server.
  await waitFor(async () => {
    const probe = new Client({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: 'postgres',
      connectionTimeoutMillis: 1000,
    });
    try {
      await probe.connect();
      await probe.query('SELECT 1');
      return true;
    } finally {
      await probe.end();
    }
  });
  const connect = async (user = 'postgres', rolePassword = password) => {
    const client = new Client({
      host: '127.0.0.1',
      port,
      user,
      password: rolePassword,
      database: 'postgres',
    });
    await client.connect();
    clients.push(client);
    return client;
  };
  return { container, port, connect, admin: await connect() };
}

async function assertStringConsentRejected(source, sourceSessionId) {
  const sessionId = `sess_consent_${randomUUID().replaceAll('-', '')}`;
  const tokenHash = randomBytes(32).toString('hex');
  await source.admin.query(
    `INSERT INTO hirearchy.assessment_sessions (
       id, organization_id, issuer_principal_id
     )
     SELECT $1, session.organization_id, session.issuer_principal_id
       FROM hirearchy.assessment_sessions AS session
      WHERE session.id = $2`,
    [sessionId, sourceSessionId],
  );
  await source.admin.query(
    `INSERT INTO hirearchy.candidate_token_envelopes (
       organization_id, session_id, candidate_token_hash,
       candidate_token_ciphertext, expires_at
     )
     SELECT session.organization_id, session.id, $2,
            'synthetic-consent-type-fixture',
            pg_catalog.clock_timestamp() + INTERVAL '7 days'
       FROM hirearchy.assessment_sessions AS session
      WHERE session.id = $1`,
    [sessionId, tokenHash],
  );

  const candidate = await source.connect(
    'app_candidate_gateway',
    candidatePassword,
  );
  const snapshot = async () => {
    const { rows } = await source.admin.query(
      `SELECT session.status, session.activated_at, session.submitted_at,
              (SELECT pg_catalog.count(*)::pg_catalog.int4
                 FROM hirearchy.candidate_session_events AS event
                WHERE event.session_id = session.id) AS event_count,
              (SELECT pg_catalog.count(*)::pg_catalog.int4
                 FROM hirearchy.candidate_workspace_files AS file
                WHERE file.session_id = session.id) AS file_count,
              (SELECT pg_catalog.count(*)::pg_catalog.int4
                 FROM hirearchy.candidate_session_operations AS operation
                WHERE operation.session_id = session.id) AS operation_count,
              (SELECT pg_catalog.count(*)::pg_catalog.int4
                 FROM hirearchy.candidate_session_submissions AS submission
                WHERE submission.session_id = session.id) AS submission_count,
              (SELECT pg_catalog.count(*)::pg_catalog.int4
                 FROM hirearchy.candidate_data_consents AS consent
                WHERE consent.session_id = session.id) AS consent_count
         FROM hirearchy.assessment_sessions AS session
        WHERE session.id = $1`,
      [sessionId],
    );
    assert.equal(rows.length, 1);
    return rows[0];
  };
  try {
    const before = await snapshot();
    await assert.rejects(
      candidate.query(
        `SELECT hirearchy.r26_candidate_command(
           $1, $2, 'activate', $3::pg_catalog.jsonb
         )`,
        [
          tokenHash,
          sessionId,
          JSON.stringify({
            consent: {
              version: 'candidate-data-v1',
              digest:
                '9bfa590ff8fe9f3af6c9d020d9641bb736340b3f4ca03bc9e7aac3a0a1e22059',
              accepted: 'true',
            },
          }),
        ],
      ),
      (error) => error?.code === 'R2603',
      'durable candidate command rejects the JSON string "true" for consent',
    );
    assert.deepEqual(
      await snapshot(),
      before,
      'invalid consent does not create consent, activation, or candidate evidence',
    );
  } finally {
    await candidate.end();
  }
}

async function bootstrap(target) {
  for (const file of [
    'bootstrap-roles.sql',
    'bootstrap-internal-roles.sql',
    'staging/bootstrap-verifier.sql',
  ])
    await target.admin.query(await sqlFile(`database/postgres/${file}`));
  await target.admin.query(
    `ALTER ROLE hirearchy_migrator PASSWORD '${password}'; ALTER ROLE r23_gateway PASSWORD '${password}'; ALTER ROLE app_candidate_gateway PASSWORD '${candidatePassword}'`,
  );
}
async function migrate(target) {
  const client = await target.connect('hirearchy_migrator');
  await applyMigrations(client);
  await client.end();
}
async function authRoles(target, schema = true) {
  await target.admin.query(
    `CREATE ROLE supabase_auth_admin LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN`,
  );
  if (schema)
    await target.admin.query(
      'CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin',
    );
  await target.admin.query(
    'ALTER ROLE supabase_auth_admin SET search_path=auth',
  );
}
async function auth(target, suffix) {
  const container = `${name}-auth-${suffix}`;
  docker(
    'run',
    '-d',
    '--name',
    container,
    '--label',
    `hirearchy.r215.owner=${name}`,
    '--network',
    name,
    '-p',
    '127.0.0.1::9999',
    ...Object.entries({
      GOTRUE_API_HOST: '0.0.0.0',
      PORT: '9999',
      API_EXTERNAL_URL: issuer,
      GOTRUE_SITE_URL: 'https://hirearchy.example.test',
      GOTRUE_DB_DRIVER: 'postgres',
      GOTRUE_DB_DATABASE_URL: `postgres://supabase_auth_admin:${password}@${target.container}:5432/postgres?sslmode=disable`,
      GOTRUE_DB_NAMESPACE: 'auth',
      GOTRUE_JWT_SECRET: jwtSecret,
      GOTRUE_JWT_ISSUER: issuer,
      GOTRUE_JWT_EXP: '3600',
      GOTRUE_JWT_AUD: 'authenticated',
      GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
      GOTRUE_DISABLE_SIGNUP: 'true',
      GOTRUE_MAILER_AUTOCONFIRM: 'true',
      GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
    }).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    authImage,
  );
  resources.push(container);
  const port = Number(/:(\d+)$/.exec(docker('port', container, '9999/tcp'))[1]);
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${url}/health`)).ok);
  return url;
}
async function startApp(
  target,
  authUrl,
  proofKey,
  applicationDirectory = 'apps/web',
) {
  const port = await reserveLoopbackPort();
  appLog = '';
  app = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      'start',
      applicationDirectory,
      '-H',
      '127.0.0.1',
      '-p',
      String(port),
    ],
    {
      cwd: new URL('../', import.meta.url),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HIREARCHY_RUNTIME_PROFILE: 'staging-authenticated',
        STAGING_AUTH_URL: authUrl,
        STAGING_AUTH_ISSUER: issuer,
        STAGING_AUTH_AUDIENCE: 'authenticated',
        STAGING_DATABASE_URL: `postgres://r23_gateway:${password}@127.0.0.1:${target.port}/postgres`,
        STAGING_CANDIDATE_DATABASE_URL: `postgres://app_candidate_gateway:${candidatePassword}@127.0.0.1:${target.port}/postgres`,
        HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY: candidateTokenEncryptionKey,
        STAGING_PROOF_PRIVATE_KEY: proofKey ?? proofPrivateKey,
        STAGING_PROOF_ISSUER: 'hirearchy-staging',
        STAGING_PROOF_AUDIENCE: 'hirearchy-postgres',
        STAGING_PROOF_KEY_ID: 'rehearsal-1',
        STAGING_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      },
    },
  );
  app.stdout.on('data', (data) => {
    appLog += data;
  });
  app.stderr.on('data', (data) => {
    appLog += data;
  });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${url}/api/health`)).ok);
  return url;
}
async function stopApp() {
  if (app && app.exitCode === null) {
    app.kill('SIGTERM');
    await once(app, 'exit');
  }
  app = undefined;
}
async function waitForPresentationStop() {
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let resolveStop;
  let stopped = false;
  const stoppedBy = new Promise((resolve) => {
    resolveStop = resolve;
  });
  const finish = (reason) => {
    if (stopped) return;
    stopped = true;
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    input.close();
    if (reason === 'SIGINT') process.exitCode = 130;
    if (reason === 'SIGTERM') process.exitCode = 143;
    resolveStop(reason);
  };
  const onSigint = () => finish('SIGINT');
  const onSigterm = () => finish('SIGTERM');
  input.once('line', () => finish('Enter'));
  input.once('close', () => finish('stdin closed'));
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  if (presentationReadyFile) {
    await writeFile(
      presentationReadyFile,
      JSON.stringify({
        name,
        presenterFile: presenterFile.pathname,
        resources,
        volumes,
        network: name,
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
    await chmod(presentationReadyFile, 0o600);
  }

  console.log(
    'Press Enter or Ctrl-C to stop the local demo; SIGTERM also works.',
  );
  return stoppedBy;
}
function adminJwt() {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      role: 'service_role',
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url')}`;
}
const login = async (authUrl, email, userPassword) => {
  const response = await fetch(`${authUrl}/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: userPassword }),
  });
  assert.equal(response.status, 200, 'Real GoTrue login');
  return (await response.json()).access_token;
};
function syntheticAmrVariants(originalAccessToken) {
  const [header, encodedPayload] = originalAccessToken.split('.');
  assert.ok(header && encodedPayload);
  const headerClaims = JSON.parse(
    Buffer.from(header, 'base64url').toString('utf8'),
  );
  assert.equal(headerClaims.alg, 'HS256', 'GoTrue bearer uses HS256');
  const original = JSON.parse(
    Buffer.from(encodedPayload, 'base64url').toString('utf8'),
  );
  assert.equal(typeof original.sub, 'string');
  assert.equal(typeof original.session_id, 'string');
  assert.equal(Number.isSafeInteger(original.exp), true);
  const now = Math.floor(Date.now() / 1000);
  const variants = [
    [
      'recovery AMR precedes password AMR',
      [
        { method: 'recovery', timestamp: now - 1 },
        { method: 'password', timestamp: now },
      ],
    ],
    [
      'recovery AMR follows password AMR',
      [
        { method: 'password', timestamp: now - 1 },
        { method: 'recovery', timestamp: now },
      ],
    ],
    ['missing AMR', undefined],
    ['empty AMR', []],
  ];
  return variants.map(([label, amr]) => {
    const claims = { ...original };
    if (amr === undefined) delete claims.amr;
    else claims.amr = amr;
    assert.deepEqual(
      [claims.sub, claims.session_id, claims.exp],
      [original.sub, original.session_id, original.exp],
      'Synthetic AMR variant preserves original subject, session, and expiry',
    );
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signingInput = `${header}.${payload}`;
    const signature = createHmac('sha256', jwtSecret)
      .update(signingInput)
      .digest('base64url');
    return { label, token: `${signingInput}.${signature}` };
  });
}
async function assertGoTrueAcceptsExactToken(authUrl, token, subjectId) {
  const response = await fetch(`${authUrl}/user`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200, 'GoTrue accepts synthetic AMR bearer');
  const user = await response.json();
  assert.equal(user.id, subjectId, 'GoTrue /user subject matches token');
}
const call = async (url, token, op, args, expected = 200) => {
  const response = await fetch(`${url}/api/staging/v1`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ op, args }),
  });
  assert.equal(response.status, expected, `${op} HTTP status`);
  return response.json();
};
async function restore(
  dump,
  suffix,
  globals = null,
  expectedRoleAttributes = null,
) {
  const target = await db(`${name}-${suffix}`);
  if (globals) {
    const lines = globals.toString('utf8').split(/\r?\n/);
    const postgresRoleCreateCount = lines.filter(
      (line) => line === 'CREATE ROLE postgres;',
    ).length;
    assert.equal(
      postgresRoleCreateCount,
      1,
      'globals contain one built-in postgres CREATE ROLE statement',
    );
    const filteredGlobals = `${lines
      .filter((line) => line !== 'CREATE ROLE postgres;')
      .join('\n')}\n`;
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        target.container,
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
        '-d',
        'postgres',
      ],
      {
        input: filteredGlobals,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      },
    );
  } else {
    await bootstrap(target);
    await authRoles(target, false);
    await target.admin.query(
      'DROP SCHEMA hirearchy CASCADE; DROP EXTENSION plpython3u',
    );
  }
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      target.container,
      'pg_restore',
      '-U',
      'postgres',
      '--exit-on-error',
      '-d',
      'postgres',
    ],
    {
      input: dump,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  await migrate(target);
  if (expectedRoleAttributes) {
    assert.deepEqual(
      await readRoleAttributes(target.admin),
      expectedRoleAttributes,
      'restored PostgreSQL role attributes match the encrypted snapshot',
    );
  }
  return target;
}
async function createSnapshotManifest({
  admin,
  dump,
  sourceIdentity,
  release,
  postgresImageId,
  authImageId,
}) {
  const { rows } = await admin.query(
    'SELECT version, checksum FROM hirearchy.schema_migrations ORDER BY version',
  );
  assert.ok(rows.length > 0, 'Snapshot has an applied migration ledger');
  const migrationLedger = rows.map(({ version, checksum }) => ({
    version,
    checksum,
  }));
  assert.ok(
    migrationLedger.every((migration) =>
      /^[0-9a-f]{64}$/.test(migration.checksum),
    ),
    'Snapshot migration checksums identify exact migration bytes',
  );

  return {
    databaseSha256: createHash('sha256').update(dump).digest('hex'),
    sourceDirty: sourceIdentity.sourceDirty,
    gitHead: sourceIdentity.gitHead,
    image: postgresImageId,
    imageReference: image,
    authImage: { reference: authImage, imageId: authImageId },
    migrationLedger,
    release,
  };
}

async function readRoleAttributes(admin) {
  const { rows } = await admin.query(`
    SELECT rolname,
           rolsuper,
           rolcreaterole,
           rolcreatedb,
           rolcanlogin,
           rolreplication,
           rolbypassrls
      FROM pg_catalog.pg_roles
     ORDER BY rolname
  `);
  return rows;
}

async function writePrivateFile(filename, content) {
  await writeFile(filename, content, { mode: 0o600, flag: 'wx' });
  await chmod(filename, 0o600);
}

async function createEncryptedCandidateReviewBackup({
  dump,
  globals,
  snapshotManifest,
  roleAttributes,
}) {
  const suffix = randomBytes(8).toString('hex');
  const archiveName = `candidate-review-backup-${suffix}.tar.gz.gpg`;
  const archivePath = path.join(artifactPath, archiveName);
  const checksumName = `${archiveName}.sha256`;
  const checksumPath = path.join(artifactPath, checksumName);
  let snapshotPath;
  let privatePath;
  let snapshotName;
  let tarPath;
  let passphrasePath;
  let gpgHome;
  let decryptedPath;
  let temporaryArchivePath;
  let completed = false;
  let gpgMayHaveStarted = false;
  let archivePublished = false;
  let checksumPublished = false;

  try {
    snapshotPath = await mkdtemp(
      path.join(artifactPath, 'candidate-review-snapshot-'),
    );
    snapshotName = path.basename(snapshotPath);
    privatePath = await mkdtemp(
      path.join(artifactPath, 'backup-drill-private-'),
    );
    await chmod(snapshotPath, 0o700);
    await chmod(privatePath, 0o700);
    tarPath = path.join(privatePath, `${snapshotName}.tar.gz`);
    passphrasePath = path.join(privatePath, 'passphrase');
    gpgHome = path.join(privatePath, 'gnupg');
    decryptedPath = path.join(privatePath, 'decrypted');
    temporaryArchivePath = path.join(privatePath, archiveName);
    await mkdir(gpgHome, { mode: 0o700 });
    await chmod(gpgHome, 0o700);
    await mkdir(decryptedPath, { mode: 0o700 });
    await chmod(decryptedPath, 0o700);

    const intakeSourcePath = path.join(privatePath, 'intake-source');
    await mkdir(intakeSourcePath, { mode: 0o700 });
    await chmod(intakeSourcePath, 0o700);
    const intakeStorePath = path.join(
      intakeSourcePath,
      'early-access-requests.json',
    );
    const intakeRecord = {
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
      name: 'Synthetic Backup Fixture',
      email: `backup-${suffix}@example.test`,
      company: 'Synthetic Backup Test',
      teamSize: '1-10',
      role: 'recruiter',
      primaryChallenge: 'other',
      notes: 'Synthetic encrypted backup fixture.',
    };
    await writePrivateFile(
      intakeStorePath,
      `${JSON.stringify([intakeRecord], null, 2)}\n`,
    );

    const intakeExportPath = path.join(snapshotPath, 'early-access.json');
    const exportResult = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'scripts/manage-early-access-requests.mjs',
        'export',
        '--all',
        '--apply',
        '--output',
        intakeExportPath,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          EARLY_ACCESS_STORAGE_PATH: intakeStorePath,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const exportSummary = JSON.parse(exportResult);
    assert.equal(exportSummary.ok, true);
    assert.equal(exportSummary.operation, 'export');
    assert.equal(exportSummary.exportedCount, 1);
    assert.deepEqual(JSON.parse(await readFile(intakeExportPath, 'utf8')), [
      intakeRecord,
    ]);

    const includedFiles = [
      'candidate-review-snapshot-manifest.json',
      'early-access.json',
      'postgres-globals.sql',
      'postgres.dump',
      'private-recovery.json',
      'release-manifest.json',
      'role-attributes.json',
    ].sort();
    const payloadFiles = [
      ['postgres.dump', dump],
      ['postgres-globals.sql', globals],
      [
        'candidate-review-snapshot-manifest.json',
        `${JSON.stringify(snapshotManifest, null, 2)}\n`,
      ],
      [
        'release-manifest.json',
        await readFile(new URL('release-manifest.json', artifact)),
      ],
      [
        'private-recovery.json',
        await readFile(new URL('private-recovery.json', artifact)),
      ],
      ['role-attributes.json', `${JSON.stringify(roleAttributes, null, 2)}\n`],
    ];
    for (const [filename, content] of payloadFiles) {
      await writePrivateFile(path.join(snapshotPath, filename), content);
    }

    const backupMetadata = {
      version: 1,
      createdAt: new Date().toISOString(),
      classification: 'synthetic staging recovery fixture',
      archiveFormat: 'tar.gz',
      encryption: 'GPG symmetric AES-256',
      checksum: 'SHA-256',
      databaseDumpFormat: 'PostgreSQL custom archive',
      intakeExport: 'validated JSON snapshot; no lock or temporary siblings',
      restoreRequirement:
        'replay available deletion receipts before restarting intake writers',
      includedFiles: [...includedFiles, 'backup-metadata.json'].sort(),
      intakeExportCount: exportSummary.exportedCount,
    };
    await writePrivateFile(
      path.join(snapshotPath, 'backup-metadata.json'),
      `${JSON.stringify(backupMetadata, null, 2)}\n`,
    );
    const filesToChecksum = [...includedFiles, 'backup-metadata.json'].sort();
    const checksums = [];
    for (const filename of filesToChecksum) {
      const bytes = await readFile(path.join(snapshotPath, filename));
      checksums.push(
        `${createHash('sha256').update(bytes).digest('hex')}  ${filename}`,
      );
    }
    await writePrivateFile(
      path.join(snapshotPath, 'checksums.sha256'),
      `${checksums.join('\n')}\n`,
    );
    assert.equal((await stat(snapshotPath)).mode & 0o777, 0o700);
    for (const filename of [...filesToChecksum, 'checksums.sha256']) {
      assert.equal(
        (await stat(path.join(snapshotPath, filename))).mode & 0o777,
        0o600,
        `snapshot file ${filename} is private`,
      );
    }

    execFileSync('tar', ['-czf', tarPath, '-C', artifactPath, snapshotName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const passphrase = randomBytes(32).toString('base64url');
    await writePrivateFile(passphrasePath, `${passphrase}\n`);
    gpgMayHaveStarted = true;
    execFileSync(
      'gpg',
      [
        '--homedir',
        gpgHome,
        '--batch',
        '--pinentry-mode',
        'loopback',
        '--passphrase-file',
        passphrasePath,
        '--symmetric',
        '--cipher-algo',
        'AES256',
        '--output',
        temporaryArchivePath,
        tarPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await link(temporaryArchivePath, archivePath);
    archivePublished = true;
    await chmod(archivePath, 0o600);

    const archiveBytes = await readFile(archivePath);
    const archiveSha256 = createHash('sha256')
      .update(archiveBytes)
      .digest('hex');
    await writePrivateFile(checksumPath, `${archiveSha256}  ${archiveName}\n`);
    checksumPublished = true;
    assert.equal((await stat(archivePath)).mode & 0o777, 0o600);
    assert.equal((await stat(checksumPath)).mode & 0o777, 0o600);
    execFileSync('sha256sum', ['--check', checksumName], {
      cwd: artifactPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const tamperedName = `${archiveName}.tampered`;
    const tamperedPath = path.join(privatePath, tamperedName);
    const tamperedChecksumPath = path.join(privatePath, 'tampered.sha256');
    await writeFile(tamperedPath, archiveBytes, { mode: 0o600, flag: 'wx' });
    await appendFile(tamperedPath, Buffer.from([0]));
    await writePrivateFile(
      tamperedChecksumPath,
      `${archiveSha256}  ${tamperedName}\n`,
    );
    const tamperCheck = spawnSync('sha256sum', ['--check', 'tampered.sha256'], {
      cwd: privatePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(tamperCheck.error, undefined, 'checksum tool is available');
    assert.equal(
      tamperCheck.status,
      1,
      'tampered archive checksum is rejected',
    );

    await rm(snapshotPath, { recursive: true, force: true });
    await rm(tarPath, { force: true });
    const decryptedTarPath = path.join(decryptedPath, 'backup.tar.gz');
    execFileSync(
      'gpg',
      [
        '--homedir',
        gpgHome,
        '--batch',
        '--pinentry-mode',
        'loopback',
        '--passphrase-file',
        passphrasePath,
        '--output',
        decryptedTarPath,
        '--decrypt',
        archivePath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    execFileSync(
      'tar',
      [
        '-xzf',
        decryptedTarPath,
        '--no-same-owner',
        '--no-same-permissions',
        '-C',
        decryptedPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const restoredSnapshotPath = path.join(decryptedPath, snapshotName);
    await chmod(restoredSnapshotPath, 0o700);
    assert.equal((await stat(decryptedPath)).mode & 0o777, 0o700);
    assert.equal((await stat(restoredSnapshotPath)).mode & 0o777, 0o700);
    execFileSync('sha256sum', ['--check', 'checksums.sha256'], {
      cwd: restoredSnapshotPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const decryptedDump = await readFile(
      path.join(restoredSnapshotPath, 'postgres.dump'),
    );
    const decryptedGlobals = await readFile(
      path.join(restoredSnapshotPath, 'postgres-globals.sql'),
    );
    assert.equal(
      createHash('sha256').update(decryptedDump).digest('hex'),
      createHash('sha256').update(dump).digest('hex'),
      'decrypted database archive matches the captured source bytes',
    );
    assert.equal(
      createHash('sha256').update(decryptedGlobals).digest('hex'),
      createHash('sha256').update(globals).digest('hex'),
      'decrypted PostgreSQL globals match the captured source bytes',
    );
    const restoredIntake = JSON.parse(
      await readFile(
        path.join(restoredSnapshotPath, 'early-access.json'),
        'utf8',
      ),
    );
    assert.equal(
      restoredIntake.length,
      1,
      'encrypted intake export is present',
    );
    const restoredRoles = JSON.parse(
      await readFile(
        path.join(restoredSnapshotPath, 'role-attributes.json'),
        'utf8',
      ),
    );
    assert.deepEqual(restoredRoles, roleAttributes);
    completed = true;
    return {
      archiveName,
      checksumName,
      archiveSha256,
      dump: decryptedDump,
      globals: decryptedGlobals,
      roleAttributes: restoredRoles,
      intakeExportCount: restoredIntake.length,
    };
  } finally {
    if (gpgMayHaveStarted && gpgHome) {
      try {
        execFileSync('gpgconf', ['--homedir', gpgHome, '--kill', 'gpg-agent'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error('Private backup GPG agent cleanup failed.');
          process.exitCode = 1;
        }
      }
    }
    if (snapshotPath) {
      await rm(snapshotPath, { recursive: true, force: true });
    }
    if (privatePath) {
      await rm(privatePath, { recursive: true, force: true });
    }
    if (!completed) {
      if (archivePublished) await rm(archivePath, { force: true });
      if (checksumPublished) await rm(checksumPath, { force: true });
    }
  }
}
integration: try {
  await mkdir(artifact, { recursive: true, mode: 0o700 });
  await chmod(artifact, 0o700);
  await mkdir(browserEvidence, { recursive: true, mode: 0o700 });
  const postgresImageId = docker(
    'image',
    'inspect',
    image,
    '--format',
    '{{.Id}}',
  );
  const authImageId = docker(
    'image',
    'inspect',
    authImage,
    '--format',
    '{{.Id}}',
  );
  docker('network', 'create', name);
  networkCreated = true;
  const unpackRelease = await captureRelease(artifact);
  const sourceIdentity = {
    sourceDirty: Boolean(
      execFileSync('git', ['status', '--porcelain'], {
        encoding: 'utf8',
      }).trim(),
    ),
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
  };
  const releaseManifest = JSON.parse(
    await readFile(new URL('release-manifest.json', artifact), 'utf8'),
  );
  stage = 'fresh database';
  const source = await db(`${name}-source`);
  await bootstrap(source);
  await migrate(source);
  stage = 'candidate lifecycle is absent before durable installation';
  const preinstallCandidate = await source.connect(
    'app_candidate_gateway',
    candidatePassword,
  );
  const preinstallReadiness = await preinstallCandidate.query(
    'SELECT hirearchy.r26_candidate_lifecycle_ready() AS ready',
  );
  assert.deepEqual(preinstallReadiness.rows, [{ ready: false }]);
  await preinstallCandidate.end();
  await authRoles(source);
  const authUrl = await auth(source, 'source');
  if (!presentationMode) {
    stage = 'installer rejects disposable fixture schema';
    await checkInstallerBoundary(
      source.admin,
      await sqlFile('database/postgres/staging/install-api.sql'),
    );
  }
  await source.admin.query(
    "INSERT INTO hirearchy.staging_verification_keys(key_id,issuer,audience,public_key,valid_from,valid_until) VALUES($1,$2,$3,$4,now()-interval '1 minute',now()+interval '1 day')",
    [
      'rehearsal-1',
      'hirearchy-staging',
      'hirearchy-postgres',
      keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
    ],
  );
  const organizationId = randomUUID();
  const userPassword = randomBytes(20).toString('hex');
  const input = {
    organizationId,
    users: [
      {
        email: 'recruiter@staging.test',
        password: userPassword,
        role: 'recruiter',
      },
      {
        email: 'reviewer@staging.test',
        password: userPassword,
        role: 'reviewer',
      },
      {
        email: 'other-reviewer@staging.test',
        password: userPassword,
        role: 'reviewer',
      },
    ],
  };
  stage = 'real durable provisioning';
  const provisioned = await provisionStaging(
    source.admin,
    authUrl,
    adminJwt(),
    input,
  );
  assert.deepEqual(
    await provisionStaging(source.admin, authUrl, adminJwt(), input),
    provisioned,
  );
  const recruiter = await login(authUrl, input.users[0].email, userPassword);
  const reviewer = await login(authUrl, input.users[1].email, userPassword);
  const otherReviewer = await login(
    authUrl,
    input.users[2].email,
    userPassword,
  );
  stage = 'persistent API installation';
  await source.admin.query(
    await sqlFile('database/postgres/staging/install-api.sql'),
  );
  stage = 'candidate lifecycle marker is installed';
  const installedCandidate = await source.connect(
    'app_candidate_gateway',
    candidatePassword,
  );
  const installedReadiness = await installedCandidate.query(
    'SELECT hirearchy.r26_candidate_lifecycle_ready() AS ready',
  );
  assert.deepEqual(installedReadiness.rows, [{ ready: true }]);
  await installedCandidate.end();
  let gateway;
  if (!presentationMode) {
    stage = 'database proof security';
    gateway = await source.connect('r23_gateway');
    await checkProofBoundary(
      gateway,
      source.admin,
      keys.privateKey,
      recruiter,
      organizationId,
      (checkpoint) => {
        stage = checkpoint;
      },
    );
    stage = 'database proof security complete';
  }
  let appUrl = await startApp(source, authUrl);
  let durableSessionWitness;
  if (!presentationMode) {
    stage = 'application authentication sessions before database outage';
    await call(appUrl, recruiter, 'session.open', { organizationId });
    await call(appUrl, reviewer, 'session.open', { organizationId });
    const authSessionIds = [recruiter, reviewer].map((token) => {
      const claims = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
      );
      return claims.session_id;
    });
    const durableSessionQuery = `
      SELECT auth_session_id::pg_catalog.text AS auth_session_id,
             subject_id::pg_catalog.text AS subject_id,
             organization_id::pg_catalog.text AS organization_id,
             principal_id::pg_catalog.text AS principal_id
        FROM hirearchy.staging_sessions
       WHERE organization_id = $1::pg_catalog.uuid
         AND auth_session_id = ANY($2::pg_catalog.uuid[])
       ORDER BY auth_session_id
    `;
    const { rows: sessionsBeforeOutage } = await source.admin.query(
      durableSessionQuery,
      [organizationId, authSessionIds],
    );
    assert.equal(
      sessionsBeforeOutage.length,
      2,
      'recruiter and reviewer Auth sessions are durably opened before outage',
    );
    durableSessionWitness = sessionsBeforeOutage;
    stage = 'readiness operational boundary';
    await checkReadinessBoundary({
      admin: source.admin,
      gateway,
      appUrl,
      postgresContainer: source.container,
      candidateTokenEncryptionKey,
      secrets: [
        password,
        candidatePassword,
        jwtSecret,
        proofPrivateKey,
        candidateTokenEncryptionKey,
      ],
      appLog: () => appLog,
      docker,
      waitFor,
      postgresHostPort: source.port,
      waitForDatabase: async () => {
        const deadline = Date.now() + 30000;
        let lastTransientCode;
        const captureRecoveryFailure = async () => {
          const state = docker(
            'inspect',
            '--format',
            'state={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}} ports={{json .NetworkSettings.Ports}}',
            source.container,
          );
          let publishedPort;
          try {
            publishedPort = docker('port', source.container, '5432/tcp');
          } catch (error) {
            const code =
              typeof error === 'object' && error !== null && 'status' in error
                ? error.status
                : 'unavailable';
            publishedPort = `unavailable (docker status ${code})`;
          }
          let startupLog;
          try {
            startupLog = docker('logs', '--tail', '80', source.container);
          } catch (error) {
            const code =
              typeof error === 'object' && error !== null && 'status' in error
                ? error.status
                : 'unavailable';
            startupLog = `unavailable (docker status ${code})`;
          }
          await writeFile(
            new URL('database-recovery-failure.txt', artifact),
            `state: ${state}\nexpected port: 127.0.0.1:${source.port}\npublished port: ${publishedPort}\nstartup log:\n${startupLog}\n`,
            { encoding: 'utf8', mode: 0o600, flag: 'wx' },
          );
        };
        while (Date.now() < deadline) {
          const probe = new Client({
            host: '127.0.0.1',
            port: source.port,
            user: 'postgres',
            password,
            database: 'postgres',
            connectionTimeoutMillis: 1000,
          });
          try {
            await probe.connect();
            await probe.query('SELECT 1');
            return;
          } catch (error) {
            const probeFailure =
              error instanceof Error && error.message === 'timeout expired'
                ? 'pg-connect-timeout'
                : error instanceof Error &&
                    error.message === 'Connection terminated'
                  ? 'pg-connection-terminated'
                  : error instanceof Error &&
                      error.message === 'Connection terminated unexpectedly'
                    ? 'pg-connection-terminated-unexpectedly'
                    : 'unclassified-error';
            const code =
              typeof error === 'object' && error !== null && 'code' in error
                ? error.code
                : undefined;
            if (
              code !== 'ECONNREFUSED' &&
              code !== 'ECONNRESET' &&
              code !== '57P03' &&
              !(
                code === undefined &&
                probeFailure === 'pg-connection-terminated-unexpectedly'
              )
            ) {
              await captureRecoveryFailure();
              console.error(
                `PostgreSQL recovery probe failure class: ${probeFailure}`,
              );
              throw error;
            }
            lastTransientCode = code ?? probeFailure;
          } finally {
            await probe.end().catch(() => {});
          }
          await delay(200);
        }
        await captureRecoveryFailure();
        throw new Error(
          `PostgreSQL recovery deadline exceeded (${lastTransientCode ?? 'no response'})`,
        );
      },
      closeDatabaseClients: async () => {
        await gateway.end();
        await source.admin.end();
      },
      reconnectDatabaseClients: async () => {
        source.admin = await source.connect();
        gateway = await source.connect('r23_gateway');
      },
      onCheckpoint: (checkpoint) => {
        stage = checkpoint;
      },
    });
    stage =
      'application authentication sessions persist across PostgreSQL restart';
    const { rows: sessionsAfterOutage } = await source.admin.query(
      durableSessionQuery,
      [organizationId, authSessionIds],
    );
    assert.deepEqual(
      sessionsAfterOutage,
      durableSessionWitness,
      'Auth-backed application session rows survive PostgreSQL restart',
    );
  }
  stage = 'verified application sessions';
  await call(appUrl, recruiter, 'session.open', { organizationId });
  await call(appUrl, reviewer, 'session.open', { organizationId });

  if (presentationMode) {
    stage = 'interactive synthetic presentation';
    presenterFile = new URL('presenter.json', artifact);
    await writeFile(
      presenterFile,
      JSON.stringify(
        {
          appUrl,
          organizationId,
          recruiter: {
            email: input.users[0].email,
            password: userPassword,
            loginUrl: `${appUrl}/r23/login`,
            builderUrl: `${appUrl}/r23/organizations/${organizationId}/builder`,
          },
          evaluator: {
            email: input.users[1].email,
            password: userPassword,
            principalId: provisioned.users[1].principalId,
            loginUrl: `${appUrl}/r23/login`,
            reviewUrl: `${appUrl}/r27/organizations/${organizationId}/sessions/{sessionId}`,
          },
          candidate: {
            name: 'Demo Candidate',
            email: 'candidate@hirearchy.test',
            note: 'Create a fresh invitation from the builder UI; no candidate user is pre-created.',
          },
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );
    await chmod(presenterFile, 0o600);
    console.log(`Presentation ready at ${appUrl}`);
    console.log(`Private presenter details: ${presenterFile.pathname}`);
    await waitForPresentationStop();
    console.log('Stopping presentation and cleaning owned staging resources.');
    break integration;
  }

  stage = 'recovery-proof boundary / normal password bearer';
  await call(appUrl, recruiter, 'session.open', { organizationId });
  const recruiterClaims = JSON.parse(
    Buffer.from(recruiter.split('.')[1], 'base64url').toString('utf8'),
  );
  for (const variant of syntheticAmrVariants(recruiter)) {
    stage = `recovery-proof boundary / GoTrue accepts ${variant.label}`;
    await assertGoTrueAcceptsExactToken(
      authUrl,
      variant.token,
      recruiterClaims.sub,
    );
    stage = `recovery-proof boundary / deny ${variant.label}`;
    await call(appUrl, variant.token, 'session.open', { organizationId }, 401);
  }
  const journey = await import('../tests/staging/journey.mjs');
  stage = 'durable assessment journey';
  const state = await journey.createJourney({
    call,
    appUrl,
    recruiter,
    reviewer,
    organizationId,
    provisioned,
  });
  stage = 'candidate consent accepts only a JSON boolean';
  await assertStringConsentRejected(source, state.sessionId);
  stage = 'application restart';
  await stopApp();
  appUrl = await startApp(source, authUrl);
  await journey.readJourney({
    call,
    appUrl,
    recruiter,
    reviewer,
    organizationId,
    state,
  });
  stage = 'backup snapshot';
  await stopApp();
  const dump = execFileSync(
    'docker',
    ['exec', source.container, 'pg_dump', '-U', 'postgres', '-Fc', 'postgres'],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  await writeFile(new URL('database.dump', artifact), dump, { mode: 0o600 });
  const initialSnapshotManifest = await createSnapshotManifest({
    admin: source.admin,
    dump,
    sourceIdentity,
    release: releaseManifest,
    postgresImageId,
    authImageId,
  });
  await writeFile(
    new URL('snapshot-manifest.json', artifact),
    JSON.stringify(initialSnapshotManifest, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  );
  await writeFile(
    new URL('private-recovery.json', artifact),
    JSON.stringify({
      jwtSecret,
      password,
      candidatePassword,
      candidateTokenEncryptionKey,
      privateKey: proofPrivateKey,
    }),
    { mode: 0o600 },
  );
  const snapshot = await readFile(new URL('database.dump', artifact));
  assert.deepEqual(
    snapshot,
    dump,
    'Saved backup bytes match the captured database',
  );
  stage = 'separate instance restore';
  const restored = await restore(snapshot, 'restored');
  const restoredAuth = await auth(restored, 'restored');
  appUrl = await startApp(restored, restoredAuth);
  await journey.readJourney({
    call,
    appUrl,
    recruiter,
    reviewer,
    organizationId,
    state,
  });
  stage = 'revocation';
  await journey.revokeJourney({
    call,
    appUrl,
    recruiter,
    reviewer,
    organizationId,
    state,
    admin: restored.admin,
    provisioned,
  });
  stage = 'failed release configuration';
  await stopApp();
  appUrl = await startApp(restored, restoredAuth, 'AA==');
  await call(appUrl, recruiter, 'session.open', { organizationId }, 503);
  stage = 'failed production artifact';
  await stopApp();
  await unpackRelease('broken-release', true);
  const restoredRelease = await unpackRelease('restored-release');
  stage = 'matching snapshot recovery';
  const rollback = await restore(snapshot, 'rollback');
  const rollbackAuth = await auth(rollback, 'rollback');
  appUrl = await startApp(rollback, rollbackAuth, undefined, restoredRelease);
  await journey.readJourney({
    call,
    appUrl,
    recruiter,
    reviewer,
    organizationId,
    state,
  });
  stage = 'private reviewer isolation regression';
  const { sessionId: submittedSessionId } = await checkPrivateReview({
    call,
    appUrl,
    recruiter,
    reviewer,
    otherReviewer,
    organizationId,
    state,
    admin: rollback.admin,
    provisioned,
  });
  stage = 'reviewer row-lock privilege boundary';
  await checkReviewerRowLockBoundary({
    admin: rollback.admin,
    organizationId,
    sessionId: submittedSessionId,
    reviewerPrincipalId: provisioned.users[1].principalId,
    issuerPrincipalId: provisioned.users[0].principalId,
  });
  stage = 'proof-bound review packet persistence regression';
  await checkReviewPacketPersistence({
    gateway: await rollback.connect('r23_gateway'),
    admin: rollback.admin,
    privateKey: keys.privateKey,
    reviewerBearer: reviewer,
    organizationId,
    reviewerPrincipalId: provisioned.users[1].principalId,
    issuerPrincipalId: provisioned.users[0].principalId,
    onCheckpoint: (checkpoint) => {
      stage = checkpoint;
    },
  });
  stage = 'unstarted invitation encryption-recovery fixture / GoTrue login';
  const invitationRecruiter = await login(
    rollbackAuth,
    input.users[0].email,
    userPassword,
  );
  stage = 'unstarted invitation encryption-recovery fixture / API session.open';
  await call(appUrl, invitationRecruiter, 'session.open', { organizationId });
  stage =
    'unstarted invitation encryption-recovery fixture / API assessment.create';
  const { assessmentId: invitationAssessmentId } = await call(
    appUrl,
    invitationRecruiter,
    'assessment.create',
    { organizationId, content: state.content },
  );
  stage =
    'unstarted invitation encryption-recovery fixture / API assessment.validate';
  await call(appUrl, invitationRecruiter, 'assessment.validate', {
    organizationId,
    assessmentId: invitationAssessmentId,
  });
  stage =
    'unstarted invitation encryption-recovery fixture / API assessment.issue';
  const { sessionId: activeInvitationSessionId } = await call(
    appUrl,
    invitationRecruiter,
    'assessment.issue',
    {
      organizationId,
      assessmentId: invitationAssessmentId,
      reviewerPrincipalId: provisioned.users[1].principalId,
    },
  );
  const activeInvitationFingerprint =
    await createActiveCandidateInvitationFingerprint({
      appUrl,
      user: input.users[0],
      organizationId,
      sessionId: activeInvitationSessionId,
      checkpoint: (step) => {
        stage = `unstarted invitation encryption-recovery fixture / ${step}`;
      },
    });
  stage = 'browser acceptance workflow';
  const browserAcceptance = await checkBrowserAcceptance({
    appUrl,
    users: input.users,
    organizationId,
    provisioned,
    stopApp,
    startApp: () =>
      startApp(rollback, rollbackAuth, undefined, restoredRelease),
    admin: rollback.admin,
    source: rollback,
    authUrl: rollbackAuth,
    submittedSessionId,
    browserEvidenceDir: browserEvidence.pathname,
    screenshotSensitiveValues: [
      password,
      candidatePassword,
      userPassword,
      jwtSecret,
      proofPrivateKey,
      candidateTokenEncryptionKey,
    ],
  });
  appUrl = browserAcceptance.appUrl;
  const reviewedSessionId = browserAcceptance.reviewedSessionId;
  assert.equal(
    reviewedSessionId,
    browserAcceptance.newlyIssuedSessionId,
    'The browser flow must return the reviewed session ID',
  );
  stage = 'candidate-review recovery snapshot assertions';
  const originalCandidateReviewHash = await candidateReviewRecoveryHash(
    rollback.admin,
    organizationId,
    reviewedSessionId,
  );
  const baselineRecruiter = await login(
    rollbackAuth,
    input.users[0].email,
    userPassword,
  );
  const baselineReviewer = await login(
    rollbackAuth,
    input.users[1].email,
    userPassword,
  );
  await call(appUrl, baselineRecruiter, 'session.open', { organizationId });
  await call(appUrl, baselineReviewer, 'session.open', { organizationId });
  const originalEvidence = await call(
    appUrl,
    baselineReviewer,
    'evidence.read',
    {
      organizationId,
      sessionId: reviewedSessionId,
    },
  );
  const originalReview = await call(appUrl, baselineReviewer, 'review.read', {
    organizationId,
    sessionId: reviewedSessionId,
  });
  const originalReviewerReadHash = candidateReviewApiHash(
    originalEvidence,
    originalReview,
  );

  stage = 'candidate-review backup and independent restore';
  await stopApp();
  const candidateReviewDump = execFileSync(
    'docker',
    [
      'exec',
      rollback.container,
      'pg_dump',
      '-U',
      'postgres',
      '-Fc',
      'postgres',
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const candidateReviewGlobals = execFileSync(
    'docker',
    [
      'exec',
      rollback.container,
      'pg_dumpall',
      '-U',
      'postgres',
      '--globals-only',
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const candidateReviewRoles = await readRoleAttributes(rollback.admin);
  const candidateReviewSnapshotManifest = await createSnapshotManifest({
    admin: rollback.admin,
    dump: candidateReviewDump,
    sourceIdentity,
    release: releaseManifest,
    postgresImageId,
    authImageId,
  });
  assert.deepEqual(
    candidateReviewSnapshotManifest.migrationLedger,
    initialSnapshotManifest.migrationLedger,
    'Candidate-review snapshot preserves the same applied migration set',
  );
  const encryptedCandidateReviewBackup =
    await createEncryptedCandidateReviewBackup({
      dump: candidateReviewDump,
      globals: candidateReviewGlobals,
      snapshotManifest: candidateReviewSnapshotManifest,
      roleAttributes: candidateReviewRoles,
    });
  const candidateReviewRecovery = await restore(
    encryptedCandidateReviewBackup.dump,
    'candidate-review-recovery',
    encryptedCandidateReviewBackup.globals,
    encryptedCandidateReviewBackup.roleAttributes,
  );
  const candidateReviewAuth = await auth(
    candidateReviewRecovery,
    'candidate-review-recovery',
  );
  appUrl = await startApp(
    candidateReviewRecovery,
    candidateReviewAuth,
    undefined,
    restoredRelease,
  );
  const recoveredRecruiter = await login(
    candidateReviewAuth,
    input.users[0].email,
    userPassword,
  );
  const recoveredReviewer = await login(
    candidateReviewAuth,
    input.users[1].email,
    userPassword,
  );
  await call(appUrl, recoveredRecruiter, 'session.open', { organizationId });
  await call(appUrl, recoveredReviewer, 'session.open', { organizationId });
  const recoveredEvidence = await call(
    appUrl,
    recoveredReviewer,
    'evidence.read',
    { organizationId, sessionId: reviewedSessionId },
  );
  const recoveredReview = await call(appUrl, recoveredReviewer, 'review.read', {
    organizationId,
    sessionId: reviewedSessionId,
  });
  if (
    candidateReviewApiHash(recoveredEvidence, recoveredReview) !==
    originalReviewerReadHash
  ) {
    throw new Error(
      'Authorized reviewer evidence/review changed after restore',
    );
  }
  const recoveredCandidateReviewHash = await candidateReviewRecoveryHash(
    candidateReviewRecovery.admin,
    organizationId,
    reviewedSessionId,
  );
  if (recoveredCandidateReviewHash !== originalCandidateReviewHash) {
    throw new Error('Candidate-review database rows changed after restore');
  }
  await verifyCandidateInvitationRecovery({
    appUrl,
    user: input.users[0],
    organizationId,
    activeSessionId: activeInvitationSessionId,
    revokedSessionId: reviewedSessionId,
    expectedActiveFingerprint: activeInvitationFingerprint,
    checkpoint: (step) => {
      stage = `candidate-review invitation recovery / ${step}`;
    },
  });
  await writeFile(
    new URL('result.json', artifact),
    JSON.stringify(
      {
        passed: true,
        image: postgresImageId,
        encryptedBackup: {
          archive: encryptedCandidateReviewBackup.archiveName,
          checksum: encryptedCandidateReviewBackup.checksumName,
          encryption: 'GPG symmetric AES-256',
          checksumAlgorithm: 'SHA-256',
          archiveSha256: encryptedCandidateReviewBackup.archiveSha256,
          checksumVerified: true,
          tamperRejected: true,
          intakeExportCount: encryptedCandidateReviewBackup.intakeExportCount,
          separateDatabaseRestore: true,
          reviewerPacketAndInvitationRestore: true,
        },
        recovery:
          'The initial journey and completed candidate/reviewer workflow were independently restored from a decrypted encrypted backup; the protected candidate invitation key remained stable.',
        limitation:
          'Failed signing-key configuration and corrupt production artifact rolled back to retained release archive and matching snapshot; arbitrary schema downgrade is not supported.',
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    `Encrypted backup verified: GPG AES-256; SHA-256 ${encryptedCandidateReviewBackup.archiveSha256}; tamper rejected; decrypted PostgreSQL, app, reviewer packet, invitation and one synthetic intake export restored.`,
  );
  console.log(
    `Persistent staging journey and candidate-review recovery passed. Private recovery artifacts: ${artifact.pathname}`,
  );
} catch (error) {
  await writeFile(
    new URL('failure.txt', artifact),
    `${stage}\n${error.stack}\n${appLog}\n${resources.map((container) => `\n${container}\n${docker('logs', container)}`).join('')}`,
    { mode: 0o600 },
  );
  const failureSource = stagingFailureSource(error);
  const errorLabel =
    error &&
    typeof error === 'object' &&
    typeof error.code === 'string' &&
    /^[A-Za-z0-9_]{1,32}$/.test(error.code)
      ? error.code
      : error instanceof Error &&
          /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(error.name)
        ? error.name
        : 'UnknownError';
  console.error(
    `Staging integration failed at ${stage} (${errorLabel}${failureSource ? `; source=${failureSource}` : ''}); private diagnostics: ${artifact.pathname}`,
  );
  process.exitCode = 1;
} finally {
  await stopApp();
  for (const client of clients) await client.end().catch(() => undefined);
  const cleanup = (kind, resource, ...args) => {
    try {
      docker(kind, ...args, resource);
    } catch {
      console.error(`Owned staging resource requires cleanup: ${resource}`);
      process.exitCode = 1;
    }
  };
  for (const container of resources.reverse()) cleanup('rm', container, '-f');
  for (const volume of volumes) cleanup('volume', volume, 'rm');
  if (networkCreated) cleanup('network', name, 'rm');
  if (presenterFile) {
    try {
      await unlink(presenterFile);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(
          'Could not remove the private presenter credential file.',
        );
        process.exitCode = 1;
      }
    }
  }
}
