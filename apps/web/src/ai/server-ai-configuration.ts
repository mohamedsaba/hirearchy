import { loadEnvConfig } from '@next/env';
import fs from 'node:fs';
import path from 'node:path';

import {
  AI_REVIEW_MODEL_CATALOG,
  type AiReviewModelOption,
  type AiReviewPresetId,
} from '../r27-evidence/ai-review-contract';

export {
  AI_REVIEW_MODEL_CATALOG,
  type AiReviewModelOption,
  type AiReviewPresetId,
};

export const OPENROUTER_PROVIDER_ID = 'openrouter';
export const OPENROUTER_MODEL_ID = 'google/gemini-3.8-flash';
export const OPENROUTER_CHAT_COMPLETIONS_ENDPOINT =
  'https://openrouter.ai/api/v1/chat/completions';
export const NVIDIA_PROVIDER_ID = 'nvidia-nim';
export const NVIDIA_MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b';
export const NVIDIA_CHAT_COMPLETIONS_ENDPOINT =
  'https://integrate.api.nvidia.com/v1/chat/completions';

let loadedRootEnvironment = false;

const repositoryDirectories = (): string[] => {
  const currentDirectory = process.cwd();
  const repoRoot =
    path.basename(currentDirectory) === 'web' &&
    path.basename(path.dirname(currentDirectory)) === 'apps'
      ? path.dirname(path.dirname(currentDirectory))
      : currentDirectory;
  const candidates = [repoRoot];
  // If running inside `.worktrees/<name>`, also check the primary checkout `.env`.
  if (path.basename(path.dirname(repoRoot)) === '.worktrees') {
    const primaryCheckout = path.dirname(path.dirname(repoRoot));
    if (fs.existsSync(primaryCheckout)) {
      candidates.push(primaryCheckout);
    }
  }
  return candidates;
};

const loadApplicationEnvironment = () => {
  if (loadedRootEnvironment || process.env.NODE_ENV === 'test') return;
  const existingEnvironment = { ...process.env };
  for (const directory of repositoryDirectories()) {
    loadEnvConfig(
      directory,
      process.env.NODE_ENV === 'development',
      {
        info: () => undefined,
        error: () => undefined,
      },
      true,
    );
  }
  Object.assign(process.env, existingEnvironment);
  loadedRootEnvironment = true;
};

export const isUsableApiKey = (value: string | undefined): value is string => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 8) return false;
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('placeholder') ||
    lower.startsWith('your_') ||
    lower.startsWith('replace_') ||
    lower.includes('example') ||
    lower.includes('dummy') ||
    trimmed === '***'
  ) {
    return false;
  }
  return true;
};

export const getOpenRouterApiKey = (): string | undefined => {
  const runtimeKey = Reflect.get(process.env, 'OPENROUTER_KEY');
  if (typeof runtimeKey === 'string' && runtimeKey.trim()) return runtimeKey;
  if (process.env.NODE_ENV === 'test') return undefined;
  loadApplicationEnvironment();
  const recheckedKey = Reflect.get(process.env, 'OPENROUTER_KEY');
  if (typeof recheckedKey === 'string' && recheckedKey.trim())
    return recheckedKey;
  return undefined;
};

export const getNvidiaApiKey = (): string | undefined => {
  const runtimeKey = Reflect.get(process.env, 'NVIDIA_API_KEY');
  if (typeof runtimeKey === 'string' && runtimeKey.trim()) return runtimeKey;
  if (process.env.NODE_ENV === 'test') return undefined;
  loadApplicationEnvironment();
  const recheckedKey = Reflect.get(process.env, 'NVIDIA_API_KEY');
  return typeof recheckedKey === 'string' && recheckedKey.trim()
    ? recheckedKey
    : undefined;
};

export const getConfiguredRuntimeAiProvider = () => {
  if (getNvidiaApiKey()) {
    return {
      providerId: NVIDIA_PROVIDER_ID,
      modelId: NVIDIA_MODEL_ID,
      configurationVersion: 'nvidia-nemotron-3-super-v1',
    } as const;
  }
  if (getOpenRouterApiKey()) {
    return {
      providerId: OPENROUTER_PROVIDER_ID,
      modelId: OPENROUTER_MODEL_ID,
      configurationVersion: 'openrouter-gemini-3.8-v1',
    } as const;
  }
  return null;
};

export interface ResolvedAiReviewProvider {
  readonly presetId: AiReviewPresetId;
  readonly providerId: 'nvidia' | 'openrouter' | 'preview';
  readonly modelId: string;
  readonly label: string;
  readonly endpoint: string | null;
  readonly apiKey: string | null;
  readonly mode: 'live_ai' | 'evidence_preview';
  readonly fallbackReason?: string;
}

