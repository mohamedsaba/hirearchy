import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type DatabaseInitializer = (
  database: Database.Database,
  allowNewDatabase: boolean,
) => void;

export class SqliteTransactionRunner {
  private readonly initializers: DatabaseInitializer[] = [];

  constructor(private readonly databasePath: string) {}

  registerInitializer(initializer: DatabaseInitializer): void {
    this.initializers.push(initializer);
  }

  run<T>(operation: (database: Database.Database) => T): T {
    const allowNewDatabase =
      this.databasePath === ':memory:' || !existsSync(this.databasePath);
    if (this.databasePath !== ':memory:') {
      mkdirSync(path.dirname(this.databasePath), { recursive: true });
    }

    const database = new Database(this.databasePath);
    database.pragma('busy_timeout = 5000');

    try {
      for (const init of this.initializers) {
        init(database, allowNewDatabase);
      }
      database.pragma('journal_mode = WAL');
      const transaction = database.transaction(() => operation(database));
      return transaction.immediate();
    } finally {
      database.close();
    }
  }

  /**
   * Run an operation with a provided database instance or create a new transaction if none provided.
   */
  runWith<T>(
    database: Database.Database | undefined,
    operation: (database: Database.Database) => T,
  ): T {
    if (database) {
      return operation(database);
    }
    return this.run(operation);
  }
}
