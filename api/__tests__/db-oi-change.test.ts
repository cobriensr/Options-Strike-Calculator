// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  getOiChangeData,
  formatOiChangeForClaude,
} from '../_lib/db-oi-change.js';
import type { OiChangeRow } from '../_lib/db-oi-change.js';

// ── Helpers ───────────────────────────────────────────────

function makeRow(overrides: Partial<OiChangeRow> = {}): OiChangeRow {
  return {
    date: '2026-04-01',
    optionSymbol: 'SPX260401C05800',
    strike: 5800,
    isCall: true,
    oiDiff: 1000,
    currOi: 5000,
    lastOi: 4000,
    avgPrice: 12.5,
    prevAskVolume: 500,
    prevBidVolume: 200,
    prevMultiLegVolume: 100,
    prevTotalPremium: 150000000,
    ...overrides,
  };
}

/** Build a raw DB row (snake_case fields as DB returns). */
function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-04-01',
    option_symbol: 'SPX260401C05800',
    strike: 5800,
    is_call: true,
    oi_diff: 1000,
    curr_oi: 5000,
    last_oi: 4000,
    avg_price: 12.5,
    prev_ask_volume: 500,
    prev_bid_volume: 200,
    prev_multi_leg_volume: 100,
    prev_total_premium: 150000000,
    ...overrides,
  };
}

describe('getOiChangeData', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
  });

  it('queries the DB and maps snake_case to camelCase', async () => {
    mockSql.mockResolvedValueOnce([
      makeDbRow(),
      makeDbRow({
        option_symbol: 'SPX260401P05750',
        strike: 5750,
        is_call: false,
        oi_diff: -500,
        curr_oi: 3000,
        last_oi: 3500,
        avg_price: 8.0,
        prev_ask_volume: 300,
        prev_bid_volume: 400,
        prev_multi_leg_volume: 50,
        prev_total_premium: 80000000,
      }),
    ]);

    const rows = await getOiChangeData('2026-04-01');

    expect(rows).toHaveLength(2);

    expect(rows[0]).toEqual({
      date: '2026-04-01',
      optionSymbol: 'SPX260401C05800',
      strike: 5800,
      isCall: true,
      oiDiff: 1000,
      currOi: 5000,
      lastOi: 4000,
      avgPrice: 12.5,
      prevAskVolume: 500,
      prevBidVolume: 200,
      prevMultiLegVolume: 100,
      prevTotalPremium: 150000000,
    });

    expect(rows[1]).toMatchObject({
      optionSymbol: 'SPX260401P05750',
      strike: 5750,
      isCall: false,
      oiDiff: -500,
    });
  });

  it('returns empty array when no rows', async () => {
    mockSql.mockResolvedValueOnce([]);
    const rows = await getOiChangeData('2026-04-01');
    expect(rows).toEqual([]);
  });

  it('converts string numeric fields via Number()', async () => {
    mockSql.mockResolvedValueOnce([
      makeDbRow({
        strike: '5800',
        oi_diff: '1000',
        curr_oi: '5000',
        last_oi: '4000',
        avg_price: '12.50',
        prev_ask_volume: '500',
        prev_bid_volume: '200',
        prev_multi_leg_volume: '100',
        prev_total_premium: '150000000',
      }),
    ]);

    const rows = await getOiChangeData('2026-04-01');

    expect(rows[0]!.strike).toBe(5800);
    expect(rows[0]!.oiDiff).toBe(1000);
    expect(rows[0]!.currOi).toBe(5000);
    expect(rows[0]!.lastOi).toBe(4000);
    expect(rows[0]!.avgPrice).toBe(12.5);
    expect(rows[0]!.prevAskVolume).toBe(500);
    expect(rows[0]!.prevBidVolume).toBe(200);
    expect(rows[0]!.prevMultiLegVolume).toBe(100);
    expect(rows[0]!.prevTotalPremium).toBe(150000000);
  });
});

