// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

import {
  getRecentNope,
  getSessionNope,
  formatNopeForClaude,
  type NopeRow,
} from '../_lib/db-nope.js';

// ── Fixtures ─────────────────────────────────────────────────

function makeRow(
  timestamp: string,
  nope: number,
  overrides: Partial<NopeRow> = {},
): NopeRow {
  return {
    ticker: 'SPY',
    timestamp,
    nope,
    nope_fill: nope,
    call_delta: 10000,
    put_delta: 8000,
    call_fill_delta: 10500,
    put_fill_delta: 7500,
    call_vol: 25000,
    put_vol: 20000,
    stock_vol: 1000000,
    ...overrides,
  };
}

function mockDbRow(r: NopeRow): Record<string, unknown> {
  return {
    ticker: r.ticker,
    timestamp: r.timestamp,
    call_vol: r.call_vol,
    put_vol: r.put_vol,
    stock_vol: r.stock_vol,
    call_delta: r.call_delta.toString(),
    put_delta: r.put_delta.toString(),
    call_fill_delta: r.call_fill_delta.toString(),
    put_fill_delta: r.put_fill_delta.toString(),
    nope: r.nope.toString(),
    nope_fill: r.nope_fill.toString(),
  };
}

// ── getRecentNope ────────────────────────────────────────────

describe('getRecentNope', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns mapped rows with numeric coercion', async () => {
    const row = makeRow('2026-04-14T13:45:00.000Z', -0.000648);
    mockSql.mockResolvedValueOnce([mockDbRow(row)]);

    const result = await getRecentNope('SPY', 30);

    expect(result).toHaveLength(1);
    expect(result[0]!.nope).toBeCloseTo(-0.000648, 10);
    expect(result[0]!.call_delta).toBe(10000);
    expect(result[0]!.ticker).toBe('SPY');
  });

  it('returns empty array when no rows', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await getRecentNope('SPY', 30);
    expect(result).toEqual([]);
  });

  it('passes asOf to the query when provided (backtest mode)', async () => {
    mockSql.mockResolvedValueOnce([]);

    await getRecentNope('SPY', 60, '2026-04-14T19:00:00.000Z');

    const sqlStrings = mockSql.mock.calls[0]![0] as readonly string[];
    const joined = sqlStrings.join('');
    expect(joined).toContain('timestamp <=');
    expect(joined).toContain('::timestamptz - ');
  });

  it('handles Date-object timestamps from Neon', async () => {
    const dbRow = mockDbRow(makeRow('2026-04-14T13:45:00.000Z', 0.0001));
    dbRow.timestamp = new Date('2026-04-14T13:45:00.000Z');
    mockSql.mockResolvedValueOnce([dbRow]);

    const result = await getRecentNope('SPY', 30);
    expect(result[0]!.timestamp).toBe('2026-04-14T13:45:00.000Z');
  });
});

// ── getSessionNope ───────────────────────────────────────────

describe('getSessionNope', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns rows for a session date', async () => {
    const rows = [
      makeRow('2026-04-14T13:30:00.000Z', -0.0003),
      makeRow('2026-04-14T13:31:00.000Z', -0.0001),
    ];
    mockSql.mockResolvedValueOnce(rows.map(mockDbRow));

    const result = await getSessionNope('SPY', '2026-04-14');

    expect(result).toHaveLength(2);
    expect(result[0]!.nope).toBeCloseTo(-0.0003, 10);
  });

  it('returns empty array when no rows exist for date', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await getSessionNope('SPY', '2026-04-14');
    expect(result).toEqual([]);
  });
});

// ── formatNopeForClaude ──────────────────────────────────────

describe('formatNopeForClaude', () => {
  it('returns null on empty input', () => {
    expect(formatNopeForClaude([])).toBeNull();
  });

  it('formats a single row without direction block', () => {
    const rows = [makeRow('2026-04-14T13:45:00.000Z', -0.000648)];
    const out = formatNopeForClaude(rows);

    expect(out).toContain('SPY NOPE trajectory');
    expect(out).toContain('1 samples');
    expect(out).toContain('NOPE: -0.000648');
    expect(out).not.toContain('Direction');
    expect(out).not.toContain('Sign flips');
  });

  it('reports rising direction and positive regime', () => {
    const rows = [
      makeRow('2026-04-14T13:30:00.000Z', -0.0002),
      makeRow('2026-04-14T13:35:00.000Z', 0.0001),
      makeRow('2026-04-14T13:40:00.000Z', 0.0004),
    ];
    const out = formatNopeForClaude(rows);

    expect(out).toContain('NOPE rising');
    expect(out).toContain('Δ +0.000600');
    expect(out).toContain('POSITIVE');
    expect(out).toContain('bullish tape pressure');
  });

  it('reports falling direction and negative regime', () => {
    const rows = [
      makeRow('2026-04-14T13:30:00.000Z', 0.0003),
      makeRow('2026-04-14T13:35:00.000Z', -0.0004),
    ];
    const out = formatNopeForClaude(rows);

    expect(out).toContain('NOPE falling');
    expect(out).toContain('NEGATIVE');
    expect(out).toContain('bearish tape pressure');
  });

  it('counts sign flips correctly', () => {
    const rows = [
      makeRow('2026-04-14T13:30:00.000Z', -0.0002),
      makeRow('2026-04-14T13:31:00.000Z', 0.0001), // flip 1
      makeRow('2026-04-14T13:32:00.000Z', 0.0002),
      makeRow('2026-04-14T13:33:00.000Z', -0.0001), // flip 2
      makeRow('2026-04-14T13:34:00.000Z', 0.0001), // flip 3
    ];
    const out = formatNopeForClaude(rows);

    expect(out).toContain('Sign flips: 3');
  });

  it('formats zero NOPE without + prefix but with correct padding', () => {
    const rows = [makeRow('2026-04-14T13:30:00.000Z', 0)];
    const out = formatNopeForClaude(rows);

    expect(out).toContain('NOPE: +0.000000');
  });

  it('handles NaN defensively via formatNope', () => {
    const rows = [makeRow('2026-04-14T13:30:00.000Z', Number.NaN)];
    const out = formatNopeForClaude(rows);

    expect(out).toContain('NOPE: N/A');
  });
});
