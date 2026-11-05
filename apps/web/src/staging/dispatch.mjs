import { Pool } from 'pg';

let pool;
let configuredUrl;

export async function dispatchStagingProof(
  connectionString,
  payload,
  signature,
) {
  if (!pool) {
    configuredUrl = connectionString;
    pool = new Pool({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
      statement_timeout: 5000,
    });
  }
  if (configuredUrl !== connectionString)
    throw new Error('Staging database configuration changed');
  const result = await pool.query(
    'SELECT staging.dispatch($1::bytea, $2::bytea) AS result',
    [payload, signature],
  );
  if (result.rows.length !== 1) throw new Error('Staging dispatch unavailable');
  return result.rows[0].result;
}