describe('formatOiChangeForClaude', () => {
  it('returns null for empty rows', () => {
    expect(formatOiChangeForClaude([])).toBeNull();
  });

  // ── Summary stats ──────────────────────────────────────

  it('includes summary header and net OI changes', () => {
    const rows = [
      makeRow({ isCall: true, oiDiff: 1000 }),
      makeRow({ isCall: false, oiDiff: -500 }),
    ];

    const result = formatOiChangeForClaude(rows);

    expect(result).toContain('SPX OI Change Analysis');
    expect(result).toContain('2 contracts');
    expect(result).toContain('+1,000 calls');
    expect(result).toContain('-500 puts');
  });

  it('formats premium as $M for millions', () => {
    const rows = [
      makeRow({ prevTotalPremium: 150000000 }), // 150M
    ];

    const result = formatOiChangeForClaude(rows);

    expect(result).toContain('$150.0M');
  });

  it('formats premium as $B for billions', () => {
    const rows = [
      makeRow({ prevTotalPremium: 2500000000 }), // 2.5B
    ];

    const result = formatOiChangeForClaude(rows);

    expect(result).toContain('$2.5B');
  });

  it('formats premium as $K for thousands', () => {
    const rows = [makeRow({ prevTotalPremium: 5000 })];

    const result = formatOiChangeForClaude(rows);

    expect(result).toContain('$5K');
  });

  it('formats premium as raw $ for small amounts', () => {
    const rows = [makeRow({ prevTotalPremium: 500 })];

    const result = formatOiChangeForClaude(rows);

    expect(result).toContain('$500');
  });

  // ── Aggressor direction ────────────────────────────────

  it('labels ASK-DOMINATED when ask/bid ratio > 1.5', () => {
    const rows = [
      makeRow({ prevAskVolume: 800, prevBidVolume: 200 }), // 4x
    ];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).toContain('ASK-DOMINATED');
    expect(result).toContain('new positions opened aggressively');
  });

  it('labels BID-DOMINATED when bid/ask ratio > 1.5', () => {
    const rows = [
      makeRow({ prevAskVolume: 100, prevBidVolume: 500 }), // 0.2x
    ];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).toContain('BID-DOMINATED');
    expect(result).toContain('defensive or closing activity');
  });

  it('labels BALANCED when neither ratio exceeds 1.5', () => {
    const rows = [
      makeRow({ prevAskVolume: 400, prevBidVolume: 400 }), // 1.0x
    ];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).toContain('BALANCED');
    expect(result).toContain('no clear aggressor bias');
  });

  it('shows INF ask/bid ratio when totalBidVol is 0', () => {
    const rows = [makeRow({ prevAskVolume: 500, prevBidVolume: 0 })];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).toContain('INF');
  });

  // ── Multi-leg percentage ───────────────────────────────

  it('labels heavy institutional spread activity for >50% multi-leg', () => {
    // multi-leg = 600, ask = 200, bid = 200 → total = 1000 → 60%
    const rows = [
      makeRow({
        prevAskVolume: 200,
        prevBidVolume: 200,
        prevMultiLegVolume: 600,
      }),
    ];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).toContain('60%');
    expect(result).toContain('heavy institutional spread activity');
  });

  it('labels moderate institutional spread activity for 25-50% multi-leg', () => {
    // multi-leg = 300, ask = 400, bid = 300 → total = 1000 → 30%
    const rows = [
      makeRow({
        prevAskVolume: 400,
        prevBidVolume: 300,
        prevMultiLegVolume: 300,
      }),
    ];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).toContain('30%');
    expect(result).toContain('moderate institutional spread activity');
  });

  it('labels mostly directional for <25% multi-leg', () => {
    // multi-leg = 100, ask = 500, bid = 400 → total = 1000 → 10%
    const rows = [
      makeRow({
        prevAskVolume: 500,
        prevBidVolume: 400,
        prevMultiLegVolume: 100,
      }),
    ];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).toContain('10%');
    expect(result).toContain('mostly directional or single-leg activity');
  });

  it('shows 0% when total volume is zero', () => {
    const rows = [
      makeRow({
        prevAskVolume: 0,
        prevBidVolume: 0,
        prevMultiLegVolume: 0,
      }),
    ];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).toContain('0%');
  });

  // ── Top contracts table ────────────────────────────────

  it('includes top contracts section', () => {
    const rows = [makeRow({ strike: 5800, isCall: true, oiDiff: 1000 })];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).toContain('Top Contracts by Absolute OI Change');
    expect(result).toContain('SPX 5800C');
    expect(result).toContain('+1,000 OI');
  });

  it('formats puts with P tag', () => {
    const rows = [makeRow({ strike: 5750, isCall: false, oiDiff: -800 })];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).toContain('SPX 5750P');
    expect(result).toContain('-800 OI');
  });

  it('shows ask-heavy for ratio > 1.5', () => {
    const rows = [
      makeRow({ prevAskVolume: 500, prevBidVolume: 100 }), // 5.0x
    ];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).toContain('ask-heavy (5.0x)');
  });

  it('shows bid-heavy for ratio < 0.67', () => {
    const rows = [
      makeRow({ prevAskVolume: 50, prevBidVolume: 200 }), // 0.25x
    ];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).toContain('bid-heavy (0.3x)');
  });

  it('shows balanced for ratio between 0.67 and 1.5', () => {
    const rows = [
      makeRow({ prevAskVolume: 300, prevBidVolume: 300 }), // 1.0x
    ];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).toContain('balanced (1.0x)');
  });

  it('shows ask-only when prevBidVolume is 0 but prevAskVolume > 0', () => {
    const rows = [makeRow({ prevAskVolume: 500, prevBidVolume: 0 })];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).toContain('ask-only');
  });

  it('shows no vol data when both ask and bid volumes are 0', () => {
    const rows = [makeRow({ prevAskVolume: 0, prevBidVolume: 0 })];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).toContain('no vol data');
  });

  // ── Distance from ATM ─────────────────────────────────

  it('shows ATM label for strike within 3 pts of currentSpx', () => {
    const rows = [makeRow({ strike: 5801 })];

    const result = formatOiChangeForClaude(rows, 5800)!;

    expect(result).toContain('(ATM)');
  });

  it('shows pts above for strike above currentSpx by more than 3', () => {
    const rows = [makeRow({ strike: 5850 })];

    const result = formatOiChangeForClaude(rows, 5800)!;

    expect(result).toContain('50 pts above');
  });

  it('shows pts below for strike below currentSpx by more than 3', () => {
    const rows = [makeRow({ strike: 5750 })];

    const result = formatOiChangeForClaude(rows, 5800)!;

    expect(result).toContain('50 pts below');
  });

  it('does not show distance when currentSpx is not provided', () => {
    const rows = [makeRow({ strike: 5800 })];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).not.toContain('pts above');
    expect(result).not.toContain('pts below');
    expect(result).not.toContain('(ATM)');
  });

  // ── Top 10 limit ───────────────────────────────────────

  it('limits contract table to top 10', () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      makeRow({
        strike: 5800 + i * 5,
        optionSymbol: `SPX${5800 + i * 5}C`,
        oiDiff: 1000 - i * 50,
      }),
    );

    const result = formatOiChangeForClaude(rows)!;

    // Should show 5800-5845 (first 10) but not 5850+
    expect(result).toContain('SPX 5800C');
    expect(result).toContain('SPX 5845C');
    expect(result).not.toContain('SPX 5850C');
  });

  // ── fmtSigned edge cases ───────────────────────────────

  it('formats zero OI diff with + sign', () => {
    const rows = [makeRow({ oiDiff: 0 })];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).toContain('+0 OI');
  });

  it('formats negative OI diff without extra sign', () => {
    const rows = [makeRow({ oiDiff: -1234 })];

    const result = formatOiChangeForClaude(rows)!;

    expect(result).toContain('-1,234 OI');
  });

  // ── Call/put premium split ─────────────────────────────

  it('splits premium correctly between calls and puts', () => {
    const rows = [
      makeRow({ isCall: true, prevTotalPremium: 100000000 }),
      makeRow({ isCall: false, prevTotalPremium: 200000000 }),
    ];

    const result = formatOiChangeForClaude(rows)!;

    // Total = 300M
    expect(result).toContain('$300.0M');
    // calls = 100M, puts = 200M
    expect(result).toContain('calls $100.0M');
    expect(result).toContain('puts $200.0M');
  });
});
