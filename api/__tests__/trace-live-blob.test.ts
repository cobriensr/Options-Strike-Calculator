// @vitest-environment node

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { putMock } = vi.hoisted(() => ({ putMock: vi.fn() }));
vi.mock('@vercel/blob', () => ({
  put: putMock,
}));

vi.mock('../_lib/logger.js', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { increment: vi.fn() },
}));

import { uploadTraceLiveImages } from '../_lib/trace-live-blob.js';

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==',
  'base64',
).toString('base64');

beforeEach(() => {
  putMock.mockReset();
});

describe('uploadTraceLiveImages', () => {
  it('uploads all 3 images in parallel and returns full URL map on success', async () => {
    putMock
      .mockResolvedValueOnce({ url: 'https://blob/gamma-Az3kP9.png' })
      .mockResolvedValueOnce({ url: 'https://blob/charm-Bx4lQ0.png' })
      .mockResolvedValueOnce({ url: 'https://blob/delta-Cy5mR1.png' });

    const result = await uploadTraceLiveImages({
      capturedAt: '2026-04-23T19:30:00Z',
      images: [
        { chart: 'gamma', base64: tinyPng },
        { chart: 'charm', base64: tinyPng },
        { chart: 'delta', base64: tinyPng },
      ],
    });

    expect(result).toEqual({
      gamma: 'https://blob/gamma-Az3kP9.png',
      charm: 'https://blob/charm-Bx4lQ0.png',
      delta: 'https://blob/delta-Cy5mR1.png',
    });
    expect(putMock).toHaveBeenCalledTimes(3);
  });

  it('uses UTC date+HHmm in the path prefix (DST-irrelevant)', async () => {
    putMock.mockResolvedValueOnce({ url: 'u1' });
    await uploadTraceLiveImages({
      capturedAt: '2026-04-23T19:30:00Z',
      images: [{ chart: 'gamma', base64: tinyPng }],
    });
    const path = putMock.mock.calls[0]![0];
    expect(path).toBe('trace-live/2026-04-23/1930/gamma.png');
  });

  it('zero-pads single-digit hours and minutes', async () => {
    putMock.mockResolvedValueOnce({ url: 'u1' });
    await uploadTraceLiveImages({
      capturedAt: '2026-04-23T03:05:00Z',
      images: [{ chart: 'gamma', base64: tinyPng }],
    });
    const path = putMock.mock.calls[0]![0];
    expect(path).toBe('trace-live/2026-04-23/0305/gamma.png');
  });

  it('passes correct put() options (private, image/png, addRandomSuffix:true)', async () => {
    putMock.mockResolvedValueOnce({ url: 'u1' });
    await uploadTraceLiveImages({
      capturedAt: '2026-04-23T19:30:00Z',
      images: [{ chart: 'gamma', base64: tinyPng }],
    });
    const opts = putMock.mock.calls[0]![2];
    expect(opts.access).toBe('private');
    expect(opts.contentType).toBe('image/png');
    // addRandomSuffix: true is load-bearing — without it, @vercel/blob@2.x
    // produces deterministic guessable URLs and throws on retry for the
    // same minute (BlobError: blob already exists). See header comment.
    expect(opts.addRandomSuffix).toBe(true);
  });

  it('decodes base64 to a Buffer before uploading', async () => {
    putMock.mockResolvedValueOnce({ url: 'u1' });
    await uploadTraceLiveImages({
      capturedAt: '2026-04-23T19:30:00Z',
      images: [{ chart: 'gamma', base64: tinyPng }],
    });
    const body = putMock.mock.calls[0]![1];
    expect(Buffer.isBuffer(body)).toBe(true);
    expect((body as Buffer).length).toBeGreaterThan(0);
  });

  it('returns partial URL map when one upload fails (best-effort)', async () => {
    putMock
      .mockResolvedValueOnce({ url: 'https://blob/gamma.png' })
      .mockRejectedValueOnce(new Error('blob 503'))
      .mockResolvedValueOnce({ url: 'https://blob/delta.png' });

    const result = await uploadTraceLiveImages({
      capturedAt: '2026-04-23T19:30:00Z',
      images: [
        { chart: 'gamma', base64: tinyPng },
        { chart: 'charm', base64: tinyPng },
        { chart: 'delta', base64: tinyPng },
      ],
    });

    expect(result).toEqual({
      gamma: 'https://blob/gamma.png',
      delta: 'https://blob/delta.png',
    });
    expect(result.charm).toBeUndefined();
  });

  it('returns empty object when ALL uploads fail (still does not throw)', async () => {
    putMock
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockRejectedValueOnce(new Error('3'));

    const result = await uploadTraceLiveImages({
      capturedAt: '2026-04-23T19:30:00Z',
      images: [
        { chart: 'gamma', base64: tinyPng },
        { chart: 'charm', base64: tinyPng },
        { chart: 'delta', base64: tinyPng },
      ],
    });
    expect(result).toEqual({});
  });

  it('returns empty object on invalid capturedAt without calling put()', async () => {
    const result = await uploadTraceLiveImages({
      capturedAt: 'not-a-date',
      images: [{ chart: 'gamma', base64: tinyPng }],
    });
    expect(result).toEqual({});
    expect(putMock).not.toHaveBeenCalled();
  });

  it('handles a single image (no charm/delta)', async () => {
    putMock.mockResolvedValueOnce({ url: 'https://blob/gamma.png' });
    const result = await uploadTraceLiveImages({
      capturedAt: '2026-04-23T19:30:00Z',
      images: [{ chart: 'gamma', base64: tinyPng }],
    });
    expect(result).toEqual({ gamma: 'https://blob/gamma.png' });
    expect(putMock).toHaveBeenCalledTimes(1);
  });
});
