import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  turbopack: {
    root: process.env.TURBO_ROOT || '/',
  },
  agentRules: false,
  devIndicators: false,
  experimental: {
    useTypeScriptCli: false,
  },
  poweredByHeader: false,
  serverExternalPackages: ['better-sqlite3'],
  outputFileTracingExcludes: {
    '/*': ['./.env*', '../../.env*', './.data/**', '../../.data/**'],
  },
};

export default nextConfig;
