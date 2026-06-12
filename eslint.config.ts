import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import sonarjs from 'eslint-plugin-sonarjs';
import importX from 'eslint-plugin-import-x';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: [
      'dist',
      '.vercel',
      'coverage',
      'ml/.venv',
      '.claude/skills',
      '.claude/worktrees',
      '.agents/skills',
      '.clone',
      'sidecar',
      'uw-stream',
      // Standalone Python service for multileg classifier — same pattern
      // as sidecar/uw-stream. Its own .venv contains third-party JS files
      // that fail lint by no fault of ours.
      'classifier',
      // periscope-scraper service was retired 2026-05-26 but local
      // dist/ + node_modules can linger on dev machines. Keep the
      // root-dir ignore so eslint doesn't choke on the compiled JS.
      'periscope-scraper',
      'playwright-report',
      '.scannerwork',
      // Scratch / debug / spec material — not production code, not
      // shipped to users. Keeps lint focused on src/ + api/ + scripts/.
      'docs',
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
      // React 19's react-hooks/refs is too strict for the latest-ref pattern
      // used in long-lived hooks (e.g. useChartAnalysis's 10-min retry loop
      // mirrors props into refs to avoid stale closures). Pattern is correct
      // and widely used; matches the precedent of set-state-in-effect above.
      'react-hooks/refs': 'off',
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
  // Enforce explicit `.js` extensions on relative imports in files that are
  // part of the api/ Vercel Functions compile graph. Node ESM's strict
  // resolution requires the extension at runtime; TypeScript's `bundler`
  // moduleResolution happily compiles bare imports that then crash in prod.
  // Scope: api/**, plus the shared src/ modules api/ transitively imports
  // (pure logic — types, utils, data, constants). Frontend-only .tsx files
  // go through Vite, which handles resolution, so they're exempt.
  {
    files: [
      'api/**/*.ts',
      'src/utils/**/*.ts',
      'src/types/**/*.ts',
      'src/data/**/*.ts',
      'src/constants/**/*.ts',
    ],
    ignores: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**'],
    plugins: {
      'import-x': importX,
    },
    rules: {
      'import-x/extensions': [
        'error',
        'ignorePackages',
        { ts: 'never', tsx: 'never', js: 'always', jsx: 'always' },
      ],
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
  {
    files: ['scripts/**'],
    languageOptions: {
      globals: {
        ...globals.node,
        // Probe scripts use page.evaluate(() => document.querySelector(...))
        // — those callbacks execute in the Playwright browser context, so
        // browser globals are intentional inside them.
        ...globals.browser,
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      // Probe/analysis scripts are throwaway diagnostics, not production code,
      // and are NOT in the tsconfig `include` (src/api/e2e) — so tsc never
      // type-checks them. Casting Neon query results as `any[]` and using bare
      // ternaries (`cond ? a++ : b++`) for quick tallies is fine here; these
      // two rules were the only recurring blockers forcing the gate red on
      // every new probe script.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'sonarjs/no-hardcoded-credentials': 'off',
      'sonarjs/no-clear-text-protocols': 'off',
      'sonarjs/no-hardcoded-ip': 'off',
      'sonarjs/cognitive-complexity': 'off',
      'sonarjs/no-nested-functions': 'off',
    },
  },
  prettier,
];
