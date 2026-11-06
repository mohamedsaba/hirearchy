import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { loadOrCreateLocalCandidateTokenEncryptionKey } from '../../scripts/local-candidate-key.mjs';

const keyPath = (fixture) =>
  join(fixture.dataDirectory, 'candidate-token-encryption.key');

async function fixture(t) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'hirearchy-candidate-key-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  return { dataRoot, dataDirectory: join(dataRoot, 'local-staging') };
}

function database(hasEnvelopes) {
  return {
    query: async (sql) => {
      assert.equal(
        sql,
        'SELECT EXISTS (SELECT 1 FROM hirearchy.candidate_token_envelopes) AS has_envelopes',
      );
      return { rows: [{ has_envelopes: hasEnvelopes }] };
    },
  };
}

async function assertProtectedKeyFile(path, expectedKey) {
  assert.ok(
    (await readFile(path, 'utf8')) === `${expectedKey}\n`,
    'Stored key contents did not match the requested key',
  );
  const metadata = await stat(path);
  assert.equal(metadata.mode & 0o777, 0o600);
  if (typeof process.getuid === 'function') {
    assert.equal(metadata.uid, process.getuid());
  }
}

test('creates a protected key once and reuses it without querying for records', async (t) => {
  const local = await fixture(t);
  const created = await loadOrCreateLocalCandidateTokenEncryptionKey({
    ...local,
    adminClient: database(false),
  });
  assert.ok(
    /^[A-Za-z0-9+/]{43}=$/.test(created),
    'Created key is not canonical',
  );
  await assertProtectedKeyFile(keyPath(local), created);

  const reused = await loadOrCreateLocalCandidateTokenEncryptionKey({
    ...local,
    configuredKey: created,
    adminClient: {
      query: async () =>
        assert.fail('Existing key should bypass the DB lookup'),
    },
  });
  assert.ok(reused === created, 'Key reuse returned a different value');
  await assertProtectedKeyFile(keyPath(local), created);
});

test('refuses to generate a missing key when encrypted invitations exist', async (t) => {
  const local = await fixture(t);
  let lookups = 0;
  await assert.rejects(
    loadOrCreateLocalCandidateTokenEncryptionKey({
      ...local,
      adminClient: {
        query: async (sql) => {
          lookups += 1;
          assert.equal(
            sql,
            'SELECT EXISTS (SELECT 1 FROM hirearchy.candidate_token_envelopes) AS has_envelopes',
          );
          return { rows: [{ has_envelopes: true }] };
        },
      },
    }),
    /missing while encrypted invitations exist/,
  );
  assert.equal(lookups, 1);
  await assert.rejects(readFile(keyPath(local)), { code: 'ENOENT' });
});

test('rejects a configured mismatch without replacing the stored key', async (t) => {
  const local = await fixture(t);
  const storedKey = Buffer.alloc(32, 17).toString('base64');
  const otherKey = Buffer.alloc(32, 29).toString('base64');
  await loadOrCreateLocalCandidateTokenEncryptionKey({
    ...local,
    configuredKey: storedKey,
    adminClient: database(false),
  });

  await assert.rejects(
    loadOrCreateLocalCandidateTokenEncryptionKey({
      ...local,
      configuredKey: otherKey,
      adminClient: {
        query: async () =>
          assert.fail('Existing key should bypass the DB lookup'),
      },
    }),
    (error) => {
      assert.match(error.message, /does not match the protected local key/);
      assert.ok(!error.message.includes(storedKey));
      assert.ok(!error.message.includes(otherKey));
      return true;
    },
  );
  await assertProtectedKeyFile(keyPath(local), storedKey);
});

test('rejects an unsafe key-file mode without changing its contents', async (t) => {
  const local = await fixture(t);
  await loadOrCreateLocalCandidateTokenEncryptionKey({
    ...local,
    configuredKey: Buffer.alloc(32, 41).toString('base64'),
    adminClient: database(false),
  });
  const path = keyPath(local);
  const original = await readFile(path);
  await chmod(path, 0o644);

  await assert.rejects(
    loadOrCreateLocalCandidateTokenEncryptionKey({
      ...local,
      adminClient: {
        query: async () => assert.fail('Unsafe file must be rejected first'),
      },
    }),
    /unprotected/,
  );
  assert.ok(
    (await readFile(path)).equals(original),
    'Unsafe key file was modified',
  );
  assert.equal((await stat(path)).mode & 0o777, 0o644);
});

test('rejects a key-file symlink without changing its target', async (t) => {
  const local = await fixture(t);
  await mkdirSafeDirectory(local.dataDirectory);
  const target = join(local.dataRoot, 'do-not-overwrite');
  const targetContents = `${Buffer.alloc(32, 53).toString('base64')}\n`;
  await writeFile(target, targetContents, { mode: 0o600 });
  await symlink(target, keyPath(local));

  await assert.rejects(
    loadOrCreateLocalCandidateTokenEncryptionKey({
      ...local,
      adminClient: {
        query: async () => assert.fail('Symlink must be rejected first'),
      },
    }),
    /unsafe/,
  );
  assert.ok(
    (await readFile(target, 'utf8')) === targetContents,
    'Symlink target was modified',
  );
  assert.equal((await stat(target)).mode & 0o777, 0o600);
});

async function mkdirSafeDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}
