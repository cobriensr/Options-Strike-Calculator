import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { visualizer } from 'rollup-plugin-visualizer';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { vercelToolbar } from '@vercel/toolbar/plugins/vite';

const analyze = process.env.ANALYZE === 'true';

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
          if (
            id.includes('node_modules/react') ||
            id.includes('node_modules/scheduler')
          )
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
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    testTimeout: 15_000,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'api/**/*.{test,spec}.{ts,tsx}',
      'daemon/__tests__/**/*.{test,spec}.{ts,tsx}',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', 'src/**/*.tsx', 'api/**/*.ts'],
      exclude: [
        'src/__tests__/**',
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
        'src/components/IVAnomalies/types.ts',
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
        'api/bwb-anchor.ts', // integration-tested via API
        'src/components/OpeningFlowSignal/index.ts',
        'src/components/PeriscopeLottery/types.ts',
        'src/components/GammaNodeDetector/index.tsx',
      ],
    },
  },
});
