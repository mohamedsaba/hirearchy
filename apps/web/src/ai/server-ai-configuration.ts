import { loadEnvConfig } from '@next/env';
import path from 'node:path';

export const OPENROUTER_PROVIDER_ID = 'openrouter';
export const OPENROUTER_MODEL_ID = 'google/gemini-3.8-flash';
export const NVIDIA_PROVIDER_ID = 'nvidia-nim';
export const NVIDIA_MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b';
export const NVIDIA_CHAT_COMPLETIONS_ENDPOINT =
  'https://integrate.api.nvidia.com/v1/chat/completions';

let loadedRootEnvironment = false;

const repositoryDirectory = () => {
  const currentDirectory = process.cwd();
  return path.basename(currentDirectory) === 'web' &&
    path.basename(path.dirname(currentDirectory)) === 'apps'
    ? path.dirname(path.dirname(currentDirectory))
    : currentDirectory;
};

const loadApplicationEnvironment = () => {
  if (loadedRootEnvironment || process.env.NODE_ENV === 'test') return;
  const existingEnvironment = { ...process.env };
  loadEnvConfig(
    repositoryDirectory(),
    process.env.NODE_ENV === 'development',
    {
      info: () => undefined,
      error: () => undefined,
    },
    true,
  );
  Object.assign(process.env, existingEnvironment);
  loadedRootEnvironment = true;
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
