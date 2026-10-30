import { readFileSync } from 'node:fs';

export async function installR29ObservationFixture(clientOrPool) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL fixture client is required');
  }
  await clientOrPool.query(
    readFileSync(new URL('./fixture.sql', import.meta.url), 'utf8'),
  );
}
