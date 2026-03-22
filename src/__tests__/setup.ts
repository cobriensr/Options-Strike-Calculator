import '@testing-library/jest-dom/vitest';

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
