import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open as openFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadCandidateTokenEncryptionKey } from '../apps/web/src/sessions/candidate-token-storage.mjs';

const keyFile = 'candidate-token-encryption.key';
const keyLookup =
  'SELECT EXISTS (SELECT 1 FROM hirearchy.candidate_token_envelopes) AS has_envelopes';

function canonicalKey(value) {
  return loadCandidateTokenEncryptionKey(value).toString('base64');
}

async function ensureProtectedDirectory(dataRoot, dataDirectory) {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(dataRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (typeof process.getuid === 'function' && rootStat.uid !== process.getuid())
  ) {
    throw new Error('Refusing unsafe local staging data directory.');
  }

  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(dataDirectory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (directoryStat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' &&
      directoryStat.uid !== process.getuid())
  ) {
    throw new Error('Refusing unprotected local candidate-key directory.');
  }
}

async function readStoredKey(path) {
  if (
    typeof fsConstants.O_NOFOLLOW !== 'number' ||
    typeof fsConstants.O_NONBLOCK !== 'number'
  ) {
    throw new Error('Local candidate-key storage requires safe file opens.');
  }
  let handle;
  try {
    handle = await openFile(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Stored local candidate token encryption key is unsafe.');
  }
  try {
    const fileStat = await handle.stat();
    if (
      !fileStat.isFile() ||
      (fileStat.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === 'function' &&
        fileStat.uid !== process.getuid())
    ) {
      throw new Error(
        'Stored local candidate token encryption key is unprotected.',
      );
    }
    const contents = await handle.readFile({ encoding: 'utf8' });
    const value = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
    if (value.includes('\n') || value.includes('\r')) {
      throw new Error(
        'Stored local candidate token encryption key is invalid.',
      );
    }
    return canonicalKey(value);
  } finally {
    await handle.close();
  }
}

async function storeKey(path, value) {
  if (typeof fsConstants.O_NOFOLLOW !== 'number') {
    throw new Error(
      'Local candidate-key storage requires no-follow file opens.',
    );
  }
  let handle;
  try {
    handle = await openFile(
      path,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error.code === 'EEXIST') {
      const existing = await readStoredKey(path);
      if (existing === value) return existing;
      throw new Error(
        'Local candidate token encryption key changed during setup.',
      );
    }
    throw new Error('Unable to create protected local candidate token key.');
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${value}\n`, { encoding: 'utf8' });
    await handle.sync();
    const fileStat = await handle.stat();
    if (
      !fileStat.isFile() ||
      (fileStat.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === 'function' &&
        fileStat.uid !== process.getuid())
    ) {
      throw new Error('Created local candidate token key is unprotected.');
    }
    return value;
  } finally {
    await handle.close();
  }
}

export async function loadOrCreateLocalCandidateTokenEncryptionKey({
  dataRoot,
  dataDirectory,
  adminClient,
  configuredKey,
}) {
  await ensureProtectedDirectory(dataRoot, dataDirectory);
  const path = join(dataDirectory, keyFile);
  const existing = await readStoredKey(path);
  if (existing !== null) {
    if (
      configuredKey !== undefined &&
      canonicalKey(configuredKey) !== existing
    ) {
      throw new Error(
        'Configured candidate token encryption key does not match the protected local key.',
      );
    }
    return existing;
  }

  const result = await adminClient.query(keyLookup);
  const hasEnvelopes = result?.rows?.[0]?.has_envelopes;
  if (hasEnvelopes === true) {
    throw new Error(
      'Candidate token encryption key is missing while encrypted invitations exist; restore the original protected key before starting.',
    );
  }
  if (hasEnvelopes !== false) {
    throw new Error(
      'Unable to verify whether encrypted candidate invitations exist.',
    );
  }

  const value =
    configuredKey === undefined
      ? randomBytes(32).toString('base64')
      : canonicalKey(configuredKey);
  return storeKey(path, value);
}
