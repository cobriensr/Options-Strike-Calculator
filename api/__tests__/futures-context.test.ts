// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatFuturesForClaude } from '../_lib/futures-context.js';

// ── Mock logger so debug calls don't pollute output ──────────
vi.mock('../_lib/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Types matching the module's internal shapes ──────────────

interface SnapshotRow {
  symbol: string;
  price: string;
  change_1h_pct: string | null;
  change_day_pct: string | null;
  volume_ratio: string | null;
}

interface EsOptionsRow {
  strike: string;
  option_type: string;
  open_interest: string | null;
  volume: string | null;
}

// ── Helpers ──────────────────────────────────────────────────

function makeSnapshot(
  symbol: string,
  overrides: Partial<SnapshotRow> = {},
): SnapshotRow {
  return {
    symbol,
    price: '5700.00',
    change_1h_pct: '0.15',
    change_day_pct: '-0.30',
    volume_ratio: '1.1',
    ...overrides,
  };
}

function makeEsOption(
  overrides: Partial<EsOptionsRow> = {},
): EsOptionsRow {
  return {
    strike: '5700',
    option_type: 'P',
    open_interest: '25000',
    volume: '4500',
    ...overrides,
  };
}

const analysisDate = '2026-04-05';

// ── Mock sql (tagged template literal) ───────────────────────

let mockSql: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockSql = vi.fn();
});

// ============================================================
// TESTS
// ============================================================

