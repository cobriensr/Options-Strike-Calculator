import { describe, it, expect } from 'vitest';
import { MAX_CSV_UPLOAD_BYTES, validateUploadFile } from '../upload-validate';

function fileOfSize(bytes: number): File {
  const f = new File(['x'], 'positions.csv', { type: 'text/csv' });
  Object.defineProperty(f, 'size', { value: bytes });
  return f;
}

describe('validateUploadFile', () => {
  it('accepts files at or under the cap', () => {
    expect(validateUploadFile(fileOfSize(1024))).toBeNull();
    expect(validateUploadFile(fileOfSize(MAX_CSV_UPLOAD_BYTES))).toBeNull();
  });

  it('rejects files over the cap with a human-readable error', () => {
    const err = validateUploadFile(fileOfSize(MAX_CSV_UPLOAD_BYTES + 1));
    expect(err).toMatch(/too large/i);
    expect(err).toMatch(/5 MB/);
  });
});
