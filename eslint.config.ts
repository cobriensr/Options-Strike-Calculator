import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import sonarjs from 'eslint-plugin-sonarjs';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: [
      'dist',
      'coverage',
      'scripts',
      'ml/.venv',
      '.claude/skills',
      'sidecar',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  sonarjs.configs!.recommended!,
  {
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/set-state-in-effect': 'off',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // Nested ternaries are idiomatic in JSX/React for conditional rendering
      'sonarjs/no-nested-conditional': 'off',
      // Math.random() for UI IDs is fine — not security-sensitive
      'sonarjs/pseudo-random': 'off',
      'sonarjs/cognitive-complexity': 'off',
      // Callback nesting in hooks is normal React pattern
      'sonarjs/no-nested-functions': 'off',
    },
  },
  {
    files: ['src/__tests__/**', 'api/__tests__/**', 'e2e/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'sonarjs/no-hardcoded-credentials': 'off',
      'sonarjs/no-clear-text-protocols': 'off',
      'sonarjs/no-hardcoded-ip': 'off',
      'sonarjs/assertions-in-tests': 'off',
      'sonarjs/slow-regex': 'off',
      'sonarjs/cognitive-complexity': 'off',
      'sonarjs/pseudo-random': 'off',
    },
  },
  prettier,
];
