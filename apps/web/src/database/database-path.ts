import path from 'node:path';
import { existsSync } from 'node:fs';

let warnedAboutMissingLegacyDatabase = false;

export const getApplicationDatabasePath = () => {
  if (process.env.HIREARCHY_DB_PATH) return process.env.HIREARCHY_DB_PATH;
  const legacyPath = process.env.DELIMIT_DB_PATH;
  if (legacyPath && existsSync(path.resolve(legacyPath))) return legacyPath;
  if (legacyPath && !warnedAboutMissingLegacyDatabase) {
    console.warn(
      'DELIMIT_DB_PATH is configured but its target is missing; retaining the existing Hirearchy database path.',
    );
    warnedAboutMissingLegacyDatabase = true;
  }
  return path.join(process.cwd(), '.data/hirearchy.sqlite');
};
