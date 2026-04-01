import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['dist', 'coverage', '*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  sonarjs.configs!.recommended!,
  {
    rules: {
      'sonarjs/cognitive-complexity': 'off',
      'sonarjs/no-nested-functions': 'off',
    },
  },
  {
    files: ['src/__tests__/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'sonarjs/no-hardcoded-credentials': 'off',
      'sonarjs/no-clear-text-protocols': 'off',
      'sonarjs/assertions-in-tests': 'off',
    },
  },
  prettier,
];
