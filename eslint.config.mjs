import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    rules: {
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
  // `.worktrees` and `.agents` are separate checkouts and a local tooling
  // directory that sit inside this repository but are not its source. Without
  // these ignores `npm run lint` in the main checkout descends into every
  // worktree and reports their code as this project's errors.
  globalIgnores([
    'apps/web/.next/**',
    'coverage/**',
    // Local database backups and extracted release artifacts are generated state.
    '.data/**',
    '.worktrees/**',
    '.agents/**',
  ]),
]);
