import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/dist-*/**', '**/release/**', '**/node_modules/**', 'fixtures/**', 'docs/**', 'test-results/**', '**/.wrangler/**', 'cloudflare/worker-configuration.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // TypeScript checks identifiers; scripts run on Node where its globals exist.
      'no-undef': 'off',
    },
  },
  {
    // The renderer is a browser bundle: Node built-ins are forbidden there.
    files: ['apps/desktop/renderer/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['node:*', 'electron', 'fs', 'child_process', '@atlas/storage', '@atlas/terminal', '@atlas/workspace', '@atlas/runtime-*', '@atlas/orchestrator'] }],
    },
  },
);
