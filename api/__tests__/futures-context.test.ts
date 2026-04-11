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

function makeEsOption(overrides: Partial<EsOptionsRow> = {}): EsOptionsRow {
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

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toBeNull();
  });

  it('returns null when no snapshot rows exist', async () => {
    mockSql.mockResolvedValueOnce([]); // snapshots query

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

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

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

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

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

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

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('DIVERGING');
  });

  // ── VX section with term structure ──────────────────────

  it('formats VX section with CONTANGO signal', async () => {
    const vxm1 = makeSnapshot('VX1', { price: '18.00' });
    const vxm2 = makeSnapshot('VX2', { price: '19.50' });
    mockSql.mockResolvedValueOnce([vxm1, vxm2]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('VIX Futures (/VX)');
    expect(result).toContain('CONTANGO');
    // 18.00 - 19.50 = -1.50 → < -0.25 → CONTANGO
    expect(result).toContain('premium selling');
  });

  it('formats VX section with BACKWARDATION signal', async () => {
    const vxm1 = makeSnapshot('VX1', { price: '22.00' });
    const vxm2 = makeSnapshot('VX2', { price: '20.00' });
    mockSql.mockResolvedValueOnce([vxm1, vxm2]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('BACKWARDATION');
    // 22 - 20 = +2.00 → > 0.25 → BACKWARDATION
    expect(result).toContain('Near-term stress');
  });

  it('formats VX section with FLAT term structure', async () => {
    const vxm1 = makeSnapshot('VX1', { price: '19.10' });
    const vxm2 = makeSnapshot('VX2', { price: '19.00' });
    mockSql.mockResolvedValueOnce([vxm1, vxm2]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

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

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

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

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

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

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

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

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

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

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

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

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

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

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

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

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).not.toBeNull();
    expect(result).toContain('ES Futures (/ES)');
    expect(result).toContain('Crude Oil (/CL)');
    expect(result).not.toContain('NQ Futures');
    expect(result).not.toContain('VIX Futures');
    expect(result).not.toContain('10Y Treasury');
    expect(result).not.toContain('Russell 2000');
  });

  // ── RTY section ─────────────────────────────────────────────

  it('formats RTY section with aligned breadth signal', async () => {
    const es = makeSnapshot('ES', {
      price: '5700.00',
      change_day_pct: '0.40',
    });
    const rty = makeSnapshot('RTY', {
      price: '2100.00',
      change_1h_pct: '0.20',
      change_day_pct: '0.60',
    });
    mockSql.mockResolvedValueOnce([es, rty]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('Russell 2000 (/RTY)');
    // Both day changes positive → ALIGNED (broad move)
    expect(result).toContain('ALIGNED (broad move)');
  });

  it('formats RTY section with diverging breadth signal', async () => {
    const es = makeSnapshot('ES', {
      price: '5700.00',
      change_day_pct: '0.40',
    });
    const rty = makeSnapshot('RTY', {
      price: '2100.00',
      change_day_pct: '-0.30',
    });
    mockSql.mockResolvedValueOnce([es, rty]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    // ES positive, RTY negative → DIVERGING (narrow/fragile)
    expect(result).toContain('DIVERGING (narrow/fragile)');
  });

  // ── GC section ───────────────────────────────────────────────

  it('formats GC section with safe-haven bid signal', async () => {
    const es = makeSnapshot('ES', {
      price: '5700.00',
      change_day_pct: '-0.50',
    });
    const gc = makeSnapshot('GC', {
      price: '2900.00',
      change_1h_pct: '0.30',
      change_day_pct: '1.20',
    });
    mockSql.mockResolvedValueOnce([es, gc]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('Gold (/GC)');
    // gcDay > 0.5 && esDay < -0.2 → safe haven bid
    expect(result).toContain('SAFE HAVEN BID');
    expect(result).toContain('Fear-driven positioning');
  });

  it('formats GC with HIGH-CONVICTION flight to safety when ZN also bid', async () => {
    const es = makeSnapshot('ES', {
      price: '5700.00',
      change_day_pct: '-0.50',
    });
    const zn = makeSnapshot('ZN', {
      price: '110.00',
      change_day_pct: '0.30',
    });
    const gc = makeSnapshot('GC', {
      price: '2900.00',
      change_day_pct: '1.20',
    });
    mockSql.mockResolvedValueOnce([es, zn, gc]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    // Gold + ZN both up while ES down → HIGH-CONVICTION flight to safety
    expect(result).toContain('HIGH-CONVICTION flight to safety');
  });

  it('formats GC section with risk-on rotation signal', async () => {
    const es = makeSnapshot('ES', {
      price: '5700.00',
      change_day_pct: '0.50',
    });
    const gc = makeSnapshot('GC', {
      price: '2800.00',
      change_day_pct: '-1.00',
    });
    mockSql.mockResolvedValueOnce([es, gc]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    // gcDay < -0.5 && esDay > 0.2 → risk-on rotation
    expect(result).toContain('Risk-on rotation');
    expect(result).toContain('premium selling');
  });

  it('shows no signal on GC when moves are below threshold', async () => {
    const gc = makeSnapshot('GC', {
      price: '2850.00',
      change_day_pct: '0.10',
    });
    mockSql.mockResolvedValueOnce([gc]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('Gold (/GC)');
    // change < 0.5 → no signal
    expect(result).not.toContain('SAFE HAVEN BID');
    expect(result).not.toContain('Risk-on rotation');
  });

  // ── DX section ───────────────────────────────────────────────

  it('formats DX section with dollar strength signal', async () => {
    const dx = makeSnapshot('DX', {
      price: '104.50',
      change_1h_pct: '0.20',
      change_day_pct: '0.80',
    });
    mockSql.mockResolvedValueOnce([dx]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('US Dollar Index (/DX)');
    // dxDay > 0.5 → dollar strength
    expect(result).toContain('DOLLAR STRENGTH');
    expect(result).toContain('equity headwind');
  });

  it('formats DX section with dollar weakness signal', async () => {
    const dx = makeSnapshot('DX', {
      price: '102.00',
      change_day_pct: '-0.80',
    });
    mockSql.mockResolvedValueOnce([dx]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    // dxDay < -0.5 → dollar weakness
    expect(result).toContain('DOLLAR WEAKNESS');
    expect(result).toContain('equity tailwind');
  });

  it('shows no signal on DX when change is within ±0.5 threshold', async () => {
    const dx = makeSnapshot('DX', {
      price: '103.00',
      change_day_pct: '0.20',
    });
    mockSql.mockResolvedValueOnce([dx]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('US Dollar Index (/DX)');
    expect(result).not.toContain('DOLLAR STRENGTH');
    expect(result).not.toContain('DOLLAR WEAKNESS');
  });

  // ── VX section with only front month ─────────────────────────

  it('formats VX section with only front month when VX2 is missing', async () => {
    const vxm1 = makeSnapshot('VX1', { price: '20.00' });
    // No VX2
    mockSql.mockResolvedValueOnce([vxm1]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('VIX Futures (/VX)');
    expect(result).toContain('Front Month: 20.00');
    // No term structure info because VX2 is absent
    expect(result).not.toContain('Term Structure:');
  });

  // ── ES-SPX basis stress label ─────────────────────────────────

  it('labels ES-SPX basis as "slightly wide" when between 2 and 5 pts', async () => {
    const es = makeSnapshot('ES', { price: '5710.00' });
    mockSql.mockResolvedValueOnce([es]);
    mockSql.mockResolvedValueOnce([]);

    // SPX at 5707 → basis = 3.00 pts → slightly wide (>2, ≤5)
    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
      5707,
    );

    expect(result).toContain('slightly wide');
  });

  it('labels ES-SPX basis as "STRESS" when above 5 pts', async () => {
    const es = makeSnapshot('ES', { price: '5714.00' });
    mockSql.mockResolvedValueOnce([es]);
    mockSql.mockResolvedValueOnce([]);

    // SPX at 5700 → basis = 14 pts → STRESS (>5)
    const result = await formatFuturesForClaude(
      mockSql as never,
      analysisDate,
      5700,
    );

    expect(result).toContain('STRESS');
  });

  // ── ES Options with only puts or only calls ───────────────────

  it('handles ES options where only put rows are present', async () => {
    const es = makeSnapshot('ES', { price: '5700.00' });
    mockSql.mockResolvedValueOnce([es]);
    const putOption = makeEsOption({
      strike: '5600',
      option_type: 'P',
      open_interest: '200000',
    });
    // Only a put row, no calls
    mockSql.mockResolvedValueOnce([putOption]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('Top Put OI: 5600P');
    expect(result).not.toContain('Top Call OI');
  });

  it('handles ES options where only call rows are present', async () => {
    const es = makeSnapshot('ES', { price: '5700.00' });
    mockSql.mockResolvedValueOnce([es]);
    const callOption = makeEsOption({
      strike: '5800',
      option_type: 'C',
      open_interest: '100000',
    });
    // Only a call row, no puts
    mockSql.mockResolvedValueOnce([callOption]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('Top Call OI: 5800C');
    expect(result).not.toContain('Top Put OI');
  });

  // ── fmtOI M-suffix ────────────────────────────────────────────

  it('formats OI in millions for very large open interest values', async () => {
    const es = makeSnapshot('ES', { price: '5700.00' });
    mockSql.mockResolvedValueOnce([es]);
    const bigPut = makeEsOption({
      strike: '5500',
      option_type: 'P',
      open_interest: '2500000',
    });
    mockSql.mockResolvedValueOnce([bigPut]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    // 2,500,000 OI → "2.5M OI"
    expect(result).toContain('2.5M OI');
  });

  // ── fmtVolRatio labels ────────────────────────────────────────

  it('shows VERY ELEVATED volume ratio label when ratio >= 2.0', async () => {
    const es = makeSnapshot('ES', { price: '5700.00', volume_ratio: '2.5' });
    mockSql.mockResolvedValueOnce([es]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('VERY ELEVATED');
  });

  it('shows LOW volume ratio label when ratio < 0.7', async () => {
    const es = makeSnapshot('ES', { price: '5700.00', volume_ratio: '0.50' });
    mockSql.mockResolvedValueOnce([es]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('LOW');
  });

  // ── NQ without ES present ─────────────────────────────────────

  it('omits NQ/ES ratio when ES is absent', async () => {
    const nq = makeSnapshot('NQ', { price: '20500.00', change_day_pct: '0.5' });
    mockSql.mockResolvedValueOnce([nq]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toContain('NQ Futures (/NQ)');
    // No NQ/ES ratio without ES
    expect(result).not.toContain('NQ/ES Ratio');
    // No direction check without ES day pct
    expect(result).not.toContain('NQ-ES Direction');
  });

  // ── Output structure ────────────────────────────────────

  it('wraps output in Futures Context header', async () => {
    const es = makeSnapshot('ES', { price: '5700.00' });
    mockSql.mockResolvedValueOnce([es]);
    mockSql.mockResolvedValueOnce([]);

    const result = await formatFuturesForClaude(mockSql as never, analysisDate);

    expect(result).toMatch(/^## Futures Context\n\n/);
  });
});
