import { runEarlyAccessAdmin } from './manage-early-access-requests.mjs';

try {
  await runEarlyAccessAdmin(['export', ...process.argv.slice(2)]);
} catch (error) {
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code)
      ? error.code
      : 'EARLY_ACCESS_EXPORT_FAILED';
  process.stderr.write(
    `${JSON.stringify({ ok: false, code, error: 'Early-access export failed; request fields were not written to stdout.' })}\n`,
  );
  process.exitCode = 1;
}
