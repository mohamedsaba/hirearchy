import { defineConfig, configDefaults } from 'vitest/config';

// The repository has no vitest config, so `vitest run` globs from the root with
// Vitest's defaults. That is correct inside a worktree, but the main checkout
// also contains `.worktrees`, which holds several other checkouts of this same
// project. Vitest collected their test files too — 352 files instead of 71 —
// and because every copy resolves shared state (the `.data` database, fixed
// ports) relative to the root it was launched from, those copies collided and
// failed. `.agents` is a local, untracked tooling directory with the same
// problem.
//
// `configDefaults.exclude` is spread first so Vitest's own exclusions, notably
// its node_modules glob, keep working. Overriding `exclude` outright would drop
// them.
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      '**/.worktrees/**',
      '**/.agents/**',
      '**/tests/restricted-executor/**',
    ],
  },
});
