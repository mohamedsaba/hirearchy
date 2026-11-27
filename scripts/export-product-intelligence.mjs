import { Client } from 'pg';

function parseArg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const days = Math.max(
  1,
  Math.min(3650, Math.trunc(Number(parseArg('--days', '30')) || 30)),
);
const format = parseArg('--format', 'json') === 'csv' ? 'csv' : 'json';
const databaseUrl = process.env.STAGING_DATABASE_URL?.trim();

if (!databaseUrl) {
  console.error('STAGING_DATABASE_URL is required to export intelligence.');
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  const res = await client.query(
    'SELECT staging.telemetry_insights_report($1::pg_catalog.int4) AS report',
    [days],
  );
  const report = res.rows[0]?.report;
  if (!report) {
    console.error('No intelligence report returned.');
    process.exit(1);
  }
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const csvCell = (val) => {
      const s = val === null || val === undefined ? '' : String(val);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [['section', 'metric', 'dimension', 'value', 'extra']];
    for (const [k, v] of Object.entries(report.marketingProof ?? {})) {
      rows.push(['marketing_proof', k, '', v, '']);
    }
    for (const [k, v] of Object.entries(report.hiringFunnel ?? {})) {
      rows.push(['hiring_funnel', k, '', v, '']);
    }
    for (const item of report.assessmentHealth ?? []) {
      rows.push([
        'assessment_health',
        item.title,
        `${item.sourceKind}:${item.targetRole}`,
        `${item.completionRatePct}%`,
        `issued=${item.issued};submitted=${item.submitted};flag=${item.healthFlag}`,
      ]);
    }
    process.stdout.write(
      `${rows.map((r) => r.map(csvCell).join(',')).join('\n')}\n`,
    );
  }
} finally {
  await client.end().catch(() => {});
}
