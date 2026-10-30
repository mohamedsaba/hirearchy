import type {
  CandidateContextAttachment,
  HirearchyContextMetadata,
} from './ai-interaction';

export type NormalizedAiRequest = Readonly<{
  configuredModelId: string;
  candidateInput: string;
  candidateContext?: readonly CandidateContextAttachment[];
  hirearchyContext?: HirearchyContextMetadata;
  conversationHistory?: readonly Readonly<{
    candidateInput: string;
    responseText: string;
  }>[];
}>;

export type NormalizedAiTokenUsage = Readonly<{
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}>;

export type NormalizedAiResult = Readonly<{
  responseText: string;
  reportedModelId?: string;
  providerRequestId?: string;
  finishReason?: string;
  tokenUsage?: NormalizedAiTokenUsage;
}>;

export type AiProviderExecutionOptions = Readonly<{
  signal?: AbortSignal;
}>;

export interface AiProvider {
  readonly providerId: string;
  execute(
    request: NormalizedAiRequest,
    options?: AiProviderExecutionOptions,
  ): Promise<NormalizedAiResult>;
}

export interface AiProviderRegistry {
  getProvider(providerId: string): AiProvider | undefined;
  registerProvider(provider: AiProvider): void;
}

export class DefaultAiProviderRegistry implements AiProviderRegistry {
  private readonly providers = new Map<string, AiProvider>();

  constructor(providers: readonly AiProvider[] = []) {
    for (const provider of providers) {
      this.registerProvider(provider);
    }
  }

  getProvider(providerId: string): AiProvider | undefined {
    return this.providers.get(providerId);
  }

  registerProvider(provider: AiProvider): void {
    this.providers.set(provider.providerId, provider);
  }
}
