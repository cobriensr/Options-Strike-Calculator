// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { buildFlowContextBlock } from '../_lib/periscope-flow-context.js';

beforeEach(() => {
  mockSql.mockReset();
});

// Helpers ──────────────────────────────────────────────────────────

/**
 * Inspect the most recent tagged-template invocation: the Neon SQL
 * driver passes (strings, ...values). For these tests we only care
 * about the `values` array — the strikes lo/hi, ticker, and
 * timestamps end up in there.
 */
function lastSqlValues(): unknown[] {
  const calls = mockSql.mock.calls;
  const last = calls[calls.length - 1];
  // call shape is [TemplateStringsArray, ...values]
  return last ? (last.slice(1) as unknown[]) : [];
}

/** ISO with explicit UTC suffix so we don't depend on host TZ. */
const baseIntradayMomentUTC = new Date('2026-05-05T18:30:00Z'); // 13:30 CT / 14:30 ET → intraday
const baseDebriefMomentUTC = new Date('2026-05-05T21:00:00Z'); // 16:00 CT debrief

// ── Empty result ──────────────────────────────────────────────────

describe('buildFlowContextBlock — intraday mode (empty)', () => {
  it('returns null when no recent alerts match', async () => {
    mockSql.mockResolvedValueOnce([]);
    const out = await buildFlowContextBlock({
      mode: 'intraday',
      spot: 5800,
      asOf: baseIntradayMomentUTC,
    });
    expect(out).toBeNull();
  });
});

describe('buildFlowContextBlock — intraday mode (rows present)', () => {
  it('formats a labelled list of alerts for intraday flavor', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: '1',
        ticker: 'SPXW',
        option_chain: 'SPXW260505C5810',
        rule_name: 'RepeatedHits',
        option_type: 'C',
        strike: '5810',
        expiry: '2026-05-05',
        created_at: baseIntradayMomentUTC.toISOString(),
        underlying_price: '5800.0',
        total_premium: '1250000.00',
        ask_side_ratio: '0.82',
        volume: '120',
      },
      {
        id: '2',
        ticker: 'SPXW',
        option_chain: 'SPXW260505P5790',
        rule_name: 'VolumeOverOI',
        option_type: 'P',
        strike: '5790',
        expiry: '2026-05-05',
        // 1 minute earlier
        created_at: new Date(
          baseIntradayMomentUTC.getTime() - 60_000,
        ).toISOString(),
        underlying_price: '5800.0',
        total_premium: '450000.00',
        ask_side_ratio: '0.31',
        volume: '88',
      },
    ]);
    const out = await buildFlowContextBlock({
      mode: 'intraday',
      spot: 5800,
      asOf: baseIntradayMomentUTC,
    });
    expect(out).not.toBeNull();
    expect(out).toMatch(/Fresh SPXW flow alerts/);
    expect(out).toMatch(/last 15 min/);
    expect(out).toMatch(/±10 pts/);
    expect(out).toMatch(/CALL 5810/);
    expect(out).toMatch(/PUT 5790/);
    expect(out).toMatch(/rule="RepeatedHits"/);
    expect(out).toMatch(/ask 82%/);
    expect(out).toMatch(/prem \$1\.25M/);
    expect(out).toMatch(/prem \$450\.0K/);
  });

  it('uses the wider pre-trade window when mode = pre_trade', async () => {
    const preOpen = new Date('2026-05-05T13:00:00Z');
    mockSql.mockResolvedValueOnce([]);
    const out = await buildFlowContextBlock({
      mode: 'pre_trade',
      spot: 5800,
      asOf: preOpen,
    });
    expect(out).toBeNull();

    // The recorded SQL bind values must reflect the wider strike band
    // (±20 pts) and 30-minute window. The query binds windowStart,
    // asOf, strikeLo, strikeHi, and topN (in addition to the ticker).
    const values = lastSqlValues();
    // Strike band for ±20 around 5800 = [5780, 5820]
    expect(values).toContain(5780);
    expect(values).toContain(5820);
    // topN for pre-trade is 8
    expect(values).toContain(8);
  });
});

// ── Debrief mode ──────────────────────────────────────────────────

describe('buildFlowContextBlock — debrief mode', () => {
  it('returns null when no buckets', async () => {
    mockSql.mockResolvedValueOnce([]);
    const out = await buildFlowContextBlock({
      mode: 'debrief',
      spot: 5800,
      asOf: baseDebriefMomentUTC,
    });
    expect(out).toBeNull();
  });

  it('formats hourly buckets table', async () => {
    mockSql.mockResolvedValueOnce([
      {
        hour_ct: 8,
        total: 12,
        bullish: 8,
        bearish: 2,
        neutral: 2,
        total_premium: '3500000',
      },
      {
        hour_ct: 9,
        total: 20,
        bullish: 5,
        bearish: 13,
        neutral: 2,
        total_premium: '7200000',
      },
      {
        hour_ct: 14,
        total: 6,
        bullish: 1,
        bearish: 4,
        neutral: 1,
        total_premium: '900000',
      },
    ]);
    const out = await buildFlowContextBlock({
      mode: 'debrief',
      spot: 5800,
      asOf: baseDebriefMomentUTC,
    });
    expect(out).not.toBeNull();
    expect(out).toMatch(/SPXW flow distribution across 2026-05-05/);
    expect(out).toMatch(/hour\s+total\s+bullish\s+bearish\s+neutral\s+premium/);
    expect(out).toMatch(/08:00/);
    expect(out).toMatch(/09:00/);
    expect(out).toMatch(/14:00/);
    expect(out).toMatch(/\$3\.50M/);
    expect(out).toMatch(/\$7\.20M/);
  });
});

// ── Window / proximity bind values ────────────────────────────────

describe('buildFlowContextBlock — window + proximity binds', () => {
  it('intraday read binds 15-min window + ±10pt strike band', async () => {
    mockSql.mockResolvedValueOnce([]);
    await buildFlowContextBlock({
      mode: 'intraday',
      spot: 5800,
      asOf: baseIntradayMomentUTC,
    });
    const values = lastSqlValues();
    // ±10 around 5800 = [5790, 5810]
    expect(values).toContain(5790);
    expect(values).toContain(5810);
    // topN
    expect(values).toContain(8);
    // ticker
    expect(values).toContain('SPXW');

    // Window-start ISO must be exactly 15 min before asOf.
    const expectedStart = new Date(
      baseIntradayMomentUTC.getTime() - 15 * 60_000,
    ).toISOString();
    expect(values).toContain(expectedStart);
  });

  it('pre-open read binds 30-min window + ±20pt strike band', async () => {
    const preOpen = new Date('2026-05-05T13:00:00Z');
    mockSql.mockResolvedValueOnce([]);
    await buildFlowContextBlock({
      mode: 'pre_trade',
      spot: 5800,
      asOf: preOpen,
    });
    const values = lastSqlValues();
    expect(values).toContain(5780);
    expect(values).toContain(5820);
    const expectedStart = new Date(
      preOpen.getTime() - 30 * 60_000,
    ).toISOString();
    expect(values).toContain(expectedStart);
  });
});

// ── Best-effort failure ──────────────────────────────────────────

describe('buildFlowContextBlock — best-effort error handling', () => {
  it('returns null on DB error rather than throwing', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection reset'));
    const out = await buildFlowContextBlock({
      mode: 'intraday',
      spot: 5800,
      asOf: baseIntradayMomentUTC,
    });
    expect(out).toBeNull();
  });
});
