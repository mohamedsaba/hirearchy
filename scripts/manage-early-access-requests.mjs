import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  deleteEarlyAccessRecords,
  getStoragePath,
  selectEarlyAccessRecords,
  syncDirectory,
} from '../apps/web/src/early-access/store.ts';

const usage = `Usage:
  node --experimental-strip-types scripts/manage-early-access-requests.mjs export (--all | --id UUID | --before UTC) [--apply --output FILE]
  node --experimental-strip-types scripts/manage-early-access-requests.mjs delete (--id UUID | --before UTC) [--apply --receipt-out FILE]
  node --experimental-strip-types scripts/manage-early-access-requests.mjs replay --receipt FILE [--apply]

Without --apply, commands report counts only. Exports and receipts require a private directory outside the intake data volume.`;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function runEarlyAccessAdmin(args) {
  const [operation, ...rawOptions] = args;
  const options = parseOptions(rawOptions);

  if (options.help || operation === 'help' || !operation) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  if (operation === 'export') {
    return runExport(options);
  }
  if (operation === 'delete') {
    return runDelete(options);
  }
  if (operation === 'replay') {
    return runReplay(options);
  }
  throw new Error('Unknown operation.');
}

async function runExport(options) {
  assertOnlyOptions(options, ['all', 'id', 'before', 'apply', 'output']);
  const selection = parseSelection(options, true);
  const records = await selectEarlyAccessRecords(selection);
  if (!options.apply) {
    if (options.output) throw new Error('--output requires --apply.');
    report({
      ok: true,
      operation: 'export',
      mode: 'dry-run',
      selector: selection.kind,
      matchedCount: records.length,
    });
    return;
  }
  if (!options.output) throw new Error('Export apply requires --output.');
  const outputPath = await validatePrivateDestination(options.output);
  await assertOutsideIntakeVolume(outputPath, getStoragePath());
  await writeExclusiveJson(outputPath, records);
  report({
    ok: true,
    operation: 'export',
    mode: 'applied',
    selector: selection.kind,
    exportedCount: records.length,
    outputMode: '0600',
  });
}

async function runDelete(options) {
  assertOnlyOptions(options, ['id', 'before', 'apply', 'receiptOut']);
  const selection = parseSelection(options, false);
  if (!options.apply) {
    if (options.receiptOut) throw new Error('--receipt-out requires --apply.');
    const selected = await selectEarlyAccessRecords(selection);
    report({
      ok: true,
      operation: 'delete',
      mode: 'dry-run',
      selector: selection.kind,
      matchedCount: selected.length,
    });
    return;
  }
  const deletedIds = await deleteEarlyAccessRecords(selection, async (ids) => {
    if (!options.receiptOut) {
      throw new Error('Delete apply requires --receipt-out.');
    }
    const receiptPath = await validatePrivateDestination(options.receiptOut);
    await assertOutsideIntakeVolume(receiptPath, getStoragePath());
    await writeExclusiveJson(receiptPath, {
      version: 1,
      operation: 'delete',
      requestedAt: new Date().toISOString(),
      selector: selection.kind,
      affectedIds: ids,
    });
  });
  if (!deletedIds.length) {
    report({
      ok: true,
      operation: 'delete',
      mode: 'applied',
      selector: selection.kind,
      deletedCount: 0,
      result: 'no-op',
    });
    return;
  }

  report({
    ok: true,
    operation: 'delete',
    mode: 'applied',
    selector: selection.kind,
    deletedCount: deletedIds.length,
    receiptMode: '0600',
  });
}

async function runReplay(options) {
  assertOnlyOptions(options, ['receipt', 'apply']);
  if (!options.receipt) {
    throw new Error('Replay requires only --receipt.');
  }
  const receiptPath = path.resolve(options.receipt);
  await validateExistingPrivateFile(receiptPath);
  await assertOutsideIntakeVolume(receiptPath, getStoragePath());
  const receipt = await readReceipt(receiptPath);
  const selection = { kind: 'ids', ids: receipt.affectedIds };
  const records = await selectEarlyAccessRecords(selection);
  if (!options.apply) {
    report({
      ok: true,
      operation: 'replay',
      mode: 'dry-run',
      matchedCount: records.length,
    });
    return;
  }

  const deletedIds = await deleteEarlyAccessRecords(selection);
  report({
    ok: true,
    operation: 'replay',
    mode: 'applied',
    deletedCount: deletedIds.length,
    result: deletedIds.length ? 'applied' : 'no-op',
  });
}

