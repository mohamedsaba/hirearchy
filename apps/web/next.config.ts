import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  turbopack: {
    root: process.env.TURBO_ROOT || '/',
  },
  agentRules: false,
  devIndicators: false,
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  experimental: {
    useTypeScriptCli: false,
  },
  poweredByHeader: false,
  serverExternalPackages: ['better-sqlite3', 'pg'],
  outputFileTracingExcludes: {
    '/*': ['./.env*', '../../.env*', './.data/**', '../../.data/**'],
  },
};

export default nextConfig;
