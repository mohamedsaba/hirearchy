import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  APPROVED_BROWSER_EVIDENCE_FILES,
  CANDIDATE_INVITATION_MASK_SELECTOR,
  assertBrowserEvidenceDirectory,
  assertNoSensitiveScreenshotContent,
  prepareBrowserEvidenceDirectory,
} from './browser-evidence-privacy.mjs';

const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function surface({ text = '', fields = [], urls = [] } = {}) {
  return {
    text,
    fields: fields.map(({ value, maskSelector = null }) => ({
      value,
      maskSelector,
    })),
    urls: urls.map(({ value, maskSelector = null }) => ({
      value,
      maskSelector,
    })),
  };
}

function assertFixedError(run, expectedMessage) {
  assert.throws(run, (error) => {
    assert.equal(error.message, expectedMessage);
    return true;
  });
}

async function assertFixedRejection(run, expectedMessage) {
  await assert.rejects(run, (error) => {
    assert.equal(error.message, expectedMessage);
    return true;
  });
}

async function withEvidenceDirectory(run) {
  const root = await mkdtemp(join(tmpdir(), 'hirearchy-browser-evidence-'));
  const directory = join(root, 'browser-evidence');
  await mkdir(directory);
  try {
    await run(directory, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeApprovedFiles(directory) {
  await Promise.all(
    APPROVED_BROWSER_EVIDENCE_FILES.map((name) =>
      writeFile(
        join(directory, name),
        Buffer.concat([pngSignature, Buffer.alloc(8)]),
      ),
    ),
  );
}

test('rejects fixture passwords, app secrets, and cookies without echoing values', () => {
  const secrets = [
    'synthetic-fixture-password-very-long',
    'synthetic-postgres-password-very-long',
    'synthetic-session-cookie-very-long',
  ];
  const expected = 'Screenshot privacy inspection found a protected value.';
  for (const secret of secrets) {
    assertFixedError(
      () =>
        assertNoSensitiveScreenshotContent(
          surface({
            text: `Synthetic reviewer observation ${secret}`,
            fields: [{ value: `hidden visible field ${secret}` }],
            urls: [{ value: `https://staging.test/${secret}` }],
          }),
          { protectedValues: [secret] },
        ),
      expected,
    );
  }

  assertFixedError(
    () =>
      assertNoSensitiveScreenshotContent(
        surface({
          fields: [
            {
              value: secrets[0],
              maskSelector: CANDIDATE_INVITATION_MASK_SELECTOR,
            },
          ],
        }),
        {
          protectedValues: [secrets[0]],
          maskSelectors: [CANDIDATE_INVITATION_MASK_SELECTOR],
        },
      ),
    expected,
  );
});

test('allows the candidate bearer only in the exact approved masked field and URL', () => {
  const bearer = 'synthetic-candidate-invitation-bearer';
  const invitationUrl = `https://staging.test/r26/candidate/sess_synthetic#${bearer}`;
  assert.doesNotThrow(() =>
    assertNoSensitiveScreenshotContent(
      surface({
        fields: [
          {
            value: invitationUrl,
            maskSelector: CANDIDATE_INVITATION_MASK_SELECTOR,
          },
        ],
        urls: [
          {
            value: invitationUrl,
            maskSelector: CANDIDATE_INVITATION_MASK_SELECTOR,
          },
        ],
      }),
      {
        maskableValues: [bearer, invitationUrl],
        maskSelectors: [CANDIDATE_INVITATION_MASK_SELECTOR],
      },
    ),
  );

  assert.doesNotThrow(() =>
    assertNoSensitiveScreenshotContent(surface(), {
      maskableValues: [bearer, invitationUrl],
      maskSelectors: [CANDIDATE_INVITATION_MASK_SELECTOR],
    }),
  );

  assertFixedError(
    () =>
      assertNoSensitiveScreenshotContent(
        surface({
          urls: [{ value: invitationUrl }],
        }),
        {
          maskableValues: [bearer, invitationUrl],
          maskSelectors: [CANDIDATE_INVITATION_MASK_SELECTOR],
        },
      ),
    'Screenshot privacy inspection found an unmasked invitation value.',
  );
});

test('rejects unknown unmasked fields and unapproved masks with fixed diagnostics', () => {
  const bearer = 'synthetic-candidate-invitation-bearer';
  assertFixedError(
    () =>
      assertNoSensitiveScreenshotContent(
        surface({ fields: [{ value: bearer }] }),
        { maskableValues: [bearer] },
      ),
    'Screenshot privacy inspection found an unmasked invitation value.',
  );
  assertFixedError(
    () =>
      assertNoSensitiveScreenshotContent(surface(), {
        maskSelectors: ['input[name="candidate-token"]'],
      }),
    'Screenshot privacy inspection received an unapproved mask.',
  );
});

test('rejects private keys, database URLs, and auth recovery credentials', () => {
  const unsafeSurfaces = [
    '-----BEGIN PRIVATE KEY-----\nsynthetic-key-material',
    'postgresql://synthetic-user:synthetic-password@db.invalid/app',
    'https://staging.test/r23/auth/recovery?code=synthetic-recovery-code',
    'https://staging.test/callback?refresh_token=synthetic-refresh-value',
    'https://staging.test/callback#access_token=synthetic-access-value',
  ];
  for (const value of unsafeSurfaces) {
    assertFixedError(
      () => assertNoSensitiveScreenshotContent(surface({ text: value })),
      'Screenshot privacy inspection found credential-like content.',
    );
  }
});

test('accepts exactly the approved eight regular PNG files', async () => {
  await withEvidenceDirectory(async (directory) => {
    await writeApprovedFiles(directory);
    await assertBrowserEvidenceDirectory(directory);
  });
});

test('rejects missing or extra screenshot files', async () => {
  await withEvidenceDirectory(async (directory) => {
    await writeApprovedFiles(directory);
    await unlink(join(directory, APPROVED_BROWSER_EVIDENCE_FILES[7]));
    await assertFixedRejection(
      () => assertBrowserEvidenceDirectory(directory),
      'Browser evidence directory does not contain exactly eight approved PNGs.',
    );
    await writeFile(
      join(directory, APPROVED_BROWSER_EVIDENCE_FILES[7]),
      Buffer.concat([pngSignature, Buffer.alloc(8)]),
    );
    await writeFile(join(directory, 'unexpected.txt'), 'synthetic');
    await assertFixedRejection(
      () => assertBrowserEvidenceDirectory(directory),
      'Browser evidence directory does not contain exactly eight approved PNGs.',
    );
  });
});

test('rejects screenshot symlinks and files without PNG signatures', async () => {
  await withEvidenceDirectory(async (directory, root) => {
    await writeApprovedFiles(directory);
    const firstFile = join(directory, APPROVED_BROWSER_EVIDENCE_FILES[0]);
    const replacement = join(root, 'replacement.png');
    await writeFile(
      replacement,
      Buffer.concat([pngSignature, Buffer.alloc(8)]),
    );
    await unlink(firstFile);
    await symlink(replacement, firstFile);
    await assertFixedRejection(
      () => assertBrowserEvidenceDirectory(directory),
      'Browser evidence must contain regular PNG files only.',
    );
    await unlink(firstFile);
    await writeFile(firstFile, 'not a PNG');
    await unlink(replacement);
    await assertFixedRejection(
      () => assertBrowserEvidenceDirectory(directory),
      'Browser evidence contains a file without a PNG signature.',
    );
  });
});

test('rejects a symlinked evidence directory without changing its target mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hirearchy-browser-evidence-'));
  const target = join(root, 'target');
  const link = join(root, 'browser-evidence');
  await mkdir(target);
  await chmod(target, 0o755);
  await symlink(target, link);
  try {
    await assertFixedRejection(
      () => prepareBrowserEvidenceDirectory(link),
      'Browser evidence directory is not a regular directory.',
    );
    assert.equal((await stat(target)).mode & 0o777, 0o755);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
