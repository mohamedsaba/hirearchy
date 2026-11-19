import {
  getNvidiaApiKey,
  isUsableApiKey,
  NVIDIA_CHAT_COMPLETIONS_ENDPOINT,
  NVIDIA_MODEL_ID,
} from './server-ai-configuration';

export interface NvidiaKimiChatOptions {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly modelId?: string;
  readonly fetchImpl?: typeof fetch;
}

export class KimiProviderUnavailableError extends Error {
  readonly code: string;
  constructor(message: string, code = 'KIMI_PROVIDER_UNAVAILABLE') {
    super(message);
    this.name = 'KimiProviderUnavailableError';
    this.code = code;
  }
}

export function resolveKimiModelId(): string {
  const override =
    process.env.HIREARCHY_NVIDIA_MODEL_ID?.trim() ||
    process.env.NVIDIA_KIMI_MODEL_ID?.trim();
  return override && override.length > 0 ? override : NVIDIA_MODEL_ID;
}

export function extractJsonFromLlmText(
  rawText: string,
): Record<string, unknown> | null {
  const trimmed = rawText.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const sliced: unknown = JSON.parse(candidate.slice(start, end + 1));
        if (sliced && typeof sliced === 'object' && !Array.isArray(sliced)) {
          return sliced as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function callNvidiaKimiChat(
  options: NvidiaKimiChatOptions,
): Promise<{ content: string; modelId: string }> {
  const apiKey = getNvidiaApiKey();
  if (!isUsableApiKey(apiKey)) {
    throw new KimiProviderUnavailableError(
      'NVIDIA_API_KEY is not configured or uses a placeholder value.',
      'NVIDIA_API_KEY_MISSING',
    );
  }

  const modelId = options.modelId?.trim() || resolveKimiModelId();
  const fetchImpl = options.fetchImpl ?? fetch;

  const response = await fetchImpl(NVIDIA_CHAT_COMPLETIONS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
    body: JSON.stringify({
      model: modelId,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 2400,
      messages: [
        { role: 'system', content: options.systemPrompt },
        { role: 'user', content: options.userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new KimiProviderUnavailableError(
      `NVIDIA NIM returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 220)}` : ''}`,
      'NVIDIA_HTTP_ERROR',
    );
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new KimiProviderUnavailableError(
      'NVIDIA NIM returned an empty response.',
      'NVIDIA_EMPTY_RESPONSE',
    );
  }

  return { content: content.trim(), modelId };
}
