// @vitest-environment node

/**
 * Phase 4b integration tests for `fetchMicrostructureBlock`.
 *
 * Verifies that the analyze-context fetcher threads the sidecar's 1h
 * OFI percentile-rank result through to the dual-symbol formatter,
 * matching the spec's "Historical rank: Nth percentile of the last N
 * days" rendering. The full `buildAnalysisContext` integration test
 * mocks the whole microstructure module, so these targeted tests are
 * the only coverage of the live-signal → percentile → formatter wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We stub both the live-signal compute and the sidecar fetch at the
// module boundary. The SUT orchestrates the two in parallel and
// passes the combined result into the real formatter.
vi.mock('../_lib/microstructure-signals.js', async () => {
  const actual = await vi.importActual<
    typeof import('../_lib/microstructure-signals.js')
  >('../_lib/microstructure-signals.js');
  return {
    ...actual,
    // Only the "compute" entry point gets replaced — the formatter
    // stays real so we can assert against its actual output.
    computeAllSymbolSignals: vi.fn(),
  };
});

vi.mock('../_lib/archive-sidecar.js', () => ({
  fetchTbboOfiPercentile: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { increment: vi.fn() },
}));

import { computeAllSymbolSignals } from '../_lib/microstructure-signals.js';
import { fetchTbboOfiPercentile } from '../_lib/archive-sidecar.js';
import { fetchMicrostructureBlock } from '../_lib/analyze-context-fetchers.js';

const SAMPLE_ES = {
  symbol: 'ES',
  ofi1m: 0.1,
  ofi5m: 0.12,
  ofi1h: 0.15,
  spreadZscore: 0.2,
  tobPressure: 1.05,
  composite: 'BALANCED' as const,
  computedAt: '2026-04-19T14:30:00.000Z',
};
const SAMPLE_NQ = {
  symbol: 'NQ',
  ofi1m: 0.35,
  ofi5m: 0.38,
  ofi1h: 0.38,
  spreadZscore: 0.25,
  tobPressure: 1.6,
  composite: 'AGGRESSIVE_BUY' as const,
  computedAt: '2026-04-19T14:30:00.000Z',
};

describe('fetchMicrostructureBlock — percentile enrichment (Phase 4b)', () => {
  beforeEach(() => {
    vi.mocked(computeAllSymbolSignals).mockReset();
    vi.mocked(fetchTbboOfiPercentile).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('threads the sidecar percentile rank into the rendered block', async () => {
    vi.mocked(computeAllSymbolSignals).mockResolvedValueOnce({
      es: SAMPLE_ES,
      nq: SAMPLE_NQ,
    });
    vi.mocked(fetchTbboOfiPercentile).mockImplementation(
      async (symbol: 'ES' | 'NQ', value: number) => ({
        symbol,
        window: '1h',
        current_value: value,
        percentile: symbol === 'NQ' ? 92.1 : 55.0,
        mean: 0.02,
        std: 0.09,
        count: 252,
      }),
    );

    const out = await fetchMicrostructureBlock();
    expect(out).not.toBeNull();

    // Both symbols have the Historical rank line, with correct ordinals.
    expect(out).toContain(
      'Historical rank: 55th percentile of the last 252 days',
    );
    expect(out).toContain(
      'Historical rank: 92nd percentile of the last 252 days',
    );

    // Called once per symbol, with each symbol's 1h OFI value.
    const calls = vi.mocked(fetchTbboOfiPercentile).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual(['ES', 0.15, '1h']);
    expect(calls).toContainEqual(['NQ', 0.38, '1h']);
  });

  it('omits the Historical rank line when the sidecar returns null', async () => {
    vi.mocked(computeAllSymbolSignals).mockResolvedValueOnce({
      es: SAMPLE_ES,
      nq: SAMPLE_NQ,
    });
    vi.mocked(fetchTbboOfiPercentile).mockResolvedValue(null);

    const out = await fetchMicrostructureBlock();
    expect(out).not.toBeNull();
    expect(out).not.toContain('Historical rank');
    // Live signal block still renders as before — backward compat.
    expect(out).toContain('OFI 1h: +0.15 → BALANCED');
    expect(out).toContain('OFI 1h: +0.38 → AGGRESSIVE_BUY');
  });

  it('keeps one side when the other side rejects (fault isolation)', async () => {
    vi.mocked(computeAllSymbolSignals).mockResolvedValueOnce({
      es: SAMPLE_ES,
      nq: SAMPLE_NQ,
    });
    vi.mocked(fetchTbboOfiPercentile).mockImplementation(
      async (symbol: 'ES' | 'NQ', value: number) => {
        if (symbol === 'ES') {
          throw new Error('ES sidecar lane flaked');
        }
        return {
          symbol,
          window: '1h',
          current_value: value,
          percentile: 88,
          mean: 0.02,
          std: 0.09,
          count: 252,
        };
      },
    );

    const out = await fetchMicrostructureBlock();
    expect(out).not.toBeNull();
    // ES percentile line missing, NQ present.
    expect(out).toMatch(
      /ES \(latest front-month\):\n\s+OFI 1h: \+0\.15 → BALANCED\n\s+OFI 5m:/,
    );
    expect(out).toContain(
      'Historical rank: 88th percentile of the last 252 days',
    );
  });

  it('skips the sidecar fetch entirely when both ofi1h values are null', async () => {
    vi.mocked(computeAllSymbolSignals).mockResolvedValueOnce({
      es: { ...SAMPLE_ES, ofi1h: null },
      nq: { ...SAMPLE_NQ, ofi1h: null },
    });

    const out = await fetchMicrostructureBlock();
    expect(out).not.toBeNull();
    expect(vi.mocked(fetchTbboOfiPercentile)).not.toHaveBeenCalled();
    expect(out).not.toContain('Historical rank');
  });
});
