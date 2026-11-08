import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  turbopack: process.env.TURBO_ROOT
    ? { root: process.env.TURBO_ROOT }
    : undefined,
  agentRules: false,
  devIndicators: false,
  experimental: {
    useTypeScriptCli: false,
  },
  turbopack: {
    root: process.env.TURBO_ROOT || '/',
  },
  poweredByHeader: false,
  serverExternalPackages: ['better-sqlite3'],
  outputFileTracingExcludes: {
    '/*': ['./.env*', '../../.env*', './.data/**', '../../.data/**'],
  },
};

export default nextConfig;
