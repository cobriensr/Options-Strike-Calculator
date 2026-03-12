import '@testing-library/jest-dom/vitest';

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
