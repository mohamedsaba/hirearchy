import {
  R212_SYNTHETIC_PROVIDER_ID,
  R212_SYNTHETIC_MODEL_ID,
  type R212GatewayRequest,
} from './contract';

export type SyntheticProviderOutput = Readonly<{
  providerId: string;
  modelId: string;
  response: string;
  usage: {
    promptChars: number;
    responseChars: number;
    synthetic: true;
  };
}>;

export class SyntheticAiProvider {
  readonly providerId = R212_SYNTHETIC_PROVIDER_ID;
  readonly modelId = R212_SYNTHETIC_MODEL_ID;

  async generateResponse(
    request: R212GatewayRequest,
  ): Promise<SyntheticProviderOutput> {
    const prompt = request.candidatePrompt.trim();

    if (prompt.includes('SIMULATE_PROVIDER_ERROR')) {
      const error = new Error('Synthetic provider simulated internal failure');
      (error as Error & { code: string }).code = 'SYNTHETIC_PROVIDER_FAILURE';
      throw error;
    }

    let responseBody = '';
    const lower = prompt.toLowerCase();

    if (lower.includes('booking') || lower.includes('retry')) {
      responseBody =
        'In Python, exponential backoff with jitter can be implemented using `time.sleep(min(max_backoff, base * 2 ** attempt))`. Ensure all failed retry attempts record an error log before re-attempting.';
    } else if (lower.includes('test') || lower.includes('assert')) {
      responseBody =
        'To verify notification delivery, mock the network client and assert that failed attempts trigger retries up to the configured limit before raising `NotificationDeliveryError`.';
    } else if (lower.includes('hello') || lower.includes('help')) {
      responseBody =
        'I am the assessment assistant. You can ask questions regarding requirements, Python syntax, and implementation logic within your assessment.';
    } else {
      responseBody = `Understood. Regarding: "${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}" — Review the task brief and acceptance criteria in the left panel to ensure your implementation meets all stated constraints.`;
    }

    const response = `[Synthetic Assistant] ${responseBody}`;

    return {
      providerId: this.providerId,
      modelId: this.modelId,
      response,
      usage: {
        promptChars: request.candidatePrompt.length,
        responseChars: response.length,
        synthetic: true,
      },
    };
  }
}

export const defaultSyntheticProvider = new SyntheticAiProvider();
