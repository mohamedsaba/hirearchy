import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const operatorDir = '/run/hirearchy/operator';
const storagePath =
  process.env.EARLY_ACCESS_STORAGE_PATH ??
  '/app/data/early-access-requests.json';
const syntheticEmail = process.env.SYNTHETIC_EMAIL ?? '';
const cliPath = fileURLToPath(
  new URL('./manage-early-access-requests.mjs', import.meta.url),
);

function runCli(args, targetStoragePath = storagePath) {
  return execFileSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, ...args],
    {
      cwd: '/app',
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        EARLY_ACCESS_STORAGE_PATH: targetStoragePath,
      },
      maxBuffer: 2 * 1024 * 1024,
    },
  ).trim();
}

function parseResult(output) {
  return JSON.parse(output);
}

async function assertPrivateFile(filePath) {
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
}

function assertRedacted(output) {
  assert.ok(!output.includes(syntheticEmail));
}

async function main() {
  assert.ok(syntheticEmail.includes('@example.test'));
  assert.equal((await stat(operatorDir)).mode & 0o777, 0o700);

  const initialExportPath = path.join(operatorDir, 'initial-export.json');
  const initialExportResult = runCli([
    'export',
    '--all',
    '--apply',
    '--output',
    initialExportPath,
  ]);
  assertRedacted(initialExportResult);
  assert.equal(parseResult(initialExportResult).operation, 'export');
  await assertPrivateFile(initialExportPath);

  const initialRecords = JSON.parse(await readFile(initialExportPath, 'utf8'));
  assert.ok(Array.isArray(initialRecords));
  const selected = initialRecords.find(
    (record) => record.email === syntheticEmail,
  );
  assert.ok(selected && typeof selected.id === 'string');

  const restoredStorePath = path.join(
    operatorDir,
    'restored-intake-store.json',
  );
  await copyFile(storagePath, restoredStorePath);
  await chmod(restoredStorePath, 0o600);
  await assertPrivateFile(restoredStorePath);

  const dryRun = runCli(['delete', '--id', selected.id]);
  assertRedacted(dryRun);
  const dryRunResult = parseResult(dryRun);
  assert.equal(dryRunResult.operation, 'delete');
  assert.equal(dryRunResult.matchedCount, 1);
  assert.equal(dryRunResult.mode, 'dry-run');

  const receiptPath = path.join(operatorDir, 'delete-receipt.json');
  const deleteResultText = runCli([
    'delete',
    '--id',
    selected.id,
    '--apply',
    '--receipt-out',
    receiptPath,
  ]);
  assertRedacted(deleteResultText);
  const deleteResult = parseResult(deleteResultText);
  assert.equal(deleteResult.operation, 'delete');
  assert.equal(deleteResult.deletedCount, 1);
  assert.equal(deleteResult.mode, 'applied');
  await assertPrivateFile(receiptPath);

  const receiptText = await readFile(receiptPath, 'utf8');
  assert.ok(receiptText.includes(selected.id));
  assert.ok(!receiptText.includes(syntheticEmail));

  const afterDeletePath = path.join(operatorDir, 'live-after-delete.json');
  const afterDeleteResult = runCli([
    'export',
    '--all',
    '--apply',
    '--output',
    afterDeletePath,
  ]);
  assertRedacted(afterDeleteResult);
  await assertPrivateFile(afterDeletePath);
  const liveAfterDelete = JSON.parse(await readFile(afterDeletePath, 'utf8'));
  assert.ok(!liveAfterDelete.some((record) => record.id === selected.id));

  const dryReplay = runCli(
    ['replay', '--receipt', receiptPath],
    restoredStorePath,
  );
  assertRedacted(dryReplay);
  const dryReplayResult = parseResult(dryReplay);
  assert.equal(dryReplayResult.operation, 'replay');
  assert.equal(dryReplayResult.mode, 'dry-run');
  assert.equal(dryReplayResult.matchedCount, 1);

  const replayResultText = runCli(
    ['replay', '--receipt', receiptPath, '--apply'],
    restoredStorePath,
  );
  assertRedacted(replayResultText);
  const replayResult = parseResult(replayResultText);
  assert.equal(replayResult.operation, 'replay');
  assert.equal(replayResult.mode, 'applied');
  assert.equal(replayResult.deletedCount, 1);

  const restoredExportPath = path.join(
    operatorDir,
    'restored-after-replay.json',
  );
  const restoredExportResult = runCli(
    ['export', '--all', '--apply', '--output', restoredExportPath],
    restoredStorePath,
  );
  assertRedacted(restoredExportResult);
  await assertPrivateFile(restoredExportPath);
  const restoredAfterReplay = JSON.parse(
    await readFile(restoredExportPath, 'utf8'),
  );
  assert.ok(!restoredAfterReplay.some((record) => record.id === selected.id));

  process.stdout.write(
    JSON.stringify({
      event: 'hirearchy.early_access_operator_recovery',
      state: 'passed',
      operations: 7,
      restoredCopyReplay: 'passed',
      privateFileMode: '0600',
      privateDirectoryMode: '0700',
    }) + '\n',
  );
}

try {
  await main();
} catch {
  console.error('Early-access operator recovery acceptance failed.');
  process.exitCode = 1;
}
