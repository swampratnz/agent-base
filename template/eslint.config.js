// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

// Mirrors agent-base's config. Keep the two floating-promise rules ON: they
// are the real bug class for an agent with async send and confirm paths, where
// a dropped promise is a message that silently never arrives.
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Lenient-then-ratchet: tighten these as the codebase grows rather than
      // fighting them on day one.
      '@typescript-eslint/no-unused-vars': 'off', // tsc noUnusedLocals/noUnusedParameters cover this
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // node:test's `test(name, fn)` is fire-and-forget by design — the runner
      // tracks the returned promise itself, callers never await it.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  eslintConfigPrettier,
);
