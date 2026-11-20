import { availableParallelism } from 'node:os';
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { visualizer } from 'rollup-plugin-visualizer';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { vercelToolbar } from '@vercel/toolbar/plugins/vite';

const analyze = process.env.ANALYZE === 'true';

/** Every test file vitest collects. */
export const TEST_INCLUDE = [
  'src/**/*.{test,spec}.{ts,tsx}',
  'api/**/*.{test,spec}.{ts,tsx}',
  'scripts/_lib/**/*.{test,spec}.{ts,mjs}',
];

/**
 * The test files that start child processes (git, node, a nested vitest), the
 * `spawn` project below. Repo-relative, sorted. The `spawn` project includes
 * exactly these and the `main` project excludes exactly these, so a file is in
 * one project and never both or neither. A test that starts a child process
 * but is missing here fails scripts/_lib/spawn-test-group.test.mjs; so does an
 * entry whose file is gone. A file that replaces `node:child_process` outright,
 * with a `vi.mock` factory that takes no parameter, starts nothing and belongs
 * in `main`; a factory that wraps the real module does start children.
 */
export const SPAWN_TEST_FILES = [
  'api/__tests__/no-database-guard.test.ts',
  'api/__tests__/vercel-ignore-command.test.ts',
  'scripts/_lib/backfill-cli.test.mjs',
  'scripts/_lib/backfill-sidecar-startup.test.mjs',
  'scripts/_lib/build-output.test.mjs',
  'scripts/_lib/candles-backfill.test.mjs',
  'scripts/_lib/coverage-floor.test.mjs',
  'scripts/_lib/flow-data-backfill.test.mjs',
  'scripts/_lib/git-run.test.mjs',
  'scripts/_lib/greek-nope-backfill.cli.test.mjs',
  'scripts/_lib/net-prem-ticks-backfill.test.mjs',
  'scripts/_lib/prune-worktrees.ledger.test.mjs',
  'scripts/_lib/prune-worktrees.races.test.mjs',
  'scripts/_lib/prune-worktrees.test.mjs',
  'scripts/_lib/review-gate.cli.test.mjs',
  'scripts/_lib/review-gate.test.mjs',
  'scripts/_lib/review-summary.test.mjs',
  'scripts/_lib/scratch-git.test.mjs',
  'scripts/_lib/session-status.cli.test.mjs',
  'scripts/_lib/spawn-timeout.test.mjs',
  'scripts/_lib/vercel-build-file-set.test.mjs',
  'scripts/_lib/watch-deploy.cli.test.mjs',
];

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    vercelToolbar(),
    analyze &&
      visualizer({
        open: true,
        filename: 'dist/bundle-stats.html',
        gzipSize: true,
      }),
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      telemetry: process.env.NODE_ENV === 'production',
      // Without this handler, a slow or hung Sentry source-map upload
      // can keep the Node event loop alive after vite emits dist/ —
      // Vercel waits for the build process to exit and times out the
      // whole deployment at 45 min (see incident 2026-05-19). Treating
      // upload failures as a warning lets the build process exit
      // cleanly; missing source maps for one deploy is much cheaper
      // than a stuck deploy queue.
      errorHandler: (err) => {
        console.warn(
          '[sentry-vite-plugin] source map upload failed; continuing:',
          err.message,
        );
      },
    }),
    VitePWA({
      // Switched from `generateSW` to `injectManifest` in Phase 2A.1 so
      // the custom `src/sw.ts` can ship a `push` event handler for Web
      // Push alerts (FuturesGammaPlaybook). All previous Workbox runtime
      // caching behavior is preserved in `src/sw.ts` — see that file's
      // header comment for the 1:1 mapping of each former rule.
      //
      // `registerType: 'prompt'` (was 'autoUpdate') so a new deployment
      // does not auto-replace the running SW behind the user's back. The
      // app entry calls `registerSW({ onNeedRefresh })` to surface a
      // "Reload" banner; clicking it triggers `updateSW(true)` which
      // posts SKIP_WAITING to the new SW. See src/lib/sw-update.ts.
      registerType: 'prompt',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      manifest: {
        name: '0DTE Strike Calculator',
        short_name: '0DTE Calc',
        description:
          'Black-Scholes delta-based strike calculator for 0DTE SPX/SPY options',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,woff2}'],
      },
    }),
  ],
  define: {
    // Expose SENTRY_DSN to client (Vercel sets SENTRY_DSN, Vite needs VITE_ prefix)
    'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(
      process.env.SENTRY_DSN ?? '',
    ),
    // Build-SHA canary: lets us detect if Vercel's build cache served a
    // stale function bundle by comparing the live console/footer SHA to
    // the commit that was actually pushed. Vercel injects
    // VERCEL_GIT_COMMIT_SHA on every build; local dev falls back to 'local'.
    __BUILD_SHA__: JSON.stringify(
      (process.env.VERCEL_GIT_COMMIT_SHA ?? 'local').slice(0, 7),
    ),
  },
  build: {
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('lightweight-charts')) return 'charts';
          // Exact package names only: a bare `node_modules/react` prefix
          // also caught react-markdown, which dragged it and its
          // unified/micromark deps (~120 KB) into this preloaded chunk.
          // scripts/check-build-output.mjs fails the review if it returns.
          if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id))
            return 'vendor';
          if (id.includes('@sentry')) return 'sentry';
          if (id.includes('xlsx')) return 'export';
          if (id.includes('src/data/vixRangeStats')) return 'vix-data';
        },
      },
    },
  },
  server: {
    port: process.env.PORT ? Number.parseInt(process.env.PORT) : 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
        // Every /api request is proxied, so nothing under api/ may be
        // imported by browser code: Vite dev would serve it as a module
        // at /api/... (e.g. a JSON import as /api/...json?import), the
        // proxy would forward it to the backend, and the e2e specs'
        // page.route('**/api/**') would intercept it, leaving the app
        // blank. Shared data files live in src/ instead (see
        // src/data/flow-regime-baseline.json).
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    testTimeout: 15_000,
    // Vitest's hook default is 10 s. The PGlite suites build a database in
    // beforeAll or per test in beforeEach (the futures suites also rebuild a
    // fixture world), and a loaded machine stretches that. Measured
    // 2026-11-13, one full `vitest run --coverage` with other sessions holding
    // the CPU at 65-100%: 2373 hooks in the 62 PGlite files, p99 2.2 s,
    // slowest 8.4 s (futures-derived-recompute beforeEach), then 5.4 s
    // (wave2-backfill beforeAll). The same day a review failed with "Hook
    // timed out in 10000ms" in futures-derived-thin-roots, whose beforeAll
    // already passes 120 s, so a hook with no timeout of its own was the one
    // that ran over. 60 s is about 7x the slowest measured hook and equals
    // the shortest explicit PGlite beforeAll timeout. An explicit timeout
    // argument or vi.setConfig still wins over it (scratch-git.fixtures.mjs
    // sets 600 s).
    hookTimeout: 60_000,
    setupFiles: ['./src/__tests__/setup.ts'],
    // No `include` here, on purpose: a project that extends this config gets
    // its own `include` concatenated onto the root one (vite's mergeConfig
    // joins arrays), so a root list would put every test file in `spawn` too.
    // The root then has vitest's default include, which vitest appends to
    // coverage.exclude as before (scripts/_lib/coverage-thresholds.test.mjs
    // mirrors that).
    //
    // Two projects, run one after the other (sequence.groupOrder), so that the
    // tests that start child processes never share the CPU with the full-width
    // run. Both extend this config: same environment, setup file, timeouts and
    // coverage. Why (docs/superpowers/specs/gate-spawn-test-group-2026-11-19.md,
    // measured 2026-11-19 on the 16-core workstation): a process start
    // collapses once runnable threads outnumber cores (git rev-parse: 60 ms at
    // 8 busy cores, 674 ms at 16, 22.9 s at 48), and the gate's 15 workers
    // alone made git spawns average 855 ms (50 ms alone). The git fixture
    // suites make 400-650 spawns each, so they blew their hook limits, and a
    // `node -e` child of spawn-timeout.test.mjs had written nothing when its
    // 10 s limit killed it.
    //
    // The group orders are 1 and 2, not 0 and 1: a project at order 0 whose
    // maxWorkers is 1 (VITEST_MAX_WORKERS=1, --no-file-parallelism, or a
    // 2-CPU machine) is moved into vitest's `sequential` group, which runs
    // after every other group.
    projects: [
      {
        extends: true,
        test: {
          name: 'spawn',
          include: SPAWN_TEST_FILES,
          sequence: { groupOrder: 1 },
          // The width: 6, or fewer where the machine has fewer cores (vitest's
          // own default is cores - 1, at least 1: a 4-vCPU CI runner gets 3).
          // 6 was measured 2026-11-19 with the group alone on the 16-core
          // workstation (the group then held 21 files and 1046 tests; a git
          // spawn is about 50 ms on an idle machine). The rule: the fastest
          // width whose mean git spawn stays under 150 ms, 3x idle.
          //   workers  wall       mean git spawn  slowest ledger beforeAll
          //   2        103-110 s  60-64 ms        7.1 s
          //   3        73-76 s    64-66 ms        7.0 s
          //   4        59-60 s    70-72 ms        8.0 s
          //   6        50 s       79 ms           9.5 s
          maxWorkers: Math.min(6, Math.max(1, availableParallelism() - 1)),
        },
      },
      {
        extends: true,
        test: {
          name: 'main',
          include: TEST_INCLUDE,
          exclude: [...configDefaults.exclude, ...SPAWN_TEST_FILES],
          sequence: { groupOrder: 2 },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json'],
      reportsDirectory: './coverage',
      // Three layers of coverage floors; dropping below any one fails
      // `npm run review`:
      // - Global (the four numbers below): aggregate over every file, set
      //   a few points under current coverage (95.0% statements / 87.7%
      //   branches / 96.0% functions / 96.7% lines on 2026-10-26).
      // - Per folder (the glob keys): each is checked as an AGGREGATE over
      //   the files it matches (perFile is off) and does NOT inherit the
      //   global numbers, so only branches and lines are checked. Set to
      //   floor(aggregate) - 1, measured 2026-10-26; the -1 lets one new,
      //   slightly-under file land without failing its folder. Globs are
      //   matched by picomatch against repo-relative paths. The endpoints
      //   key is api/*.ts plus every api/ subfolder except _lib, cron and
      //   __tests__; `api/!(_lib|cron|__tests__)/**` would be wrong, since
      //   picomatch's negation there is prefix-only and would also drop a
      //   future api/cron-foo/. A key that matches no files passes
      //   silently forever (an empty match's pct is 'Unknown', and
      //   'Unknown' < 84 is false). So the guard test
      //   scripts/_lib/coverage-thresholds.test.mjs fails when a key
      //   matches nothing, when an api/ file is not in exactly one api
      //   key, when the endpoints key misroutes, or when a floor is added
      //   or removed or the endpoints key is edited (it expects exactly 6
      //   keys, 3 under api/, one of them the endpoints key). Rename a
      //   folder, rename its key; add or remove a folder floor, update
      //   the 6/3 counts in that test.
      // - Per file: scripts/check-coverage-floor.mjs (floors in
      //   scripts/_lib/coverage-floor.mjs), run after vitest because
      //   `perFile` would turn every threshold here into a per-file one.
      // Raise any floor by hand after a test pass lands; never lower one
      // to make a run pass. Spec:
      // docs/superpowers/specs/coverage-floors-2026-10-26.md.
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 90,
        lines: 90,
        'api/cron/**': { branches: 84, lines: 95 },
        'api/_lib/**': { branches: 89, lines: 97 },
        'api/!({_lib,cron,__tests__}/**)': { branches: 87, lines: 94 },
        'src/components/**': { branches: 84, lines: 93 },
        'src/hooks/**': { branches: 85, lines: 96 },
        'src/utils/**': { branches: 92, lines: 97 },
      },
      include: ['src/**/*.ts', 'src/**/*.tsx', 'api/**/*.ts'],
      exclude: [
        'src/__tests__/**',
        'api/__tests__/**',
        'api/**/*.{test,spec}.{ts,tsx}',
        'src/vite-env.d.ts',
        'src/types.ts',
        'src/types/**',
        'src/constants.ts',
        'src/themes.ts',
        'src/main.tsx',
        'src/App.tsx',
        // Pure type-only modules — no executable statements; v8 reports
        // 0/0 which renders as 0% in the coverage table.
        'src/components/SettlementCheck/types.ts',
        'src/components/DeltaRegimeGuide/types.ts',
        'src/components/ChartAnalysis/types.ts',
        'src/components/PositionMonitor/types.ts',
        'src/components/GexLandscape/types.ts',
        'src/utils/futures-gamma/types.ts',
        'src/utils/gex-target/types.ts',
        'api/_lib/uw-result.ts',
        'src/types/index.ts',
        // Barrel re-export only.
        'src/utils/calculator.ts',
        'src/utils/export/index.ts',
        'src/utils/gex-target/index.ts',
        'src/components/ui/index.tsx',
        'api/_lib/validation.ts',
        'api/_lib/api-helpers.ts', // re-exports auth-helpers, uw-fetch, cron-helpers, schwab-fetch
        'api/_lib/csv-parser.ts', // re-exports csv-parser/parse + csv-parser/summary
        'src/components/OpeningFlowSignal/index.ts',
        'src/components/PeriscopeLottery/types.ts',
        'src/components/GammaNodeDetector/index.tsx',
      ],
    },
  },
});
