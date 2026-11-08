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
  clientIp?: string;
  userAgent?: string;
}

export interface EarlyAccessRecord extends EarlyAccessSubmissionInput {
  id: string;
  receivedAt: string;
}

// In-memory rate limiting map: ip -> array of timestamps
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_REQUESTS_PER_WINDOW = 5;

export function checkRateLimit(clientIp: string): {
  allowed: boolean;
  retryAfterSeconds?: number;
} {
  const now = Date.now();
  const timestamps = rateLimitMap.get(clientIp) || [];

  // Clean up older timestamps outside window
  const validTimestamps = timestamps.filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS,
  );

  if (validTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    const oldest = validTimestamps[0];
    const retryAfterSeconds = Math.ceil(
      (oldest + RATE_LIMIT_WINDOW_MS - now) / 1000,
    );
    return { allowed: false, retryAfterSeconds };
  }

  validTimestamps.push(now);
  rateLimitMap.set(clientIp, validTimestamps);
  return { allowed: true };
}

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
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const content = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(content) as EarlyAccessRecord[];
  } catch (error) {
    console.error('Failed to read early access store:', error);
    return [];
  }
}

export async function saveEarlyAccessRecord(
  input: EarlyAccessSubmissionInput,
): Promise<EarlyAccessRecord> {
  const filePath = getStoragePath();
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  const existing = await readAllEarlyAccessRecords();
  const record: EarlyAccessRecord = {
    ...input,
    id: randomUUID(),
    receivedAt: new Date().toISOString(),
  };

  const updated = [...existing, record];
  const tempPath = `${filePath}.${randomUUID()}.tmp`;

  await fs.promises.writeFile(
    tempPath,
    JSON.stringify(updated, null, 2),
    'utf8',
  );
  await fs.promises.rename(tempPath, filePath);

  return record;
}
