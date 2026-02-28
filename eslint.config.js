import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    rules: {
      // Allow explicit any in a few places (Cloudflare SDK types)
      '@typescript-eslint/no-explicit-any': 'warn',
      // Unused vars: allow _prefixed
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    ignores: ['node_modules/', 'dist/', '.wrangler/'],
  },
);