function parseOptions(args) {
  const options = {};
  const values = new Set([
    '--id',
    '--before',
    '--output',
    '--receipt',
    '--receipt-out',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--apply' || flag === '--all' || flag === '--help') {
      const key = flag
        .slice(2)
        .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (options[key]) throw new Error('Option repeated.');
      options[key] = true;
      continue;
    }
    if (
      !values.has(flag) ||
      !args[index + 1] ||
      args[index + 1].startsWith('--')
    ) {
      throw new Error('Invalid command options.');
    }
    const key = flag
      .slice(2)
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (options[key]) throw new Error('Option repeated.');
    options[key] = args[index + 1];
    index += 1;
  }
  return options;
}

function parseSelection(options, allowAll) {
  const selected = [options.all, options.id, options.before].filter(Boolean);
  if (selected.length !== 1 || (options.all && !allowAll)) {
    throw new Error('Choose exactly one supported selector.');
  }
  if (options.all) return { kind: 'all' };
  if (options.id) {
    if (!uuidPattern.test(options.id)) throw new Error('--id must be a UUID.');
    return { kind: 'id', id: options.id };
  }
  return { kind: 'before', cutoff: parseUtc(options.before) };
}

function assertOnlyOptions(options, allowed) {
  if (Object.keys(options).some((key) => !allowed.includes(key))) {
    throw new Error('Option is not supported for this operation.');
  }
}

function parseUtc(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error('--before must be a canonical UTC timestamp ending in Z.');
  }
  return value;
}

async function validatePrivateDestination(filename) {
  const resolved = path.resolve(filename);
  const parent = await fs.realpath(path.dirname(resolved));
  const stats = await fs.stat(parent);
  if (!stats.isDirectory() || (stats.mode & 0o077) !== 0) {
    throw new Error(
      'Output directory must be private (mode 0700 or stricter).',
    );
  }
  try {
    await fs.lstat(resolved);
    throw new Error('Output file already exists.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return path.join(parent, path.basename(resolved));
}

async function validateExistingPrivateFile(filename) {
  const parent = await fs.realpath(path.dirname(filename));
  const directoryStats = await fs.stat(parent);
  const fileStats = await fs.lstat(filename);
  if (
    !directoryStats.isDirectory() ||
    (directoryStats.mode & 0o077) !== 0 ||
    !fileStats.isFile() ||
    (fileStats.mode & 0o077) !== 0
  ) {
    throw new Error('Receipt and directory must be private regular files.');
  }
}

async function assertOutsideIntakeVolume(outputPath, storagePath) {
  const storeDir = await fs.realpath(path.dirname(path.resolve(storagePath)));
  const outputDir = await fs.realpath(path.dirname(outputPath));
  const relative = path.relative(storeDir, outputDir);
  if (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`))
  ) {
    throw new Error('Output must be outside the intake data volume.');
  }
}

async function writeExclusiveJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    const written = handle;
    handle = undefined;
    await written.close();
    await fs.link(temporary, filename);
    await fs.unlink(temporary);
    await syncDirectory(path.dirname(filename));
  } catch (error) {
    await handle?.close();
    try {
      await fs.unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    }
    throw error;
  }
}

async function readReceipt(filename) {
  const stats = await fs.lstat(filename);
  if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
    throw new Error('Receipt must be a private regular file.');
  }
  const value = JSON.parse(await fs.readFile(filename, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Receipt is invalid.');
  }
  const keys = Object.keys(value).sort();
  const allowed = [
    'version',
    'operation',
    'requestedAt',
    'selector',
    'affectedIds',
  ].sort();
  if (
    !value ||
    typeof value !== 'object' ||
    keys.some((key) => !allowed.includes(key)) ||
    value.version !== 1 ||
    value.operation !== 'delete' ||
    !['id', 'before', 'ids'].includes(value.selector) ||
    typeof value.requestedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.requestedAt)) ||
    new Date(value.requestedAt).toISOString() !== value.requestedAt ||
    !Array.isArray(value.affectedIds) ||
    !value.affectedIds.length ||
    value.affectedIds.some(
      (id) => typeof id !== 'string' || !uuidPattern.test(id),
    ) ||
    new Set(value.affectedIds).size !== value.affectedIds.length
  ) {
    throw new Error('Receipt is invalid.');
  }
  return value;
}

function report(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  try {
    await runEarlyAccessAdmin(process.argv.slice(2));
  } catch (error) {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code)
        ? error.code
        : 'EARLY_ACCESS_OPERATION_FAILED';
    process.stderr.write(
      `${JSON.stringify({ ok: false, code, error: 'Early-access operation failed.' })}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
