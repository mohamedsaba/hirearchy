import { readAllEarlyAccessRecords } from '../apps/web/src/early-access/store.ts';

try {
  process.stdout.write(
    `${JSON.stringify(await readAllEarlyAccessRecords(), null, 2)}\n`,
  );
} catch {
  console.error(
    'Unable to read early-access requests. Check the configured store and file integrity.',
  );
  process.exitCode = 1;
}