describe('formatFuturesForClaude', () => {
  // ── Error handling ───────────────────────────────────────

  it('returns null when futures_snapshots table does not exist', async () => {
    mockSql.mockRejectedValueOnce(
      new Error('relation "futures_snapshots" does not exist'),
    );

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
    );

    expect(result).toBeNull();
  });

  it('returns null when no snapshot rows exist', async () => {
    mockSql.mockResolvedValueOnce([]); // snapshots query

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
    );

    expect(result).toBeNull();
  });

  // ── ES section ───────────────────────────────────────────

  it('formats ES section with momentum and basis', async () => {
    const es = makeSnapshot('ES', {
      price: '5720.50',
      change_1h_pct: '0.25',
      change_day_pct: '-0.40',
      volume_ratio: '1.5',
    });
    mockSql.mockResolvedValueOnce([es]); // snapshots
    mockSql.mockResolvedValueOnce([]); // options (empty)

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
      5719,
    );

    expect(result).not.toBeNull();
    expect(result).toContain('ES Futures (/ES)');
    expect(result).toContain('+0.25%'); // 1H
    expect(result).toContain('-0.40%'); // Day
    expect(result).toContain('Volume Ratio');
    expect(result).toContain('ES-SPX Basis');
    expect(result).toContain('normal'); // 5720.50 - 5719 = 1.50 pts ≤ 2 → normal
  });

  it('omits ES-SPX basis when spxPrice is not provided', async () => {
    const es = makeSnapshot('ES', { price: '5720.50' });
    mockSql.mockResolvedValueOnce([es]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
    );

    expect(result).not.toBeNull();
    expect(result).not.toContain('ES-SPX Basis');
  });

  // ── NQ section with NQ/ES ratio ─────────────────────────

  it('formats NQ section with NQ/ES ratio and direction', async () => {
    const es = makeSnapshot('ES', {
      price: '5700.00',
      change_day_pct: '0.50',
    });
    const nq = makeSnapshot('NQ', {
      price: '20500.00',
      change_1h_pct: '0.30',
      change_day_pct: '0.80',
    });
    mockSql.mockResolvedValueOnce([es, nq]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
    );

    expect(result).not.toBeNull();
    expect(result).toContain('NQ Futures (/NQ)');
    expect(result).toContain('NQ/ES Ratio');
    // 20500 / 5700 = 3.596
    expect(result).toContain('3.596');
    // Both day changes positive → ALIGNED
    expect(result).toContain('ALIGNED');
  });

  it('shows NQ-ES DIVERGING when day directions differ', async () => {
    const es = makeSnapshot('ES', {
      price: '5700.00',
      change_day_pct: '-0.30',
    });
    const nq = makeSnapshot('NQ', {
      price: '20500.00',
      change_day_pct: '0.50',
    });
    mockSql.mockResolvedValueOnce([es, nq]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
    );

    expect(result).toContain('DIVERGING');
  });

  // ── VX section with term structure ──────────────────────

  it('formats VX section with CONTANGO signal', async () => {
    const vxm1 = makeSnapshot('VXM1', { price: '18.00' });
    const vxm2 = makeSnapshot('VXM2', { price: '19.50' });
    mockSql.mockResolvedValueOnce([vxm1, vxm2]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
    );

    expect(result).toContain('VIX Futures (/VXM)');
    expect(result).toContain('CONTANGO');
    // 18.00 - 19.50 = -1.50 → < -0.25 → CONTANGO
    expect(result).toContain('premium selling');
  });

  it('formats VX section with BACKWARDATION signal', async () => {
    const vxm1 = makeSnapshot('VXM1', { price: '22.00' });
    const vxm2 = makeSnapshot('VXM2', { price: '20.00' });
    mockSql.mockResolvedValueOnce([vxm1, vxm2]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
    );

    expect(result).toContain('BACKWARDATION');
    // 22 - 20 = +2.00 → > 0.25 → BACKWARDATION
    expect(result).toContain('Near-term stress');
  });

  it('formats VX section with FLAT term structure', async () => {
    const vxm1 = makeSnapshot('VXM1', { price: '19.10' });
    const vxm2 = makeSnapshot('VXM2', { price: '19.00' });
    mockSql.mockResolvedValueOnce([vxm1, vxm2]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
    );

    expect(result).toContain('FLAT');
    // 19.10 - 19.00 = 0.10 → abs ≤ 0.25 → FLAT
    expect(result).not.toContain('premium selling');
    expect(result).not.toContain('Near-term stress');
  });

  // ── ZN section with flight-to-safety ────────────────────

  it('formats ZN section with flight-to-safety signal', async () => {
    const es = makeSnapshot('ES', {
      price: '5700.00',
      change_day_pct: '-0.50',
    });
    const zn = makeSnapshot('ZN', {
      price: '110.50',
      change_1h_pct: '0.10',
      change_day_pct: '0.30',
    });
    mockSql.mockResolvedValueOnce([es, zn]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
    );

    expect(result).toContain('10Y Treasury (/ZN)');
    // ZN day +0.30 > 0.1 && ES day -0.50 < -0.2 → flight to safety
    expect(result).toContain('FLIGHT TO SAFETY');
  });

  it('detects broad liquidation when bonds and equities both sell', async () => {
    const es = makeSnapshot('ES', {
      price: '5700.00',
      change_day_pct: '-0.50',
    });
    const zn = makeSnapshot('ZN', {
      price: '109.00',
      change_day_pct: '-0.30',
    });
    mockSql.mockResolvedValueOnce([es, zn]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
    );

    expect(result).toContain('Broad liquidation');
  });

  it('shows ZN flat signal when ZN change is negligible', async () => {
    const es = makeSnapshot('ES', {
      price: '5700.00',
      change_day_pct: '-0.50',
    });
    const zn = makeSnapshot('ZN', {
      price: '110.00',
      change_day_pct: '0.05',
    });
    mockSql.mockResolvedValueOnce([es, zn]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
    );

    expect(result).toContain('ZN flat');
    expect(result).toContain('not macro-driven');
  });

  // ── CL section with vol signals ─────────────────────────

  it('formats CL section with vol compression signal', async () => {
    const cl = makeSnapshot('CL', {
      price: '72.50',
      change_1h_pct: '-0.10',
      change_day_pct: '-2.50',
    });
    mockSql.mockResolvedValueOnce([cl]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
    );

    expect(result).toContain('Crude Oil (/CL)');
    // day change -2.50 < -2 → vol compression signal
    expect(result).toContain('vol compression favorable');
  });

  it('formats CL section with vol expansion signal', async () => {
    const cl = makeSnapshot('CL', {
      price: '80.00',
      change_day_pct: '3.00',
    });
    mockSql.mockResolvedValueOnce([cl]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
    );

    // day change +3.00 > 2 → vol expansion signal
    expect(result).toContain('vol expansion likely');
  });

  // ── ES Options institutional activity ───────────────────

  it('includes ES options institutional activity', async () => {
    const es = makeSnapshot('ES', { price: '5700.00' });
    mockSql.mockResolvedValueOnce([es]); // snapshots

    const putOption = makeEsOption({
      strike: '5650',
      option_type: 'P',
      open_interest: '150000',
    });
    const callOption = makeEsOption({
      strike: '5750',
      option_type: 'C',
      open_interest: '120000',
    });
    mockSql.mockResolvedValueOnce([putOption, callOption]); // options

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
    );

    expect(result).toContain('ES Options Institutional Activity');
    expect(result).toContain('Top Put OI: 5650P');
    expect(result).toContain('150.0K OI');
    expect(result).toContain('Top Call OI: 5750C');
    expect(result).toContain('120.0K OI');
  });

  it('gracefully handles futures_options_daily table missing', async () => {
    const es = makeSnapshot('ES', { price: '5700.00' });
    mockSql.mockResolvedValueOnce([es]); // snapshots OK
    mockSql.mockRejectedValueOnce(
      new Error('relation "futures_options_daily" does not exist'),
    ); // options fails

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
    );

    // Should still return ES data, just without options section
    expect(result).not.toBeNull();
    expect(result).toContain('ES Futures (/ES)');
    expect(result).not.toContain('ES Options Institutional Activity');
  });

  // ── Partial data ────────────────────────────────────────

  it('handles partial data with only some symbols present', async () => {
    const es = makeSnapshot('ES', { price: '5700.00' });
    const cl = makeSnapshot('CL', { price: '75.00' });
    // Only ES and CL, no NQ/VX/ZN/RTY
    mockSql.mockResolvedValueOnce([es, cl]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
    );

    expect(result).not.toBeNull();
    expect(result).toContain('ES Futures (/ES)');
    expect(result).toContain('Crude Oil (/CL)');
    expect(result).not.toContain('NQ Futures');
    expect(result).not.toContain('VIX Futures');
    expect(result).not.toContain('10Y Treasury');
    expect(result).not.toContain('Russell 2000');
  });

  // ── Output structure ────────────────────────────────────

  it('wraps output in Futures Context header', async () => {
    const es = makeSnapshot('ES', { price: '5700.00' });
    mockSql.mockResolvedValueOnce([es]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
    );

    expect(result).toMatch(/^## Futures Context\n\n/);
  });
});
