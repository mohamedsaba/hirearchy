import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const testFile = fileURLToPath(
  new URL('../tests/restricted-executor/acceptance.test.mjs', import.meta.url),
);
const requiredTestTitles = [
  'fixed recipe argument arrays are immutable',
  'canonical snapshots are order-independent and reject path escapes and duplicates',
  'PostgreSQL-only simulation: invalid, expired, and tampered admission fails before reservation',
  'PostgreSQL-only simulation: lock-holding session durability is checked independently of readiness',
  'PostgreSQL-only simulation: readiness binds role identity and effective privilege boundaries',
  'PostgreSQL-only simulation: runtime role and schema deny elevated access',
  'PostgreSQL-only simulation: readiness rejects altered or disabled guards and dangerous grants',
  'PostgreSQL-only simulation: prepared to creating to created persists and replays after process restart',
  'PostgreSQL-only simulation: duplicate admission from another process is fenced by advisory locks',
  'PostgreSQL-only simulation: changed intent conflicts and higher fences require completion',
  'PostgreSQL-only simulation: a dead owner stays UNKNOWN until reconciliation',
  'PostgreSQL-only simulation: service restart preserves active, UNKNOWN, and complete records',
  'PostgreSQL-only simulation: outages before reservation and before receipt fail closed',
  'real Docker execution is bounded, credential-free, and replays after service and process restart',
  'real Docker execution admits one concurrent request across executor processes',
  'real Docker nonzero result replays truthfully and rejects a stale fence',
  'real Docker timeout produces a durable failed receipt and does not rerun',
  'real Docker OOM remains bounded and reports only observed resource attribution',
  'real Docker stdout and stderr stay within the shared output byte budget',
  'real Docker work holds admission through a long bounded run',
  'real Docker startup failure is persisted as a setup failure and replayed',
  'real Docker client config cleanup failure stays UNKNOWN and never replays as success',
  'temporary Docker CLI unavailability during cleanup preserves UNKNOWN until reconciliation',
  'real Docker remove failure persists UNKNOWN until verified reconciliation',
  'real Docker ownership mismatch remains untouched during cleanup and reconciliation',
  'a process crash after ambiguous Docker create reconciles only the exact owned container',
  'a Docker create that arrives late remains UNKNOWN until exact owned cleanup',
  'database loss during a real running workload leaves UNKNOWN and blocks redispatch',
];
const acceptanceSource = await readFile(testFile, 'utf8');
const declaredTestTitles = new Set(
  [...acceptanceSource.matchAll(/\btest\(\s*(['"])(.*?)\1\s*,/g)].map(
    (match) => match[2],
  ),
);
const missingTestTitles = requiredTestTitles.filter(
  (title) => !declaredTestTitles.has(title),
);
if (missingTestTitles.length > 0) {
  process.stderr.write(
    `Missing required restricted executor acceptance case(s): ${missingTestTitles.join('; ')}\n`,
  );
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ['--test', '--test-concurrency=1', testFile],
  { stdio: 'inherit' },
);
child.once('error', () => {
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
