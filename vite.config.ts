import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
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
        navigateFallbackDenylist: [/^\/api\//],
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
            handler: 'NetworkFirst',
            options: {
              cacheName: 'google-fonts-stylesheets',
              networkTimeoutSeconds: 5,
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
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
        },
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
    exclude: ['src/__tests__/App.test.tsx'],
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
        'src/utils/calculator.ts', // barrel re-export only
      ],
    },
  },
});
