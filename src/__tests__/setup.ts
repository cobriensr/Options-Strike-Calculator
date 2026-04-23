import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Vitest doesn't auto-run @testing-library's cleanup (unlike Jest). Without
// this, every render()/renderHook() call leaves React roots + JSDOM mounts
// allocated for the entire test run, accumulating into gigabytes across
// ~7700 tests and eventually blowing past the Node heap ceiling in CI.
// See the April 2026 CI OOM investigation.
afterEach(() => {
  cleanup();
});

// jsdom doesn't implement createImageBitmap / OffscreenCanvas — stub them for compressImage()
if (typeof globalThis.createImageBitmap !== 'function') {
  globalThis.createImageBitmap = async () =>
    ({ width: 800, height: 600, close() {} }) as unknown as ImageBitmap;
}

if (typeof globalThis.OffscreenCanvas !== 'function') {
  globalThis.OffscreenCanvas = class OffscreenCanvas {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      return { drawImage() {} };
    }
    convertToBlob() {
      return Promise.resolve(new Blob(['fake'], { type: 'image/jpeg' }));
    }
  } as unknown as typeof globalThis.OffscreenCanvas;
}

// jsdom doesn't implement Blob.prototype.text() — polyfill for CSV upload tests
if (typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () =>
        reject(reader.error ?? new Error('FileReader failed'));
      reader.readAsText(this);
    });
  };
}
