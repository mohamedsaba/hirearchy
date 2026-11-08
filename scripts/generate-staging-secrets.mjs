import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmod, lstat, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

function required(values, name) {
  const value = values.get(name);
  assert(value && !value.startsWith('SET_'), `${name} must be filled in first`);
  return value;
}

function setValue(lines, name, value) {
  let found = false;
  const next = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || match[1] !== name) return line;
    assert(match[2].startsWith('SET_'), `${name} is already configured; refusing to replace it`);
    found = true;
    return `${name}=${value}`;
  });
  assert(found, `Template is missing ${name}`);
  return next;
}

async function generate(targetPath) {
  assert(targetPath, 'Provide the root-only environment file path');
  const absolutePath = path.resolve(targetPath);
  const existing = await lstat(absolutePath);
  assert(existing.isFile() && !existing.isSymbolicLink(), 'Environment path must be a regular file');
  assert((existing.mode & 0o077) === 0, 'Set the environment file mode to 0600 before generating secrets');

  let lines = (await readFile(absolutePath, 'utf8')).split(/\r?\n/);
  const values = new Map();
  for (const line of lines) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  const pgPort = required(values, 'PG_PORT');
  const authPort = required(values, 'GOTRUE_API_PORT');
  assert(/^\d{1,5}$/.test(pgPort) && Number(pgPort) > 0, 'PG_PORT must be set before generating secrets');
  assert(/^\d{1,5}$/.test(authPort) && Number(authPort) > 0, 'GOTRUE_API_PORT must be set before generating secrets');

  const passwords = Object.fromEntries(
    [
      'POSTGRES_PASSWORD',
      'GOTRUE_DB_PASSWORD',
      'MIGRATOR_DATABASE_PASSWORD',
      'R23_GATEWAY_PASSWORD',
      'CANDIDATE_GATEWAY_PASSWORD',
      'APP_EVALUATOR_PASSWORD',
      'CONTROL_WORKER_PASSWORD',
      'GOTRUE_JWT_SECRET',
    ].map((name) => [name, randomBytes(32).toString('hex')]),
  );
  const { privateKey } = generateKeyPairSync('ed25519');
  const proofPrivateKey = privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .toString('base64');
  const candidateKey = randomBytes(32).toString('base64');

  for (const [name, value] of Object.entries(passwords)) {
    lines = setValue(lines, name, value);
  }
  lines = setValue(lines, 'STAGING_PROOF_PRIVATE_KEY', proofPrivateKey);
  lines = setValue(lines, 'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY', candidateKey);
  lines = setValue(
    lines,
    'STAGING_ADMIN_DATABASE_URL',
    `postgres://postgres:${passwords.POSTGRES_PASSWORD}@127.0.0.1:${pgPort}/postgres`,
  );
  lines = setValue(
    lines,
    'STAGING_MIGRATOR_DATABASE_URL',
    `postgres://hirearchy_migrator:${passwords.MIGRATOR_DATABASE_PASSWORD}@127.0.0.1:${pgPort}/postgres`,
  );
  lines = setValue(
    lines,
    'STAGING_DATABASE_URL',
    `postgres://r23_gateway:${passwords.R23_GATEWAY_PASSWORD}@127.0.0.1:${pgPort}/postgres`,
  );
  lines = setValue(
    lines,
    'STAGING_CANDIDATE_DATABASE_URL',
    `postgres://app_candidate_gateway:${passwords.CANDIDATE_GATEWAY_PASSWORD}@127.0.0.1:${pgPort}/postgres`,
  );
  lines = setValue(
    lines,
    'STAGING_AUTH_URL',
    `http://127.0.0.1:${authPort}`,
  );

  const temporaryPath = `${absolutePath}.${randomBytes(6).toString('hex')}.tmp`;
  const content = `${lines.join('\n').replace(/\n*$/, '')}\n`;
  await writeFile(temporaryPath, content, { mode: 0o600, flag: 'wx' });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, absolutePath);
  console.log(`Generated staging secrets in ${absolutePath}; output mode is 0600. No secret values were printed.`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    await generate(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Secret generation failed');
    process.exitCode = 1;
  }
}
