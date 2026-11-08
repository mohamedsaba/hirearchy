import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
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

let saveQueue = Promise.resolve();

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
  return records as EarlyAccessRecord[];
}

export function saveEarlyAccessRecord(
  input: EarlyAccessSubmissionInput,
): Promise<EarlyAccessRecord> {
  const save = saveQueue.then(async () => {
    const filePath = getStoragePath();
    const dir = path.dirname(filePath);

    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await fs.promises.chmod(filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const existing = await readAllEarlyAccessRecords();
    const record: EarlyAccessRecord = {
      ...input,
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
    };

    const updated = [...existing, record];
    const tempPath = `${filePath}.${randomUUID()}.tmp`;

    await fs.promises.writeFile(tempPath, JSON.stringify(updated, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.promises.rename(tempPath, filePath);

    return record;
  });
  // shortcut: serialized only in this Node process; use transactional storage before sharing the file across app replicas.
  saveQueue = save.then(
    () => undefined,
    () => undefined,
  );
  return save;
}
