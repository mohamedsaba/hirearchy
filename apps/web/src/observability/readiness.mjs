import { Client } from 'pg';
import { operationalLogger, sanitizeError } from './logger.mjs';

const TARGET_MIGRATION_VERSION = '0017';

export async function checkOperationalReadiness(databaseUrlOverride) {
  const timestamp = new Date().toISOString();
  const selfServiceEnabled =
    process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED === 'true';

  const defaultCapabilities = {
    liveCodeExecutionEnabled: false,
    liveAiAssistanceEnabled: false,
    emailDeliveryEnabled: false,
    selfServiceOnboardingEnabled: selfServiceEnabled,
    managedSupabaseSupported: false,
  };

  const databaseUrl = databaseUrlOverride || process.env.STAGING_DATABASE_URL;

  if (!databaseUrl) {
    return {
      service: 'hirearchy-staging',
      status: 'not_ready',
      timestamp,
      database: {
        connected: false,
        migrationVersion: null,
        targetMigrationVersion: TARGET_MIGRATION_VERSION,
        isMigrationCurrent: false,
        markers: {
          candidateLifecycle: false,
          onboarding: false,
          candidateTokenStorage: false,
          authoringR211: false,
          executionR214: false,
        },
        error: 'Database URL configuration unavailable',
      },
      capabilities: defaultCapabilities,
    };
  }

  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3000,
  });

  try {
    await client.connect();

    // 1. Basic connectivity
    await client.query('SELECT 1');

    // 2. Query schema migrations
    let migrationVersion = null;
    try {
      const migrationRes = await client.query(
        'SELECT version FROM hirearchy.schema_migrations ORDER BY version DESC LIMIT 1',
      );
      if (migrationRes.rows.length > 0) {
        migrationVersion = migrationRes.rows[0].version;
      }
    } catch {
      migrationVersion = null;
    }

    // 3. Query durable installation markers
    let candidateLifecycle = false;
    try {
      const markerRes = await client.query(
        "SELECT 1 FROM hirearchy.durable_candidate_installation WHERE marker_key = 'durable-candidate-lifecycle-v1' AND marker_version = 1 LIMIT 1",
      );
      candidateLifecycle = markerRes.rows.length > 0;
    } catch {
      candidateLifecycle = false;
    }

    let onboarding = false;
    try {
      const markerRes = await client.query(
        "SELECT 1 FROM hirearchy.durable_onboarding_installation WHERE marker_key = 'durable-onboarding-v1' AND marker_version = 1 LIMIT 1",
      );
      onboarding = markerRes.rows.length > 0;
    } catch {
      onboarding = false;
    }

    let candidateTokenStorage = false;
    try {
      const metaRes = await client.query(
        'SELECT 1 FROM hirearchy.candidate_token_storage_meta WHERE version = 1 LIMIT 1',
      );
      candidateTokenStorage = metaRes.rows.length > 0;
    } catch {
      candidateTokenStorage = false;
    }

    let authoringR211 = false;
    try {
      const r211Res = await client.query(
        "SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = 'hirearchy' AND tablename = 'assessment_validated_versions'",
      );
      authoringR211 = r211Res.rows.length > 0;
    } catch {
      authoringR211 = false;
    }

    let executionR214 = false;
    try {
      const r214Res = await client.query(
        "SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = 'hirearchy' AND tablename = 'candidate_execution_operations'",
      );
      executionR214 = r214Res.rows.length > 0;
    } catch {
      executionR214 = false;
    }

    const isMigrationCurrent = migrationVersion === TARGET_MIGRATION_VERSION;
    const isReady =
      isMigrationCurrent &&
      candidateLifecycle &&
      onboarding &&
      authoringR211 &&
      executionR214;

    return {
      service: 'hirearchy-staging',
      status: isReady ? 'ready' : 'not_ready',
      timestamp,
      database: {
        connected: true,
        migrationVersion,
        targetMigrationVersion: TARGET_MIGRATION_VERSION,
        isMigrationCurrent,
        markers: {
          candidateLifecycle,
          onboarding,
          candidateTokenStorage,
          authoringR211,
          executionR214,
        },
      },
      capabilities: defaultCapabilities,
    };
  } catch (error) {
    const sanitized = sanitizeError(error);
    operationalLogger.warn(
      'Operational readiness probe detected database error',
      {
        error: sanitized.message,
        code: sanitized.code,
      },
    );

    return {
      service: 'hirearchy-staging',
      status: 'not_ready',
      timestamp,
      database: {
        connected: false,
        migrationVersion: null,
        targetMigrationVersion: TARGET_MIGRATION_VERSION,
        isMigrationCurrent: false,
        markers: {
          candidateLifecycle: false,
          onboarding: false,
          candidateTokenStorage: false,
          authoringR211: false,
          executionR214: false,
        },
        error: sanitized.message,
      },
      capabilities: defaultCapabilities,
    };
  } finally {
    try {
      await client.end();
    } catch {
      // Ignore disconnect errors
    }
  }
}
