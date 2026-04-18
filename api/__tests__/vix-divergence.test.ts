// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

import {
  computeVixSpxDivergence,
  formatVixDivergenceForClaude,
} from '../_lib/vix-divergence.js';

/**
 * The helper issues four queries in parallel:
 *   1. VIX at now       (market_snapshots)
 *   2. VIX at now - 5m  (market_snapshots)
 *   3. SPX at now       (spx_candles_1m)
 *   4. SPX at now - 5m  (spx_candles_1m)
 *
 * We identify which query is which by sniffing the SQL template
 * strings (VIX queries contain "market_snapshots", SPX queries contain
 * "spx_candles_1m") and the `at` parameter (latest vs 5-min prior).
 */

interface Stub {
  source: 'vix' | 'spx';
  lookbackMs: 0 | 300_000;
  value: number | null;
}

function stub(stubs: Stub[]) {
  mockSql.mockImplementation(
    async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const sqlText = strings.join('');
      const source: 'vix' | 'spx' = sqlText.includes('market_snapshots')
        ? 'vix'
        : 'spx';
      const [atIso] = params as [string];
      const diff = Date.now() - new Date(atIso).getTime();
      const lookbackMs: 0 | 300_000 = diff < 150_000 ? 0 : 300_000;

      const match = stubs.find(
        (s) => s.source === source && s.lookbackMs === lookbackMs,
      );
      if (!match || match.value == null) return [];
      return source === 'vix'
        ? [{ vix: String(match.value) }]
        : [{ close: String(match.value) }];
    },
  );
}

describe('computeVixSpxDivergence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flags divergence when VIX > 3% and SPX < 0.1%', async () => {
    stub([
      { source: 'vix', lookbackMs: 0, value: 20.6 },
      { source: 'vix', lookbackMs: 300_000, value: 20.0 }, // +3.0% (just at threshold)
      { source: 'spx', lookbackMs: 0, value: 5001 },
      { source: 'spx', lookbackMs: 300_000, value: 5000 }, // +0.02%
    ]);
    const now = new Date();

    // Use a slightly larger VIX move to clear the strict > threshold
    stub([
      { source: 'vix', lookbackMs: 0, value: 20.8 }, // +4.0%
      { source: 'vix', lookbackMs: 300_000, value: 20.0 },
      { source: 'spx', lookbackMs: 0, value: 5001 }, // +0.02%
      { source: 'spx', lookbackMs: 300_000, value: 5000 },
    ]);

    const result = await computeVixSpxDivergence(now);
    expect(result).not.toBeNull();
    expect(result!.triggered).toBe(true);
    expect(result!.vixRet5m!).toBeGreaterThan(0.03);
    expect(Math.abs(result!.spxRet5m!)).toBeLessThan(0.001);
  });

  it('does not flag when SPX moves are large (both moving together)', async () => {
    stub([
      { source: 'vix', lookbackMs: 0, value: 21.0 }, // +5%
      { source: 'vix', lookbackMs: 300_000, value: 20.0 },
      { source: 'spx', lookbackMs: 0, value: 4975 }, // -0.5% — big move
      { source: 'spx', lookbackMs: 300_000, value: 5000 },
    ]);

    const result = await computeVixSpxDivergence(new Date());
    expect(result).not.toBeNull();
    expect(result!.triggered).toBe(false);
  });

  it('does not flag when VIX move is small', async () => {
    stub([
      { source: 'vix', lookbackMs: 0, value: 20.1 }, // +0.5%
      { source: 'vix', lookbackMs: 300_000, value: 20.0 },
      { source: 'spx', lookbackMs: 0, value: 5001 },
      { source: 'spx', lookbackMs: 300_000, value: 5000 },
    ]);

    const result = await computeVixSpxDivergence(new Date());
    expect(result).not.toBeNull();
    expect(result!.triggered).toBe(false);
  });

  it('returns null when both sources have no data', async () => {
    stub([]);
    const result = await computeVixSpxDivergence(new Date());
    expect(result).toBeNull();
  });

  it('returns a result with vixRet5m=null when only SPX has data', async () => {
    stub([
      { source: 'spx', lookbackMs: 0, value: 5001 },
      { source: 'spx', lookbackMs: 300_000, value: 5000 },
    ]);

    const result = await computeVixSpxDivergence(new Date());
    expect(result).not.toBeNull();
    expect(result!.vixRet5m).toBeNull();
    expect(result!.spxRet5m).not.toBeNull();
    expect(result!.triggered).toBe(false);
  });

  it('returns a result with spxRet5m=null when only VIX has data', async () => {
    stub([
      { source: 'vix', lookbackMs: 0, value: 20.8 },
      { source: 'vix', lookbackMs: 300_000, value: 20.0 },
    ]);

    const result = await computeVixSpxDivergence(new Date());
    expect(result).not.toBeNull();
    expect(result!.spxRet5m).toBeNull();
    expect(result!.vixRet5m).not.toBeNull();
    expect(result!.triggered).toBe(false);
  });

  it('handles zero prior VIX safely (no divide-by-zero)', async () => {
    stub([
      { source: 'vix', lookbackMs: 0, value: 20 },
      { source: 'vix', lookbackMs: 300_000, value: 0 },
      { source: 'spx', lookbackMs: 0, value: 5000 },
      { source: 'spx', lookbackMs: 300_000, value: 5000 },
    ]);

    const result = await computeVixSpxDivergence(new Date());
    expect(result).not.toBeNull();
    expect(result!.vixRet5m).toBeNull();
    expect(result!.triggered).toBe(false);
  });
});

describe('formatVixDivergenceForClaude', () => {
  it('returns null when input is null', () => {
    expect(formatVixDivergenceForClaude(null)).toBeNull();
  });

  it('prints both returns and the triggered banner when flag is true', () => {
    const output = formatVixDivergenceForClaude({
      triggered: true,
      vixRet5m: 0.045,
      spxRet5m: 0.0005,
      computedAt: '2026-04-18T15:30:00.000Z',
    });
    expect(output).not.toBeNull();
    expect(output).toContain('+4.50%');
    expect(output).toContain('+0.05%');
    expect(output).toContain('DIVERGENCE TRIGGERED');
  });

  it('prints the no-divergence message when flag is false', () => {
    const output = formatVixDivergenceForClaude({
      triggered: false,
      vixRet5m: 0.005,
      spxRet5m: 0.0005,
      computedAt: '2026-04-18T15:30:00.000Z',
    });
    expect(output).toContain('No divergence');
  });

  it('renders N/A when a return is null', () => {
    const output = formatVixDivergenceForClaude({
      triggered: false,
      vixRet5m: null,
      spxRet5m: 0.0005,
      computedAt: '2026-04-18T15:30:00.000Z',
    });
    expect(output).toContain('VIX 5-min return: N/A');
  });
});
