export interface OperationalReadinessReport {
  service: 'hirearchy-staging';
  status: 'ready' | 'not_ready';
  timestamp: string;
  database: {
    connected: boolean;
    migrationVersion: string | null;
    targetMigrationVersion: '0017';
    isMigrationCurrent: boolean;
    markers: {
      candidateLifecycle: boolean;
      onboarding: boolean;
      candidateTokenStorage: boolean;
      authoringR211: boolean;
      executionR214: boolean;
    };
    error?: string;
  };
  capabilities: {
    liveCodeExecutionEnabled: false;
    liveAiAssistanceEnabled: false;
    emailDeliveryEnabled: false;
    selfServiceOnboardingEnabled: boolean;
    managedSupabaseSupported: false;
  };
}

export declare function checkOperationalReadiness(
  databaseUrlOverride?: string,
): Promise<OperationalReadinessReport>;
