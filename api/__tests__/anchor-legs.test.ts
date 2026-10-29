// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSql = vi.hoisted(() => vi.fn());

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

import {
  classifySpreadShape,
  describeAnchor,
  groupLegs,
  lookupAnchorLegs,
  type AnchorRequest,
  type TapePrint,
} from '../_lib/anchor-legs.js';
import { MULTI_LEG_TRADE_CODES } from '../_lib/multileg-codes.js';
import type { SpreadLeg, SpreadShape } from '../../src/types/spread-legs.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const EXP = '2026-10-30';
const EXP_LATER = '2026-11-06';
const MS_ISO = '2026-10-29T13:38:50.038Z';

/** OCC symbol, e.g. TSLA261030C00726000. */
function chainOf(
  root: string,
  expiry: string,
  optionType: 'C' | 'P',
  strike: number,
): string {
  const yymmdd = expiry.slice(2).replaceAll('-', '');
  const strikeCode = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${root}${yymmdd}${optionType}${strikeCode}`;
}

let seq = 0;
function tp(
  optionType: 'C' | 'P',
  strike: number,
  overrides: Partial<TapePrint> = {},
): TapePrint {
  seq += 1;
  const expiry = overrides.expiry ?? EXP;
  return {
    wsTradeId: `trade-${seq}`,
    optionChain: chainOf('TSLA', expiry, optionType, strike),
    optionType,
    strike,
    expiry,
    executedAt: MS_ISO,
    price: 1,
    size: 1,
    tradeCode: 'mlet',
    ...overrides,
  };
}

function leg(
  optionType: 'C' | 'P',
  strike: number,
  opts: { expiry?: string; size?: number } = {},
): SpreadLeg {
  return {
    optionType,
    strike,
    expiry: opts.expiry ?? EXP,
    size: opts.size ?? 1,
    price: 1,
    tradeCode: 'mlet',
  };
}

// ── classifySpreadShape ────────────────────────────────────────────────────

describe('classifySpreadShape', () => {
  const rows: Array<[string, SpreadLeg[], SpreadShape]> = [
    [
      '2 legs, same type + expiry, different strikes → vertical',
      [leg('C', 726), leg('C', 727)],
      'vertical',
    ],
    [
      '2 legs, same type + strike, different expiries → calendar',
      [leg('P', 215), leg('P', 215, { expiry: EXP_LATER })],
      'calendar',
    ],
    [
      '2 legs, same type, different strike and expiry → diagonal',
      [leg('C', 100), leg('C', 105, { expiry: EXP_LATER })],
      'diagonal',
    ],
    [
      '2 legs, call + put, same expiry + strike → straddle',
      [leg('C', 100), leg('P', 100)],
      'straddle',
    ],
    [
      '2 legs, call + put, same expiry, different strikes → combo',
      [leg('C', 940), leg('P', 890)],
      'combo',
    ],
    [
      '3 legs, same type + expiry, equally spaced, sizes 1:2:1 → butterfly',
      [
        leg('P', 135, { size: 10 }),
        leg('P', 140, { size: 20 }),
        leg('P', 145, { size: 10 }),
      ],
      'butterfly',
    ],
    [
      '3 legs, sizes 1:1:1 → three_leg',
      [leg('P', 135), leg('P', 140), leg('P', 145)],
      'three_leg',
    ],
    [
      '3 legs, 1:2:1 but unequal spacing → three_leg',
      [
        leg('P', 135, { size: 1 }),
        leg('P', 140, { size: 2 }),
        leg('P', 150, { size: 1 }),
      ],
      'three_leg',
    ],
    [
      '3 legs, 1:2:1 equally spaced but mixed types → three_leg',
      [
        leg('P', 135, { size: 1 }),
        leg('C', 140, { size: 2 }),
        leg('P', 145, { size: 1 }),
      ],
      'three_leg',
    ],
    [
      '4 legs, same expiry → four_leg',
      [leg('P', 100), leg('P', 105), leg('C', 110), leg('C', 115)],
      'four_leg',
    ],
    [
      '4 legs, multiple expiries → four_leg_multi_expiry',
      [
        leg('P', 100),
        leg('P', 105),
        leg('P', 100, { expiry: EXP_LATER }),
        leg('P', 105, { expiry: EXP_LATER }),
      ],
      'four_leg_multi_expiry',
    ],
    [
      '5 legs → complex',
      [
        leg('C', 100),
        leg('C', 105),
        leg('C', 110),
        leg('C', 115),
        leg('C', 120),
      ],
      'complex',
    ],
    ['1 leg (no sibling found) → unpaired', [leg('C', 100)], 'unpaired'],
    [
      '2 legs, call + put, different expiries → other',
      [leg('C', 100), leg('P', 100, { expiry: EXP_LATER })],
      'other',
    ],
    ['0 legs → other', [], 'other'],
  ];

  it.each(rows)('%s', (_name, legs, expected) => {
    expect(classifySpreadShape(legs)).toBe(expected);
  });

  it('finds a butterfly whose anchor (the body) is listed first', () => {
    // groupLegs puts the anchor's chain first, so a body-anchored fly
    // arrives as [140, 135, 145]: shape rules must not depend on order.
    expect(
      classifySpreadShape([
        leg('P', 140, { size: 4 }),
        leg('P', 135, { size: 2 }),
        leg('P', 145, { size: 2 }),
      ]),
    ).toBe('butterfly');
  });

  it('compares fractional strike spacing exactly (10.1/10.2/10.3)', () => {
    // 10.2 - 10.1 !== 10.3 - 10.2 in float; strikes are whole thousandths.
    expect(
      classifySpreadShape([
        leg('C', 10.1, { size: 1 }),
        leg('C', 10.2, { size: 2 }),
        leg('C', 10.3, { size: 1 }),
      ]),
    ).toBe('butterfly');
  });

  it('Review Focus 2: a vertical whose short leg filled as 3 same-ms prints groups to 2 legs', () => {
    const anchor = tp('C', 726, { price: 2, size: 10 });
    const fills = [
      tp('C', 727, { price: 0.5, size: 3 }),
      tp('C', 727, { price: 0.52, size: 3 }),
      tp('C', 727, { price: 0.55, size: 4 }),
    ];
    const legs = groupLegs([anchor, ...fills], anchor.optionChain);
    expect(legs).toHaveLength(2);
    expect(legs[1]).toEqual({
      optionType: 'C',
      strike: 727,
      expiry: EXP,
      size: 10,
      // VWAP: (0.50×3 + 0.52×3 + 0.55×4) / 10
      price: 0.526,
      tradeCode: 'mlet',
    });
    expect(classifySpreadShape(legs)).toBe('vertical');
  });

  it('Review Focus 3: 5 contracts → complex', () => {
    const anchor = tp('P', 100);
    const prints = [
      anchor,
      tp('P', 95),
      tp('P', 105),
      tp('C', 110),
      tp('C', 115),
    ];
    const legs = groupLegs(prints, anchor.optionChain);
    expect(legs).toHaveLength(5);
    expect(classifySpreadShape(legs)).toBe('complex');
  });
});

// ── groupLegs ──────────────────────────────────────────────────────────────

describe('groupLegs', () => {
  it('puts the anchor chain first, then the rest by expiry, type, strike', () => {
    const anchor = tp('C', 110);
    const prints = [
      tp('P', 100, { expiry: EXP_LATER }),
      tp('C', 105),
      anchor,
      tp('P', 95),
      tp('C', 100),
    ];
    const legs = groupLegs(prints, anchor.optionChain);
    expect(legs.map((l) => `${l.expiry} ${l.optionType} ${l.strike}`)).toEqual([
      `${EXP} C 110`,
      `${EXP} C 100`,
      `${EXP} C 105`,
      `${EXP} P 95`,
      `${EXP_LATER} P 100`,
    ]);
  });

  it('caps at 8 legs, keeping the anchor leg', () => {
    const anchor = tp('C', 200);
    const others = Array.from({ length: 10 }, (_, i) => tp('C', 100 + i));
    const legs = groupLegs([...others, anchor], anchor.optionChain);
    expect(legs).toHaveLength(8);
    expect(legs[0]?.strike).toBe(200);
    expect(legs.at(-1)?.strike).toBe(106);
  });

  it("uses the group's most common trade code, first seen on a tie", () => {
    const a = tp('C', 100, { tradeCode: 'mlet' });
    const legs = groupLegs(
      [
        a,
        tp('C', 105, { tradeCode: 'mlat' }),
        tp('C', 105, { tradeCode: 'mlet' }),
        tp('C', 105, { tradeCode: 'mlet' }),
        tp('C', 110, { tradeCode: 'mesl' }),
        tp('C', 110, { tradeCode: 'mlat' }),
      ],
      a.optionChain,
    );
    expect(legs.map((l) => l.tradeCode)).toEqual(['mlet', 'mlet', 'mesl']);
  });

  it('returns a null trade code when no print in the group has one', () => {
    const a = tp('C', 100, { tradeCode: null });
    expect(groupLegs([a], a.optionChain)[0]?.tradeCode).toBeNull();
  });

  it('keeps the print price when a group has no size to weight by', () => {
    const a = tp('C', 100, { price: 1.5, size: 0 });
    expect(groupLegs([a], a.optionChain)[0]).toMatchObject({
      size: 0,
      price: 1.5,
    });
  });
});

// ── describeAnchor ─────────────────────────────────────────────────────────

describe('describeAnchor', () => {
  it('mlet anchor + one sibling → multi_leg vertical, anchor leg first', () => {
    const anchor = tp('C', 727, { price: 0.5, size: 10, tradeCode: 'mlet' });
    const sibling = tp('C', 726, { price: 2, size: 10, tradeCode: 'mlet' });
    expect(describeAnchor(anchor, [sibling])).toEqual({
      anchorWsTradeId: anchor.wsTradeId,
      anchorTradeCode: 'mlet',
      legKind: 'multi_leg',
      spreadShape: 'vertical',
      spreadLegs: [
        {
          optionType: 'C',
          strike: 727,
          expiry: EXP,
          size: 10,
          price: 0.5,
          tradeCode: 'mlet',
        },
        {
          optionType: 'C',
          strike: 726,
          expiry: EXP,
          size: 10,
          price: 2,
          tradeCode: 'mlet',
        },
      ],
    });
  });

  it('does not double-count the anchor when the sibling rows include it', () => {
    const anchor = tp('C', 727, { size: 10 });
    const sibling = tp('C', 726, { size: 10 });
    const result = describeAnchor(anchor, [anchor, sibling]);
    expect(result.spreadLegs?.[0]?.size).toBe(10);
    expect(result.spreadShape).toBe('vertical');
  });

  it('tlet → stock_tied with null shape and legs', () => {
    const anchor = tp('C', 100, { tradeCode: 'tlet' });
    expect(describeAnchor(anchor, [tp('C', 105)])).toEqual({
      anchorWsTradeId: anchor.wsTradeId,
      anchorTradeCode: 'tlet',
      legKind: 'stock_tied',
      spreadShape: null,
      spreadLegs: null,
    });
  });

  it('auto → single with null shape and legs', () => {
    const anchor = tp('C', 100, { tradeCode: 'auto' });
    expect(describeAnchor(anchor, [])).toEqual({
      anchorWsTradeId: anchor.wsTradeId,
      anchorTradeCode: 'auto',
      legKind: 'single',
      spreadShape: null,
      spreadLegs: null,
    });
  });

  it('Review Focus 1: null code → legKind null, not single', () => {
    const anchor = tp('C', 100, { tradeCode: null });
    expect(describeAnchor(anchor, [])).toEqual({
      anchorWsTradeId: anchor.wsTradeId,
      anchorTradeCode: null,
      legKind: null,
      spreadShape: null,
      spreadLegs: null,
    });
  });

  it('lone mlet → unpaired with the anchor as its only leg', () => {
    const anchor = tp('P', 50, { price: 1.25, size: 7, tradeCode: 'mlet' });
    const result = describeAnchor(anchor, []);
    expect(result.legKind).toBe('multi_leg');
    expect(result.spreadShape).toBe('unpaired');
    expect(result.spreadLegs).toEqual([
      {
        optionType: 'P',
        strike: 50,
        expiry: EXP,
        size: 7,
        price: 1.25,
        tradeCode: 'mlet',
      },
    ]);
  });

  it('a lone anchor split across several fills on its own chain is still unpaired', () => {
    const anchor = tp('P', 50, { price: 1, size: 5 });
    const fill = tp('P', 50, { price: 1.1, size: 5 });
    const result = describeAnchor(anchor, [fill]);
    expect(result.spreadShape).toBe('unpaired');
    expect(result.spreadLegs?.[0]?.size).toBe(10);
    expect(result.spreadLegs?.[0]?.price).toBe(1.05);
  });
});

// ── lookupAnchorLegs ───────────────────────────────────────────────────────

const ANCHOR_MS = String(Date.parse(MS_ISO));

/** A ws_option_trades row as the Neon driver returns it. */
function dbRow(
  idx: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    idx: String(idx), // ORDINALITY is bigint → string
    ws_trade_id: `row-${idx}`,
    option_chain: 'TSLA261030C00726500',
    option_type: 'C',
    strike: '726.5000', // NUMERIC → string
    expiry: new Date('2026-10-30T00:00:00.000Z'), // DATE → Date
    executed_ms: ANCHOR_MS, // bigint → string
    price: '2.1300',
    size: 10,
    trade_code: 'mlet',
    ...overrides,
  };
}

function request(key: string, chain: string, ticker = 'TSLA'): AnchorRequest {
  return {
    key,
    ticker,
    optionChain: chain,
    windowStart: new Date('2026-10-29T13:38:20.000Z'),
    windowEnd: new Date('2026-10-29T13:39:20.000Z'),
  };
}

/** Bound values of the Nth tagged-template call (strings array dropped). */
function boundValues(call: number): unknown[] {
  return (mockSql.mock.calls[call] ?? []).slice(1);
}

describe('lookupAnchorLegs', () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  it('returns an empty map without querying for empty input', async () => {
    const result = await lookupAnchorLegs([]);
    expect(result.size).toBe(0);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('answers 3 requests with exactly two queries', async () => {
    mockSql
      .mockResolvedValueOnce([
        dbRow(1, { ws_trade_id: 'anchor-ml' }),
        dbRow(2, {
          ws_trade_id: 'anchor-single',
          option_chain: 'AAPL261030P00250000',
          trade_code: 'auto',
        }),
        // request 3 has no print in its window → no row
      ])
      .mockResolvedValueOnce([
        dbRow(1, { ws_trade_id: 'anchor-ml' }), // the anchor itself
        dbRow(1, {
          ws_trade_id: 'sib-1',
          option_chain: 'TSLA261030C00730000',
          strike: '730.0000',
          price: '0.9000',
        }),
      ]);

    const result = await lookupAnchorLegs([
      request('fire-ml', 'TSLA261030C00726500'),
      request('fire-single', 'AAPL261030P00250000', 'AAPL'),
      request('fire-none', 'NVDA261030C00200000', 'NVDA'),
    ]);

    expect(mockSql).toHaveBeenCalledTimes(2);

    // Query 1: one row per request, chain + window arrays.
    expect(boundValues(0)).toEqual([
      ['TSLA261030C00726500', 'AAPL261030P00250000', 'NVDA261030C00200000'],
      [
        '2026-10-29T13:38:20.000Z',
        '2026-10-29T13:38:20.000Z',
        '2026-10-29T13:38:20.000Z',
      ],
      [
        '2026-10-29T13:39:20.000Z',
        '2026-10-29T13:39:20.000Z',
        '2026-10-29T13:39:20.000Z',
      ],
    ]);
    // Query 2: only the multi-leg anchor's (ticker, ms) pair.
    expect(boundValues(1)).toEqual([['TSLA'], [MS_ISO], MULTI_LEG_TRADE_CODES]);

    expect(result.get('fire-ml')).toEqual({
      anchorWsTradeId: 'anchor-ml',
      anchorTradeCode: 'mlet',
      legKind: 'multi_leg',
      spreadShape: 'vertical',
      spreadLegs: [
        {
          optionType: 'C',
          strike: 726.5,
          expiry: '2026-10-30',
          size: 10,
          price: 2.13,
          tradeCode: 'mlet',
        },
        {
          optionType: 'C',
          strike: 730,
          expiry: '2026-10-30',
          size: 10,
          price: 0.9,
          tradeCode: 'mlet',
        },
      ],
    });
    expect(result.get('fire-single')).toEqual({
      anchorWsTradeId: 'anchor-single',
      anchorTradeCode: 'auto',
      legKind: 'single',
      spreadShape: null,
      spreadLegs: null,
    });
  });

  it('maps a request with no print in its window to null', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await lookupAnchorLegs([
      request('fire-none', 'NVDA261030C00200000', 'NVDA'),
    ]);
    expect(result.has('fire-none')).toBe(true);
    expect(result.get('fire-none')).toBeNull();
  });

  it('normalises Neon string NUMERICs and Date expiries', async () => {
    mockSql
      .mockResolvedValueOnce([
        dbRow(1, {
          strike: '927.5000',
          price: '12.3400',
          size: '3',
          expiry: new Date('2026-11-20T00:00:00.000Z'),
        }),
      ])
      .mockResolvedValueOnce([
        dbRow(1, {
          ws_trade_id: 'sib',
          option_chain: 'TSLA261120C00930000',
          strike: '930.0000',
          price: '10.0000',
          size: 3,
          expiry: new Date('2026-11-20T00:00:00.000Z'),
        }),
      ]);
    const result = await lookupAnchorLegs([
      request('k', 'TSLA261120C00927500'),
    ]);
    expect(result.get('k')?.spreadLegs).toEqual([
      {
        optionType: 'C',
        strike: 927.5,
        expiry: '2026-11-20',
        size: 3,
        price: 12.34,
        tradeCode: 'mlet',
      },
      {
        optionType: 'C',
        strike: 930,
        expiry: '2026-11-20',
        size: 3,
        price: 10,
        tradeCode: 'mlet',
      },
    ]);
  });

  it('treats an empty trade_code as no code (legKind null)', async () => {
    mockSql.mockResolvedValueOnce([dbRow(1, { trade_code: '' })]);
    const result = await lookupAnchorLegs([
      request('k', 'TSLA261030C00726500'),
    ]);
    expect(result.get('k')).toMatchObject({
      anchorTradeCode: null,
      legKind: null,
    });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('skips the sibling query when no anchor is multi-leg', async () => {
    mockSql.mockResolvedValueOnce([
      dbRow(1, { trade_code: 'auto' }),
      dbRow(2, { trade_code: 'tlet' }),
    ]);
    const result = await lookupAnchorLegs([
      request('a', 'TSLA261030C00726500'),
      request('b', 'TSLA261030C00730000'),
    ]);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(result.get('a')?.legKind).toBe('single');
    expect(result.get('b')?.legKind).toBe('stock_tied');
  });

  it('queries a (ticker, ms) pair once when two anchors share it', async () => {
    mockSql
      .mockResolvedValueOnce([
        dbRow(1, { ws_trade_id: 'a1' }),
        dbRow(2, {
          ws_trade_id: 'a2',
          option_chain: 'TSLA261030C00730000',
          strike: '730.0000',
        }),
      ])
      .mockResolvedValueOnce([
        dbRow(1, { ws_trade_id: 'a1' }),
        dbRow(1, {
          ws_trade_id: 'a2',
          option_chain: 'TSLA261030C00730000',
          strike: '730.0000',
        }),
      ]);
    const result = await lookupAnchorLegs([
      request('k1', 'TSLA261030C00726500'),
      request('k2', 'TSLA261030C00730000'),
    ]);
    expect(boundValues(1)).toEqual([['TSLA'], [MS_ISO], MULTI_LEG_TRADE_CODES]);
    expect(result.get('k1')?.spreadLegs?.map((l) => l.strike)).toEqual([
      726.5, 730,
    ]);
    expect(result.get('k2')?.spreadLegs?.map((l) => l.strike)).toEqual([
      730, 726.5,
    ]);
  });

  it('reads a real prod millisecond as a put butterfly (TSLA 2026-10-29)', async () => {
    // Rows as returned by prod for TSLA at 13:38:50.038Z: a mesl 2:4:2 put
    // fly 392.5/395/397.5, anchored on the body.
    const fly = {
      option_type: 'P',
      expiry: new Date('2026-10-30T00:00:00.000Z'),
      executed_ms: '1793281130038',
      trade_code: 'mesl',
    };
    const body = {
      ...fly,
      idx: '1',
      ws_trade_id: '01a187e2-7e6b-7b62-88e2-e970870ad4ef',
      option_chain: 'TSLA261030P00395000',
      strike: '395.000',
      price: '2.1300',
      size: 4,
    };
    mockSql.mockResolvedValueOnce([body]).mockResolvedValueOnce([
      body,
      {
        ...fly,
        idx: '1',
        ws_trade_id: '01a187e2-7e6b-7b62-88e2-e9663e8ec357',
        option_chain: 'TSLA261030P00397500',
        strike: '397.500',
        price: '2.9200',
        size: 2,
      },
      {
        ...fly,
        idx: '1',
        ws_trade_id: '01a187e2-7e6b-7b62-88e2-e9844a02a38a',
        option_chain: 'TSLA261030P00392500',
        strike: '392.500',
        price: '1.5400',
        size: 2,
      },
    ]);
    const result = await lookupAnchorLegs([
      request('fly', 'TSLA261030P00395000'),
    ]);
    expect(boundValues(1)).toEqual([
      ['TSLA'],
      ['2026-10-29T13:38:50.038Z'],
      MULTI_LEG_TRADE_CODES,
    ]);
    const anchor = result.get('fly');
    expect(anchor?.legKind).toBe('multi_leg');
    expect(anchor?.spreadShape).toBe('butterfly');
    expect(anchor?.spreadLegs?.map((l) => [l.strike, l.size])).toEqual([
      [395, 4],
      [392.5, 2],
      [397.5, 2],
    ]);
  });

  it('propagates an anchor-query DB error', async () => {
    const err = new Error('relation "ws_option_trades" does not exist');
    mockSql.mockRejectedValueOnce(err);
    await expect(
      lookupAnchorLegs([request('k', 'TSLA261030C00726500')]),
    ).rejects.toBe(err);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('propagates a sibling-query DB error', async () => {
    const err = new Error('column "raw_payload" does not exist');
    mockSql.mockResolvedValueOnce([dbRow(1)]).mockRejectedValueOnce(err);
    await expect(
      lookupAnchorLegs([request('k', 'TSLA261030C00726500')]),
    ).rejects.toBe(err);
    expect(mockSql).toHaveBeenCalledTimes(2);
  });
});
