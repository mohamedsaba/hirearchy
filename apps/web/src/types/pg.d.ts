declare module 'pg' {
  export interface QueryResult<R = Record<string, unknown>> {
    rows: R[];
    rowCount: number | null;
  }
  export interface PoolClient {
    query<R = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>>;
    release(): void;
  }
  export class Pool {
    constructor(config?: Record<string, unknown>);
    connect(): Promise<PoolClient>;
    query<R = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }
  export class Client {
    constructor(config?: Record<string, unknown>);
    connect(): Promise<void>;
    query<R = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }
}