export const resolveAiReviewProviderConfig = (options?: {
  preset?: string;
  customModelId?: string;
  forcePreview?: boolean;
}): ResolvedAiReviewProvider => {
  const previewPreset = AI_REVIEW_MODEL_CATALOG.find(
    (entry) => entry.id === 'preview:evidence-engine',
  )!;

  if (options?.forcePreview || options?.preset === 'preview:evidence-engine') {
    return {
      presetId: 'preview:evidence-engine',
      providerId: 'preview',
      modelId: previewPreset.modelId,
      label: previewPreset.label,
      endpoint: null,
      apiKey: null,
      mode: 'evidence_preview',
    };
  }

  const nvidiaKey = getNvidiaApiKey();
  const openRouterKey = getOpenRouterApiKey();
  const hasNvidia = isUsableApiKey(nvidiaKey);
  const hasOpenRouter = isUsableApiKey(openRouterKey);

  const requestedPreset =
    AI_REVIEW_MODEL_CATALOG.find((entry) => entry.id === options?.preset) ??
    (hasNvidia
      ? AI_REVIEW_MODEL_CATALOG.find((entry) => entry.id === 'nvidia:kimi-k2')!
      : hasOpenRouter
        ? AI_REVIEW_MODEL_CATALOG.find(
            (entry) => entry.id === 'openrouter:gemini-flash',
          )!
        : previewPreset);

  const trimmedCustomModel = options?.customModelId?.trim();
  const effectiveModelId =
    trimmedCustomModel && trimmedCustomModel.length > 0
      ? trimmedCustomModel
      : requestedPreset.id === 'nvidia:kimi-k2' &&
          process.env.NVIDIA_AI_REVIEW_MODEL_ID?.trim()
        ? process.env.NVIDIA_AI_REVIEW_MODEL_ID.trim()
        : requestedPreset.modelId;

  if (requestedPreset.providerId === 'nvidia') {
    if (hasNvidia) {
      return {
        presetId: requestedPreset.id,
        providerId: 'nvidia',
        modelId: effectiveModelId,
        label: trimmedCustomModel
          ? `NVIDIA NIM · ${effectiveModelId}`
          : requestedPreset.label,
        endpoint: NVIDIA_CHAT_COMPLETIONS_ENDPOINT,
        apiKey: nvidiaKey.trim(),
        mode: 'live_ai',
      };
    }
    if (hasOpenRouter && !options?.preset) {
      const orPreset = AI_REVIEW_MODEL_CATALOG.find(
        (entry) => entry.id === 'openrouter:gemini-flash',
      )!;
      return {
        presetId: orPreset.id,
        providerId: 'openrouter',
        modelId: orPreset.modelId,
        label: orPreset.label,
        endpoint: OPENROUTER_CHAT_COMPLETIONS_ENDPOINT,
        apiKey: openRouterKey.trim(),
        mode: 'live_ai',
      };
    }
    return {
      presetId: 'preview:evidence-engine',
      providerId: 'preview',
      modelId: effectiveModelId,
      label: `Evidence-Grounded Preview (${requestedPreset.label} waiting for NVIDIA_API_KEY)`,
      endpoint: null,
      apiKey: null,
      mode: 'evidence_preview',
      fallbackReason:
        'NVIDIA_API_KEY is not active or uses a placeholder value; showing evidence-grounded preview.',
    };
  }

  if (requestedPreset.providerId === 'openrouter') {
    if (hasOpenRouter) {
      return {
        presetId: requestedPreset.id,
        providerId: 'openrouter',
        modelId: effectiveModelId,
        label: trimmedCustomModel
          ? `OpenRouter · ${effectiveModelId}`
          : requestedPreset.label,
        endpoint: OPENROUTER_CHAT_COMPLETIONS_ENDPOINT,
        apiKey: openRouterKey.trim(),
        mode: 'live_ai',
      };
    }
    if (hasNvidia && !options?.preset) {
      const nvPreset = AI_REVIEW_MODEL_CATALOG.find(
        (entry) => entry.id === 'nvidia:kimi-k2',
      )!;
      return {
        presetId: nvPreset.id,
        providerId: 'nvidia',
        modelId: nvPreset.modelId,
        label: nvPreset.label,
        endpoint: NVIDIA_CHAT_COMPLETIONS_ENDPOINT,
        apiKey: nvidiaKey.trim(),
        mode: 'live_ai',
      };
    }
    return {
      presetId: 'preview:evidence-engine',
      providerId: 'preview',
      modelId: effectiveModelId,
      label: `Evidence-Grounded Preview (${requestedPreset.label} waiting for OPENROUTER_KEY)`,
      endpoint: null,
      apiKey: null,
      mode: 'evidence_preview',
      fallbackReason:
        'OPENROUTER_KEY is not active or uses a placeholder value; showing evidence-grounded preview.',
    };
  }

  return {
    presetId: 'preview:evidence-engine',
    providerId: 'preview',
    modelId: previewPreset.modelId,
    label: previewPreset.label,
    endpoint: null,
    apiKey: null,
    mode: 'evidence_preview',
  };
};
