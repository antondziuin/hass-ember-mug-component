import { defineConfig } from 'vitest/config';

// node:sqlite is behind a flag until Node 23; from Node 24 it is built in and the flag may
// not be accepted at all, so it is only passed where it is actually needed.
const nodeMajor = Number(process.versions.node.split('.')[0]);
const sqliteArgs = nodeMajor < 23 ? ['--experimental-sqlite'] : [];

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.tsx'],
    // Forks rather than threads, so `node:sqlite` can be enabled for the worker: the
    // conformance suite loads the server's SQLite layer directly to check that it agrees
    // with the client-side fold.
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: sqliteArgs,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/testing/**'],
    },
  },
});
