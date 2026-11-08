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
  let databaseConnected = false;

  try {
    await client.connect();

    await client.query('SELECT 1');
    databaseConnected = true;

    const { rows } = await client.query(
      'SELECT staging.readiness_probe() AS readiness',
    );
    const probe = rows[0]?.readiness;
    const markerNames = [
      'candidateLifecycle',
      'onboarding',
      'candidateTokenStorage',
      'authoringR211',
      'executionR214',
    ];
    const probeValid =
      probe !== null &&
      typeof probe === 'object' &&
      !Array.isArray(probe) &&
      Object.keys(probe).length === 2 &&
      Object.hasOwn(probe, 'migrationVersion') &&
      Object.hasOwn(probe, 'markers') &&
      (probe.migrationVersion === null ||
        typeof probe.migrationVersion === 'string') &&
      probe.markers !== null &&
      typeof probe.markers === 'object' &&
      !Array.isArray(probe.markers) &&
      Object.keys(probe.markers).length === markerNames.length &&
      markerNames.every((name) => typeof probe.markers[name] === 'boolean');

    if (!probeValid) {
      throw new Error('Database readiness metadata probe is unavailable');
    }

    const migrationVersion = probe.migrationVersion;
    const {
      candidateLifecycle,
      onboarding,
      candidateTokenStorage,
      authoringR211,
      executionR214,
    } = probe.markers;

    const isMigrationCurrent = migrationVersion === TARGET_MIGRATION_VERSION;
    const isReady =
      isMigrationCurrent &&
      candidateLifecycle &&
      onboarding &&
      candidateTokenStorage &&
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
        connected: databaseConnected,
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
