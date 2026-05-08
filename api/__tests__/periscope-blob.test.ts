// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------
// Mocks
// ---------------------------------------------------------

const { mockPut, mockRandomUUID } = vi.hoisted(() => ({
  mockPut: vi.fn(),
  mockRandomUUID: vi.fn(() => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
}));

vi.mock('@vercel/blob', () => ({
  put: mockPut,
}));

vi.mock('node:crypto', async () => {
  const actual =
    await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return {
    ...actual,
    randomUUID: mockRandomUUID,
  };
});

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
}));

import { uploadPeriscopeImages } from '../_lib/periscope-blob.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

// 1×1 transparent PNG, base64-encoded — used when test only cares about the
// upload call shape, not pixel content.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// ---------------------------------------------------------
// Tests
// ---------------------------------------------------------

describe('uploadPeriscopeImages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRandomUUID.mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('returns {} and logs error for invalid capturedAt; never calls put()', async () => {
    const result = await uploadPeriscopeImages({
      capturedAt: 'not-a-date',
      images: [{ kind: 'chart', base64: TINY_PNG_B64 }],
    });

    expect(result).toEqual({});
    expect(mockPut).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.error).mock.calls[0]?.[1]).toMatch(
      /invalid capturedAt/i,
    );
  });

  it('returns {} for empty images array; never calls put()', async () => {
    const result = await uploadPeriscopeImages({
      capturedAt: '2026-05-08T13:30:45.000Z',
      images: [],
    });

    expect(result).toEqual({});
    expect(mockPut).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('returns urls for all 3 kinds when all uploads succeed', async () => {
    mockPut
      .mockResolvedValueOnce({ url: 'https://blob.test/chart.png' })
      .mockResolvedValueOnce({ url: 'https://blob.test/gex.png' })
      .mockResolvedValueOnce({ url: 'https://blob.test/charm.png' });

    const result = await uploadPeriscopeImages({
      capturedAt: '2026-05-08T13:30:45.000Z',
      images: [
        { kind: 'chart', base64: TINY_PNG_B64 },
        { kind: 'gex', base64: TINY_PNG_B64 },
        { kind: 'charm', base64: TINY_PNG_B64 },
      ],
    });

    expect(result).toEqual({
      chart: 'https://blob.test/chart.png',
      gex: 'https://blob.test/gex.png',
      charm: 'https://blob.test/charm.png',
    });
    expect(mockPut).toHaveBeenCalledTimes(3);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('returns the successful url, captures the failure on Sentry, and logs error when one upload fails', async () => {
    const err = new Error('blob 500');
    mockPut
      .mockResolvedValueOnce({ url: 'https://blob.test/chart.png' })
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ url: 'https://blob.test/charm.png' });

    const result = await uploadPeriscopeImages({
      capturedAt: '2026-05-08T13:30:45.000Z',
      images: [
        { kind: 'chart', base64: TINY_PNG_B64 },
        { kind: 'gex', base64: TINY_PNG_B64 },
        { kind: 'charm', base64: TINY_PNG_B64 },
      ],
    });

    // Successful uploads kept.
    expect(result).toEqual({
      chart: 'https://blob.test/chart.png',
      charm: 'https://blob.test/charm.png',
    });
    expect(result.gex).toBeUndefined();

    // Failure captured.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [errCtx, errMsg] = vi.mocked(logger.error).mock.calls[0]!;
    expect(errCtx).toMatchObject({ kind: 'gex', err });
    expect(errMsg).toMatch(/Periscope blob upload failed/);
  });

  it('builds path with periscope/{YYYY-MM-DD}/{HHmmss}-{uuid}/{kind}.png shape', async () => {
    mockPut.mockResolvedValue({ url: 'https://blob.test/x.png' });

    await uploadPeriscopeImages({
      capturedAt: '2026-05-08T13:30:45.000Z',
      images: [{ kind: 'chart', base64: TINY_PNG_B64 }],
    });

    const expectedPath =
      'periscope/2026-05-08/133045-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/chart.png';
    expect(mockPut).toHaveBeenCalledTimes(1);
    const [path] = mockPut.mock.calls[0]!;
    expect(path).toBe(expectedPath);
    // Independent regex check — guards against drift in the format string.
    expect(path).toMatch(
      /^periscope\/\d{4}-\d{2}-\d{2}\/\d{6}-[0-9a-f-]{36}\/chart\.png$/,
    );
  });

  it('passes options { access: "private", contentType: "image/png" } to put()', async () => {
    mockPut.mockResolvedValue({ url: 'https://blob.test/x.png' });

    await uploadPeriscopeImages({
      capturedAt: '2026-05-08T13:30:45.000Z',
      images: [{ kind: 'gex', base64: TINY_PNG_B64 }],
    });

    const [, body, opts] = mockPut.mock.calls[0]!;
    expect(opts).toMatchObject({
      access: 'private',
      contentType: 'image/png',
    });
    // Body must be a Buffer (Node) so the @vercel/blob SDK serializes
    // bytes, not a base64 string.
    expect(Buffer.isBuffer(body)).toBe(true);
  });

  it('zero-pads single-digit hour/minute/second components in the path', async () => {
    mockPut.mockResolvedValue({ url: 'https://blob.test/x.png' });

    await uploadPeriscopeImages({
      capturedAt: '2026-01-02T03:04:05.000Z',
      images: [{ kind: 'chart', base64: TINY_PNG_B64 }],
    });

    const [path] = mockPut.mock.calls[0]!;
    // 03:04:05 UTC → "030405" — confirms .padStart(2, '0') on each part.
    expect(path).toContain('periscope/2026-01-02/030405-');
  });
});
