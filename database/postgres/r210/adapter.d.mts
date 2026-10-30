export function installR210ReviewPacketFixture(clientOrPool: {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}): Promise<void>;
