import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

import {
  assertCandidateTokenStorage,
  loadCandidateTokenEncryptionKey,
  verifyCandidateTokenStorageRows,
} from './sessions/candidate-token-storage.mjs';
import { getApplicationDatabasePath } from './database/database-path';
import { DockerSandboxAdapter } from './sandbox/docker-sandbox-adapter';
import { scenario001 } from './scenarios/scenario-001';
import { scenario002 } from './scenarios/scenario-002-booking-notification-retry';
import { getApplicationStartupStatus } from './startup-status';

type Check = 'ready' | 'not_ready' | 'not_checked' | 'pending';

const checkDocker = async () => {
  const adapter = new DockerSandboxAdapter();
  try {
    const info = await adapter.runProcess(
      'docker',
      ['info', '--format', '{{.ServerVersion}}'],
      { timeoutMs: 5_000, maxStdoutBytes: 512, maxStderrBytes: 512 },
    );
    if (info.exitCode !== 0 || !info.stdout.trim()) {
      return {
        docker: 'not_ready' as const,
        images: {
          scenario001: 'not_checked' as const,
          scenario002: 'not_checked' as const,
        },
      };
    }
  } catch {
    return {
      docker: 'not_ready' as const,
      images: {
        scenario001: 'not_checked' as const,
        scenario002: 'not_checked' as const,
      },
    };
  }

  const inspectImage = async (image: string): Promise<Check> => {
    try {
      const result = await adapter.runProcess(
        'docker',
        ['image', 'inspect', image, '--format', '{{.Id}}'],
        { timeoutMs: 5_000, maxStdoutBytes: 512, maxStderrBytes: 512 },
      );
      return result.exitCode === 0 && result.stdout.trim()
        ? 'ready'
        : 'not_ready';
    } catch {
      return 'not_ready';
    }
  };

  const [scenario001Status, scenario002Status] = await Promise.all([
    inspectImage(scenario001.imageName ?? 'hirearchy-scenario-001:latest'),
    inspectImage(scenario002.imageName ?? 'hirearchy-scenario-002:v1.0.0'),
  ]);
  return {
    docker: 'ready' as const,
    images: {
      scenario001: scenario001Status,
      scenario002: scenario002Status,
    },
  };
};

const checkDatabase = (key: Buffer | null) => {
  const databasePath = getApplicationDatabasePath();
  if (databasePath === ':memory:' || !existsSync(databasePath)) {
    return {
      database: 'not_ready' as const,
      schema: 'not_checked' as const,
      keyAssociation: 'not_checked' as const,
    };
  }

  let database: Database.Database;
  try {
    database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
  } catch {
    return {
      database: 'not_ready' as const,
      schema: 'not_checked' as const,
      keyAssociation: 'not_checked' as const,
    };
  }

  try {
    database.pragma('query_only = ON');
    const integrity = database.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') {
      return {
        database: 'not_ready' as const,
        schema: 'not_checked' as const,
        keyAssociation: 'not_checked' as const,
      };
    }
    if (!key) {
      return {
        database: 'ready' as const,
        schema: 'not_checked' as const,
        keyAssociation: 'not_checked' as const,
      };
    }
    let keyAssociation: Check = 'not_ready';
    try {
      assertCandidateTokenStorage(database, { key });
      keyAssociation = 'ready';
    } catch {
      return {
        database: 'ready' as const,
        schema: 'not_checked' as const,
        keyAssociation,
      };
    }

    try {
      const columns = new Set(
        (
          database
            .prepare('PRAGMA table_info(assessment_sessions)')
            .all() as Array<{ name: string }>
        ).map((column) => column.name),
      );
      const requiredColumns = [
        'id',
        'candidate_token_hash',
        'candidate_token',
        'candidate_token_ciphertext',
        'issuance_key',
        'issuance_request_hash',
        'issuance_payload_hash',
      ];
      const issuanceIndex = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'assessment_sessions_issuance_key_unique'",
        )
        .get();
      const indexList = database.pragma(
        'index_list(assessment_sessions)',
      ) as Array<{ name: string; unique: number; partial: number }>;
      const indexInfo = database.pragma(
        'index_info(assessment_sessions_issuance_key_unique)',
      ) as Array<{ name: string | null }>;
      if (
        requiredColumns.some((column) => !columns.has(column)) ||
        !issuanceIndex ||
        !indexList.some(
          (index) =>
            index.name === 'assessment_sessions_issuance_key_unique' &&
            index.unique === 1 &&
            index.partial === 1,
        ) ||
        indexInfo.length !== 1 ||
        indexInfo[0].name !== 'issuance_key'
      ) {
        return {
          database: 'ready' as const,
          schema: 'not_ready' as const,
          keyAssociation,
        };
      }
      try {
        verifyCandidateTokenStorageRows(database, key);
      } catch {
        return {
          database: 'ready' as const,
          schema: 'not_ready' as const,
          keyAssociation: 'not_ready' as const,
        };
      }
      return {
        database: 'ready' as const,
        schema: 'ready' as const,
        keyAssociation,
      };
    } catch {
      return {
        database: 'ready' as const,
        schema: 'not_ready' as const,
        keyAssociation,
      };
    }
  } catch {
    return {
      database: 'not_ready' as const,
      schema: 'not_checked' as const,
      keyAssociation: 'not_checked' as const,
    };
  } finally {
    database.close();
  }
};

export const inspectApplicationReadiness = async () => {
  const startup = getApplicationStartupStatus();
  let key: Buffer | null = null;
  try {
    key = loadCandidateTokenEncryptionKey();
  } catch {
    // The external check reports only a bounded status, never key details.
  }
  const database = checkDatabase(key);
  const docker = await checkDocker();
  const reconciliation: Check =
    startup.state === 'ready'
      ? 'ready'
      : startup.state === 'failed' && startup.failure === 'reconciliation'
        ? 'not_ready'
        : startup.state === 'pending'
          ? 'pending'
          : 'not_checked';
  const checks = {
    startup: startup.state,
    keyConfiguration: key ? 'ready' : 'not_ready',
    ...database,
    ...docker,
    reconciliation,
    provisioning: 'not_checked' as const,
    ai: 'not_checked' as const,
  };
  const ready =
    checks.startup === 'ready' &&
    checks.keyConfiguration === 'ready' &&
    checks.database === 'ready' &&
    checks.schema === 'ready' &&
    checks.keyAssociation === 'ready' &&
    checks.docker === 'ready' &&
    checks.reconciliation === 'ready' &&
    Object.values(checks.images).every((status) => status === 'ready');
  return {
    service: 'hirearchy-web',
    status: ready ? 'ready' : 'not_ready',
    checks,
  } as const;
};
