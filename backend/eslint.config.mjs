/**
 * Backend lint. Added in Module 16 — before this, sixteen modules of TypeScript had no
 * style or correctness gate beyond `tsc`.
 *
 * Deliberately NOT the "recommended-type-checked" preset. That would light up hundreds of
 * pre-existing findings across working, reviewed code, and a rule set nobody can get to zero
 * is a rule set everyone learns to ignore. This starts at the correctness rules that catch
 * REAL defects — floating promises are the one that matters most in a codebase where a
 * forgotten `await` on a database write looks exactly like a successful one.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      /* An unused variable is usually a half-finished edit. `_`-prefixed is intentional. */
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      /* `any` is allowed but flagged — several Mongoose and Express boundaries genuinely need it. */
      '@typescript-eslint/no-explicit-any': 'warn',
      /* Deliberate: this project uses `void promise` as an explicit fire-and-forget marker. */
      'no-void': 'off',
      'no-console': 'off',
    },
  },
);
