import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/__tests__/**', 'src/vite-env.d.ts', 'src/calculator.ts', 'src/csvParser.ts', 'src/exportXlsx.ts', 'src/vixStorage.ts', 'src/types.ts', 'src/constants.ts', 'src/themes.ts', 'src/main.tsx'],
    },
  },
});