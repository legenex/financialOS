import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '.tools/**', '.kilo/**', 'test-results/**', 'playwright-report/**', 'packages/db/migrations/**', 'apps/extension/release/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Authoritative money must never use binary floating point.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'parseFloat is forbidden: use Decimal from @financialos/domain for money and quantities.',
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['scripts/**', '**/build.mjs', 'deploy/**', '**/*.config.{js,ts,mjs}', 'tests/**', '**/*-cli.ts', 'apps/*/src/main.ts'],
    rules: { 'no-console': 'off' },
  },
);
