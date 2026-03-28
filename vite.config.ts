import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { visualizer } from 'rollup-plugin-visualizer';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { vercelToolbar } from '@vercel/toolbar/plugins/vite';
import { resolve } from 'node:path';

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
    }),
    VitePWA({
      registerType: 'autoUpdate',
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
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/149e9513-01fa-4fb0-aad4-566afd725d1b\//,
        ],
        globPatterns: ['**/*.{js,css,html,png,woff2}'],
        runtimeCaching: [
          {
            // Bypass the service worker entirely for API calls.
            // Without this, Chrome's 5-min SW fetch-event timeout kills
            // long-running requests (like Claude Opus analysis) at 300s.
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
            method: 'POST',
          },
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
            method: 'GET',
          },
          {
            urlPattern: /\/vix-data\.json$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'vix-data-cache',
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-stylesheets',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: {
                maxEntries: 30,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
    }),
  ],
  define: {
    // Expose SENTRY_DSN to client (Vercel sets SENTRY_DSN, Vite needs VITE_ prefix)
    'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(
      process.env.SENTRY_DSN ?? '',
    ),
  },
  build: {
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          sentry: ['@sentry/react'],
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
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'api/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
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
        'src/components/SettlementCheck/types.ts',
        'src/components/DeltaRegimeGuide/types.ts',
        'src/components/ChartAnalysis/types.ts',
        'src/utils/calculator.ts', // barrel re-export only
      ],
    },
  },
});
