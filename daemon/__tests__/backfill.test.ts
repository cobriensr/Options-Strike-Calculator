/**
 * Unit tests for `processSlot` — the per-slot orchestration extracted
 * from backfill.ts main(). Each test mocks the module-level dependencies
 * (neon, runCapture, fetchGexLandscape, postTraceLiveAnalyze) and asserts
 * the discriminated outcome routing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// Hoisted mocks — must be defined BEFORE the imports that use them.
const mockNeonRows = vi.hoisted(() => ({ rows: [] as unknown[] }));
const mockRunCapture = vi.hoisted(() => vi.fn());
const mockFetchGex = vi.hoisted(() => vi.fn());
const mockPost = vi.hoisted(() => vi.fn());

vi.mock('@neondatabase/serverless', () => ({
  neon: () => {
    return (..._args: unknown[]) => Promise.resolve(mockNeonRows.rows);
  },
}));

vi.mock('../src/capture.js', () => ({
  runCapture: mockRunCapture,
}));

vi.mock('../src/gex.js', () => ({
  fetchGexLandscape: mockFetchGex,
}));

vi.mock('../src/api-client.js', () => ({
  postTraceLiveAnalyze: mockPost,
}));

// Dynamic import after mocks are wired up.
const { processSlot } = await import('../src/backfill.js');

const makeLogger = (): Logger => {
  const noop = vi.fn();
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => makeLogger(),
  } as unknown as Logger;
};

const slot = { hourCt: 9, minuteCt: 35, hhmm: '09:35' };
const config = {
  databaseUrl: 'postgres://test',
  endpoint: 'https://example.com/api/trace-live-analyze',
  ownerSecret: 'secret',
  logLevel: 'info' as const,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe('processSlot', () => {
  beforeEach(() => {
    mockNeonRows.rows = [];
    mockRunCapture.mockReset();
    mockFetchGex.mockReset();
    mockPost.mockReset();
  });

  it('returns alreadyDone when a row already exists for the slot', async () => {
    mockNeonRows.rows = [{ exists: 1 }];
    const result = await processSlot(slot, config, makeLogger(), '2026-04-22');
    expect(result.outcome).toBe('alreadyDone');
    expect(mockRunCapture).not.toHaveBeenCalled();
  });

  it('returns skipped when fetchGexLandscape returns null', async () => {
    mockNeonRows.rows = []; // no existing row
    mockRunCapture.mockResolvedValueOnce({
      capturedAt: '2026-04-22T13:35:00Z',
      spot: 5800,
      stabilityPct: 50,
      images: { gamma: 'g', charm: 'c', delta: 'd' },
    });
    mockFetchGex.mockResolvedValueOnce(null);

    const result = await processSlot(slot, config, makeLogger(), '2026-04-22');
    expect(result.outcome).toBe('skipped');
    if (result.outcome === 'skipped') {
      expect(result.reason).toBe('no-gex-snapshot');
    }
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('returns succeeded when capture + gex + post all succeed', async () => {
    mockNeonRows.rows = []; // no existing row
    mockRunCapture.mockResolvedValueOnce({
      capturedAt: '2026-04-22T13:35:00Z',
      spot: 5800,
      stabilityPct: 50,
      images: { gamma: 'g', charm: 'c', delta: 'd' },
    });
    mockFetchGex.mockResolvedValueOnce({
      regime: 'positive_gamma',
      netGex: 100,
      totalPosGex: 200,
      totalNegGex: -100,
      atmStrike: 5800,
      driftTargetsUp: [5810],
      driftTargetsDown: [5790],
      strikes: [],
      snapshotSpot: 5800,
      snapshotTs: '2026-04-22T13:35:00Z',
    });
    mockPost.mockResolvedValueOnce({ ok: true });

    const result = await processSlot(slot, config, makeLogger(), '2026-04-22');
    expect(result.outcome).toBe('succeeded');
    if (result.outcome === 'succeeded') {
      expect(result.capturedAt).toBe('2026-04-22T13:35:00Z');
    }
    expect(mockPost).toHaveBeenCalledOnce();
  });

  it('returns failed when runCapture throws', async () => {
    mockNeonRows.rows = []; // no existing row
    mockRunCapture.mockRejectedValueOnce(new Error('browserless boom'));

    const result = await processSlot(slot, config, makeLogger(), '2026-04-22');
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe('browserless boom');
    }
  });

  it('returns failed when postTraceLiveAnalyze throws', async () => {
    mockNeonRows.rows = []; // no existing row
    mockRunCapture.mockResolvedValueOnce({
      capturedAt: '2026-04-22T13:35:00Z',
      spot: 5800,
      stabilityPct: 50,
      images: { gamma: 'g', charm: 'c', delta: 'd' },
    });
    mockFetchGex.mockResolvedValueOnce({
      regime: 'positive_gamma',
      netGex: 100,
      totalPosGex: 200,
      totalNegGex: -100,
      atmStrike: 5800,
      driftTargetsUp: [5810],
      driftTargetsDown: [5790],
      strikes: [],
      snapshotSpot: 5800,
      snapshotTs: '2026-04-22T13:35:00Z',
    });
    mockPost.mockRejectedValueOnce(new Error('429 rate limit'));

    const result = await processSlot(slot, config, makeLogger(), '2026-04-22');
    expect(result.outcome).toBe('failed');
  });
});
