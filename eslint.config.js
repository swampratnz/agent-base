// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

// Mirrors community-agent's flat config, so code moving here by extraction
// lands under the rules it was already written against. Keep the two in sync:
// a rule that is `error` there and `off` here would red an extraction PR for
// style, not substance.
//
// `template/` is ignored on purpose: it is a starting point copied OUT of this
// repo, not code this repo compiles. Its `main.ts` imports `@swampratnz/agent-base`
// exports that do not exist yet (the runtime lands in the extraction pass), so
// type-aware linting would fail on a file that is correct as a template.
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'template/**'],
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
      // Real bug classes for a bot with async send/confirm paths — keep ON.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Lenient-then-ratchet: these fight the existing style without
      // catching the security-relevant bug classes above.
      '@typescript-eslint/no-unused-vars': 'off', // tsc noUnusedLocals/noUnusedParameters already enforce this
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // node:test's `test(name, fn)` is fire-and-forget by design — the
      // runner tracks the returned promise itself, callers never await it.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    // Plain Node ESM: the gate scripts, and the CI smoke fixtures under
    // .github/smoke/ (which are deliberately NOT under scripts/, because
    // `files` ships scripts/ and a fixture that tests the package must not be
    // part of it).
    files: ['scripts/**/*.mjs', '.github/smoke/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  eslintConfigPrettier,
);
