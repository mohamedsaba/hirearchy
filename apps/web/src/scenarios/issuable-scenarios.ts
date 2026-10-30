import type { AiCapabilitySnapshot } from '../ai/ai-interaction';
import { getConfiguredRuntimeAiProvider } from '../ai/server-ai-configuration';
import { scenario001, scenario001AiCapability } from './scenario-001';
import {
  scenario002,
  scenario002AiCapability,
} from './scenario-002-booking-notification-retry';
import type { ScenarioSnapshot } from './slice-one-scenario';

export type IssuableScenario = Readonly<{
  scenario: ScenarioSnapshot;
  aiCapability: AiCapabilitySnapshot;
}>;

const issuableScenarios: readonly IssuableScenario[] = [
  {
    scenario: scenario001,
    aiCapability: scenario001AiCapability,
  },
  {
    scenario: scenario002,
    aiCapability: scenario002AiCapability,
  },
];

export const getIssuableScenario = (
  scenarioId: string,
): IssuableScenario | undefined => {
  const issuance = issuableScenarios.find(
    ({ scenario }) => scenario.id === scenarioId,
  );
  if (!issuance) return undefined;
  const configuredProvider = getConfiguredRuntimeAiProvider();
  if (!configuredProvider) {
    // Honest unavailability: when no runtime AI provider is configured,
    // issue the scenario with AI disabled (mirroring
    // disabledAiCapabilitySnapshot) so sessions never claim a provider the
    // deployment does not have, and candidates never receive synthetic mock
    // output posing as a real AI response.
    return {
      ...issuance,
      aiCapability: {
        ...issuance.aiCapability,
        enabled: false,
        configuredProviderId: 'none',
        configuredModelId: 'none',
      },
    };
  }
  return {
    ...issuance,
    aiCapability: {
      ...issuance.aiCapability,
      configuredProviderId: configuredProvider.providerId,
      configuredModelId: configuredProvider.modelId,
      configurationVersion: configuredProvider.configurationVersion,
    },
  };
};
