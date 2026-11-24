import {
  getNvidiaApiKey,
  isUsableApiKey,
  NVIDIA_CHAT_COMPLETIONS_ENDPOINT,
  NVIDIA_MODEL_ID,
} from './server-ai-configuration';
import { setTimeout as delay } from 'node:timers/promises';

export interface NvidiaKimiChatOptions {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly modelId?: string;
  readonly responseFormat?: 'json_object' | 'text';
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
  const outerFenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = outerFenceMatch ? outerFenceMatch[1].trim() : trimmed;
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

  const signal = AbortSignal.timeout(options.timeoutMs ?? 45_000);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey.trim()}`,
  };
  let response = await fetchImpl(NVIDIA_CHAT_COMPLETIONS_ENDPOINT, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: modelId,
      stream: false,
      ...(modelId.includes('nemotron')
        ? { chat_template_kwargs: { enable_thinking: false } }
        : { reasoning_effort: 'low' }),
      ...(options.responseFormat === 'json_object'
        ? { response_format: { type: 'json_object' } }
        : {}),
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 2400,
      messages: [
        { role: 'system', content: options.systemPrompt },
        { role: 'user', content: options.userPrompt },
      ],
    }),
  });

  if (response.status === 202) {
    const requestId = response.headers.get('nvcf-reqid');
    if (!requestId || !/^[a-z0-9-]{1,128}$/i.test(requestId)) {
      throw new KimiProviderUnavailableError(
        'NVIDIA did not return a request reference.',
      );
    }
    const statusUrl = new URL(
      `../status/${requestId}`,
      NVIDIA_CHAT_COMPLETIONS_ENDPOINT,
    );
    while (response.status === 202) {
      await response.body?.cancel();
      await delay(750, undefined, { signal });
      response = await fetchImpl(statusUrl, { headers, signal });
    }
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new KimiProviderUnavailableError(
      `NVIDIA could not complete this request (HTTP ${response.status}). Try again shortly.`,
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
