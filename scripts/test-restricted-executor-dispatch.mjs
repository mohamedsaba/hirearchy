// Run the standalone dispatch acceptance suite with: node scripts/test-restricted-executor-dispatch.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testFile = fileURLToPath(
  new URL('../tests/restricted-executor/dispatch.test.mjs', import.meta.url),
);
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
