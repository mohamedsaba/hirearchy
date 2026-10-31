import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';

export async function captureRelease(artifact) {
  const archive = new URL('application-release.tgz', artifact);
  execFileSync('tar', [
    '--dereference',
    '--exclude=.next/cache',
    '--exclude=.next/dev',
    '-czf',
    archive.pathname,
    '-C',
    new URL('../../apps/web/', import.meta.url).pathname,
    '.next',
    'next.config.ts',
  ]);
  const manifest = {
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    buildId: (
      await readFile(
        new URL('../../apps/web/.next/BUILD_ID', import.meta.url),
        'utf8',
      )
    ).trim(),
    archiveSha256: createHash('sha256')
      .update(await readFile(archive))
      .digest('hex'),
    lockfileSha256: createHash('sha256')
      .update(
        await readFile(new URL('../../package-lock.json', import.meta.url)),
      )
      .digest('hex'),
  };
  await writeFile(
    new URL('release-manifest.json', artifact),
    JSON.stringify(manifest, null, 2),
  );
  return async (name, broken = false) => {
    assert.equal(
      createHash('sha256')
        .update(await readFile(archive))
        .digest('hex'),
      manifest.archiveSha256,
      'Retained release archive integrity',
    );
    const directory = new URL(`${name}/`, artifact);
    await mkdir(directory, { mode: 0o700 });
    execFileSync('tar', ['-xzf', archive.pathname, '-C', directory.pathname]);
    await symlink(
      new URL('../../node_modules/', import.meta.url).pathname,
      new URL('node_modules', directory),
    );
    await writeFile(
      new URL('package.json', directory),
      JSON.stringify({ private: true }),
    );
    if (broken) {
      await rm(new URL('.next/BUILD_ID', directory));
      const result = spawnSync(
        process.execPath,
        [
          new URL('../../node_modules/next/dist/bin/next', import.meta.url)
            .pathname,
          'start',
          directory.pathname,
          '-H',
          '127.0.0.1',
          '-p',
          '0',
        ],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: {
            ...process.env,
            HIREARCHY_RUNTIME_PROFILE: 'staging-authenticated',
          },
        },
      );
      assert.equal(result.status, 1, 'Corrupt release must fail startup');
      assert.match(result.stderr, /production build|BUILD_ID/);
      await writeFile(new URL('failed-release.txt', artifact), result.stderr, {
        mode: 0o600,
      });
    }
    return directory.pathname;
  };
}
