import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export interface EarlyAccessSubmissionInput {
  name: string;
  email: string;
  company: string;
  teamSize: '1-10' | '11-50' | '51-200' | '201+';
  role: string;
  primaryChallenge:
    | 'leetcode_fatigue'
    | 'ai_authenticity_uncertainty'
    | 'evaluator_time_cost'
    | 'unrealistic_assessments'
    | 'other';
  notes?: string;
}

export interface EarlyAccessRecord extends EarlyAccessSubmissionInput {
  id: string;
  receivedAt: string;
}

const lockWaitMs = 2_000;
let mutationQueue = Promise.resolve();

export type EarlyAccessSelection =
  | { kind: 'all' }
  | { kind: 'id'; id: string }
  | { kind: 'before'; cutoff: string }
  | { kind: 'ids'; ids: string[] };

export function getStoragePath(): string {
  if (process.env.EARLY_ACCESS_STORAGE_PATH) {
    return process.env.EARLY_ACCESS_STORAGE_PATH;
  }
  return path.join(process.cwd(), '.data/early-access-requests.json');
}

export async function readAllEarlyAccessRecords(): Promise<
  EarlyAccessRecord[]
> {
  const filePath = getStoragePath();
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: unknown = JSON.parse(content);
  if (!Array.isArray(records)) {
    throw new TypeError('Early-access store must contain a JSON array');
  }
  const ids = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (!isEarlyAccessRecord(record) || ids.has(record.id)) {
      throw new TypeError(
        `Early-access store contains an invalid record at index ${index}`,
      );
    }
    ids.add(record.id);
  }
  return records;
}

export function saveEarlyAccessRecord(
  input: EarlyAccessSubmissionInput,
): Promise<EarlyAccessRecord> {
  return serializeMutation(async () => {
    const filePath = getStoragePath();
    const dir = path.dirname(filePath);

    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    return withStoreLock(filePath, async () => {
      await chmodStoreIfPresent(filePath);
      const existing = await readAllEarlyAccessRecords();
      const record: EarlyAccessRecord = {
        ...input,
        id: randomUUID(),
        receivedAt: new Date().toISOString(),
      };

      await writeRecords(filePath, [...existing, record]);
      return record;
    });
  });
}

export async function selectEarlyAccessRecords(
  selection: EarlyAccessSelection,
): Promise<EarlyAccessRecord[]> {
  return matchingRecords(await readAllEarlyAccessRecords(), selection);
}

export function deleteEarlyAccessRecords(
  selection: Exclude<EarlyAccessSelection, { kind: 'all' }>,
  beforeReplace?: (ids: string[]) => Promise<void>,
): Promise<string[]> {
  return serializeMutation(async () => {
    const filePath = getStoragePath();
    await fs.promises.mkdir(path.dirname(filePath), {
      recursive: true,
      mode: 0o700,
    });
    return withStoreLock(filePath, async () => {
      await chmodStoreIfPresent(filePath);
      const existing = await readAllEarlyAccessRecords();
      const matched = matchingRecords(existing, selection);
      const ids = matched.map(({ id }) => id);
      if (!ids.length) return ids;
      await beforeReplace?.(ids);
      const deletedIds = new Set(ids);
      await writeRecords(
        filePath,
        existing.filter((record) => !deletedIds.has(record.id)),
      );
      return ids;
    });
  });
}

function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function withStoreLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  // shortcut: the lock coordinates writers on one shared filesystem; use transactional storage for multi-host deployments.
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + lockWaitMs;
  let handle: FileHandle;
  while (true) {
    try {
      handle = await fs.promises.open(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        const locked = new Error('Early-access store lock is unavailable');
        Object.assign(locked, { code: 'ELOCKED' });
        throw locked;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    return await operation();
  } finally {
    let opened: Awaited<ReturnType<FileHandle['stat']>>;
    try {
      opened = await handle.stat();
    } finally {
      await handle.close();
    }
    try {
      const current = await fs.promises.stat(lockPath);
      if (opened.dev !== current.dev || opened.ino !== current.ino) {
        const lost = new Error('Early-access store lock ownership changed');
        Object.assign(lost, { code: 'ELOCKLOST' });
        throw lost;
      }
      await fs.promises.unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const lost = new Error('Early-access store lock was removed');
        Object.assign(lost, { code: 'ELOCKLOST' });
        throw lost;
      }
      throw error;
    }
  }
}

async function chmodStoreIfPresent(filePath: string): Promise<void> {
  try {
    await fs.promises.chmod(filePath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function writeRecords(
  filePath: string,
  records: EarlyAccessRecord[],
): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await fs.promises.open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(records, null, 2)}\n`, 'utf8');
    await handle.sync();
    const written = handle;
    handle = undefined;
    await written.close();
    await fs.promises.rename(tempPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await handle?.close();
    try {
      await fs.promises.unlink(tempPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw cleanupError;
      }
    }
    throw error;
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function matchingRecords(
  records: EarlyAccessRecord[],
  selection: EarlyAccessSelection,
): EarlyAccessRecord[] {
  if (selection.kind === 'all') return records;
  if (selection.kind === 'id') {
    return records.filter((record) => record.id === selection.id);
  }
  if (selection.kind === 'ids') {
    const ids = new Set(selection.ids);
    return records.filter((record) => ids.has(record.id));
  }
  return records.filter((record) => record.receivedAt < selection.cutoff);
}

function isEarlyAccessRecord(value: unknown): value is EarlyAccessRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const challenges = [
    'leetcode_fatigue',
    'ai_authenticity_uncertainty',
    'evaluator_time_cost',
    'unrealistic_assessments',
    'other',
  ];
  const teamSizes = ['1-10', '11-50', '51-200', '201+'];
  const receivedAt = record.receivedAt;
  return (
    typeof record.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record.id,
    ) &&
    typeof receivedAt === 'string' &&
    Number.isFinite(Date.parse(receivedAt)) &&
    new Date(receivedAt).toISOString() === receivedAt &&
    typeof record.name === 'string' &&
    typeof record.email === 'string' &&
    typeof record.company === 'string' &&
    typeof record.role === 'string' &&
    teamSizes.includes(String(record.teamSize)) &&
    challenges.includes(String(record.primaryChallenge)) &&
    (record.notes === undefined || typeof record.notes === 'string')
  );
}
