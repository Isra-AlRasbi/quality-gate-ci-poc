import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/**
 * Lint rules deliberately kept to a small, defensible set.
 *
 * The point of this POC is to prove that a lint failure blocks a merge, not to
 * argue about style. Anything that would require a large cleanup commit is out
 * of scope; `no-console` is a warning so that debug leftovers never become a
 * merge blocker by accident.
 */
export default tseslint.config(
  {
    ignores: ['dist/', 'coverage/', 'node_modules/', '*.config.timestamp-*'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-console': 'warn',
      'no-debugger': 'error',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Tests and config run in Node, not the browser.
    files: ['tests/**/*.ts', '*.config.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },
)
