export function installR29ObservationFixture(clientOrPool: {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}): Promise<void>;
