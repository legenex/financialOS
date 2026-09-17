import { defineConfig } from 'vitest/config';

// Unit tests are pure and never touch a database.
// Integration tests (*.int.test.ts) require FOS_TEST_DATABASE_URL pointing at the
// isolated test database started by deploy/scripts/test-db.sh. They refuse to run
// against anything that does not look like the test database.
export default defineConfig({
  test: {
    pool: 'forks',
    maxWorkers: 3,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts', 'apps/api/src/**/*.test.ts', 'apps/worker/src/**/*.test.ts', 'apps/extension/src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['packages/*/src/**/*.int.test.ts', 'apps/*/src/**/*.int.test.ts', 'tests/integration/**/*.int.test.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['apps/web/src/**/*.test.{ts,tsx}', 'packages/ui/src/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
