// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { toOccSymbol, parseOccSymbol, parseFreeText } from '../_lib/occ.js';

describe('toOccSymbol', () => {
  it('builds NVDA 225P 05/22/26 → "NVDA  260522P00225000"', () => {
    expect(
      toOccSymbol({
        ticker: 'NVDA',
        expiry: '2026-05-22',
        side: 'P',
        strike: 225,
      }),
    ).toBe('NVDA  260522P00225000');
  });

  it('builds AMD 397.5P 05/22/26 → "AMD   260522P00397500"', () => {
    expect(
      toOccSymbol({
        ticker: 'AMD',
        expiry: '2026-05-22',
        side: 'P',
        strike: 397.5,
      }),
    ).toBe('AMD   260522P00397500');
  });

  it('builds AAPL 180C 06/19/26 → "AAPL  260619C00180000"', () => {
    expect(
      toOccSymbol({
        ticker: 'AAPL',
        expiry: '2026-06-19',
        side: 'C',
        strike: 180,
      }),
    ).toBe('AAPL  260619C00180000');
  });

  it('right-pads 1-char ticker to 6 spaces', () => {
    const occ = toOccSymbol({
      ticker: 'A',
      expiry: '2026-05-22',
      side: 'C',
      strike: 100,
    });
    expect(occ).toBe('A     260522C00100000');
    expect(occ).toHaveLength(21);
  });

  it('right-pads 6-char ticker without modification', () => {
    expect(
      toOccSymbol({
        ticker: 'BRKB',
        expiry: '2026-05-22',
        side: 'C',
        strike: 400,
      }),
    ).toBe('BRKB  260522C00400000');
  });

  it('handles fractional strike via Math.round (4.5 → 00004500)', () => {
    expect(
      toOccSymbol({
        ticker: 'F',
        expiry: '2026-05-22',
        side: 'C',
        strike: 4.5,
      }),
    ).toBe('F     260522C00004500');
  });

  it('handles 4-digit strike (1000 → 01000000)', () => {
    expect(
      toOccSymbol({
        ticker: 'GOOG',
        expiry: '2026-05-22',
        side: 'C',
        strike: 1000,
      }),
    ).toBe('GOOG  260522C01000000');
  });

  it('accepts Date instance for expiry', () => {
    expect(
      toOccSymbol({
        ticker: 'NVDA',
        expiry: new Date(Date.UTC(2026, 4, 22)),
        side: 'P',
        strike: 225,
      }),
    ).toBe('NVDA  260522P00225000');
  });

  it('produces exactly 21 characters for every valid input', () => {
    const occ = toOccSymbol({
      ticker: 'SPY',
      expiry: '2026-12-31',
      side: 'C',
      strike: 595.25,
    });
    expect(occ).toHaveLength(21);
    expect(occ).toBe('SPY   261231C00595250');
  });

  it('throws on ticker > 6 chars', () => {
    expect(() =>
      toOccSymbol({
        ticker: 'TOOLONG',
        expiry: '2026-05-22',
        side: 'C',
        strike: 100,
      }),
    ).toThrow(/exceeds 6 characters/);
  });

  it('throws on empty ticker', () => {
    expect(() =>
      toOccSymbol({
        ticker: '',
        expiry: '2026-05-22',
        side: 'C',
        strike: 100,
      }),
    ).toThrow(/non-empty string/);
  });

  it('throws on ticker with whitespace', () => {
    expect(() =>
      toOccSymbol({
        ticker: 'NV DA',
        expiry: '2026-05-22',
        side: 'C',
        strike: 100,
      }),
    ).toThrow(/whitespace/);
  });

  it("throws on lowercase side 'p'", () => {
    expect(() =>
      toOccSymbol({
        ticker: 'NVDA',
        expiry: '2026-05-22',
        // @ts-expect-error — runtime guard
        side: 'p',
        strike: 225,
      }),
    ).toThrow(/side must be 'C' or 'P'/);
  });

  it('throws on non-numeric strike', () => {
    expect(() =>
      toOccSymbol({
        ticker: 'NVDA',
        expiry: '2026-05-22',
        side: 'P',
        // @ts-expect-error — runtime guard
        strike: '225',
      }),
    ).toThrow(/finite positive number/);
  });

  it('throws on zero / negative strike', () => {
    expect(() =>
      toOccSymbol({
        ticker: 'NVDA',
        expiry: '2026-05-22',
        side: 'P',
        strike: 0,
      }),
    ).toThrow(/finite positive number/);
    expect(() =>
      toOccSymbol({
        ticker: 'NVDA',
        expiry: '2026-05-22',
        side: 'P',
        strike: -10,
      }),
    ).toThrow();
  });

  it('throws on malformed expiry string', () => {
    expect(() =>
      toOccSymbol({
        ticker: 'NVDA',
        expiry: '05/22/2026',
        side: 'P',
        strike: 225,
      }),
    ).toThrow(/YYYY-MM-DD/);
  });

  it('throws on Invalid Date', () => {
    expect(() =>
      toOccSymbol({
        ticker: 'NVDA',
        expiry: new Date('not-a-date'),
        side: 'P',
        strike: 225,
      }),
    ).toThrow(/Invalid Date/);
  });

  it('throws on non-existent calendar date (2026-02-30)', () => {
    expect(() =>
      toOccSymbol({
        ticker: 'NVDA',
        expiry: '2026-02-30',
        side: 'P',
        strike: 225,
      }),
    ).toThrow(/not a real calendar date/);
  });
});

describe('parseOccSymbol', () => {
  it('parses NVDA  260522P00225000', () => {
    expect(parseOccSymbol('NVDA  260522P00225000')).toEqual({
      ticker: 'NVDA',
      expiry: '2026-05-22',
      side: 'P',
      strike: 225,
    });
  });

  it('parses AMD   260522P00397500 with fractional strike', () => {
    expect(parseOccSymbol('AMD   260522P00397500')).toEqual({
      ticker: 'AMD',
      expiry: '2026-05-22',
      side: 'P',
      strike: 397.5,
    });
  });

  it('parses 1-char ticker padded to 6', () => {
    expect(parseOccSymbol('A     260522C00100000')).toEqual({
      ticker: 'A',
      expiry: '2026-05-22',
      side: 'C',
      strike: 100,
    });
  });

  it('throws on wrong length', () => {
    expect(() => parseOccSymbol('NVDA  260522P0022500')).toThrow(/21/);
    expect(() => parseOccSymbol('')).toThrow(/21/);
  });

  it('throws on invalid side', () => {
    expect(() => parseOccSymbol('NVDA  260522X00225000')).toThrow(/side/);
  });

  it('throws on non-numeric date segment', () => {
    expect(() => parseOccSymbol('NVDA  AB0522P00225000')).toThrow(
      /date segment/,
    );
  });

  it('throws on non-numeric strike segment', () => {
    expect(() => parseOccSymbol('NVDA  260522P0022500X')).toThrow(
      /strike segment/,
    );
  });

  it('throws on out-of-range month', () => {
    expect(() => parseOccSymbol('NVDA  261322P00225000')).toThrow(
      /out-of-range/,
    );
  });
});

describe('toOccSymbol / parseOccSymbol roundtrip', () => {
  const cases: Array<{
    ticker: string;
    expiry: string;
    side: 'C' | 'P';
    strike: number;
  }> = [
    { ticker: 'NVDA', expiry: '2026-05-22', side: 'P', strike: 225 },
    { ticker: 'AMD', expiry: '2026-05-22', side: 'P', strike: 397.5 },
    { ticker: 'AAPL', expiry: '2026-06-19', side: 'C', strike: 180 },
    { ticker: 'A', expiry: '2026-05-22', side: 'C', strike: 100 },
    { ticker: 'GOOG', expiry: '2026-05-22', side: 'C', strike: 1000 },
    { ticker: 'F', expiry: '2026-05-22', side: 'C', strike: 4.5 },
    { ticker: 'SPY', expiry: '2026-12-31', side: 'C', strike: 595.25 },
    { ticker: 'BRKB', expiry: '2026-05-22', side: 'C', strike: 400 },
  ];

  for (const c of cases) {
    it(`roundtrip ${c.ticker} ${String(c.strike)}${c.side} ${c.expiry}`, () => {
      const occ = toOccSymbol(c);
      expect(parseOccSymbol(occ)).toEqual(c);
    });
  }
});

describe('parseFreeText — happy paths', () => {
  it('full form: NVDA 225P 05/22/26 @ 4.30 x 5 long', () => {
    const r = parseFreeText('NVDA 225P 05/22/26 @ 4.30 x 5 long');
    expect(r.ticker).toBe('NVDA');
    expect(r.strike).toBe(225);
    expect(r.side).toBe('P');
    expect(r.expiry.toISOString().slice(0, 10)).toBe('2026-05-22');
    expect(r.entry_price).toBe(4.3);
    expect(r.quantity).toBe(5);
    expect(r.direction).toBe('long');
  });

  it('omits direction → defaults to long', () => {
    const r = parseFreeText('NVDA 225P 05/22/26 @ 4.30 x 5');
    expect(r.direction).toBe('long');
    expect(r.entry_price).toBe(4.3);
    expect(r.quantity).toBe(5);
  });

  it('accepts 4-digit year', () => {
    const r = parseFreeText('NVDA 225P 05/22/2026 @ 4.30 x 5');
    expect(r.expiry.toISOString().slice(0, 10)).toBe('2026-05-22');
  });

  it('explicit "short" prefix', () => {
    const r = parseFreeText('short NVDA 225P 05/22/26 @ 4.30 x 5');
    expect(r.direction).toBe('short');
    expect(r.ticker).toBe('NVDA');
  });

  it('trailing "short" overrides prefix-less default', () => {
    const r = parseFreeText('NVDA 225P 05/22/26 @ 4.30 x 5 short');
    expect(r.direction).toBe('short');
  });

  it('no entry, no qty — just the contract', () => {
    const r = parseFreeText('NVDA 225C 05/22/26');
    expect(r.ticker).toBe('NVDA');
    expect(r.strike).toBe(225);
    expect(r.side).toBe('C');
    expect(r.expiry.toISOString().slice(0, 10)).toBe('2026-05-22');
    expect(r.entry_price).toBeUndefined();
    expect(r.quantity).toBeUndefined();
    expect(r.direction).toBe('long');
  });

  it('handles fractional strike (397.5P)', () => {
    const r = parseFreeText('AMD 397.5P 05/22/26 @ 5.72 x 3');
    expect(r.ticker).toBe('AMD');
    expect(r.strike).toBe(397.5);
    expect(r.entry_price).toBe(5.72);
  });

  it('roundtrips through toOccSymbol', () => {
    const r = parseFreeText('NVDA 225P 05/22/26 @ 4.30 x 5');
    const occ = toOccSymbol({
      ticker: r.ticker,
      expiry: r.expiry,
      side: r.side,
      strike: r.strike,
    });
    expect(occ).toBe('NVDA  260522P00225000');
  });

  it('lowercase "long" / "short" tokens accepted', () => {
    const r = parseFreeText('LONG NVDA 225P 05/22/26 @ 4.30 x 5');
    expect(r.direction).toBe('long');
  });

  it('tolerates extra whitespace around @ and x', () => {
    const r = parseFreeText('NVDA 225P 05/22/26   @   4.30   x   5');
    expect(r.entry_price).toBe(4.3);
    expect(r.quantity).toBe(5);
  });
});

describe('parseFreeText — errors', () => {
  it('throws on empty string', () => {
    expect(() => parseFreeText('')).toThrow(/empty/);
    expect(() => parseFreeText('   ')).toThrow(/empty/);
  });

  it('throws on gibberish', () => {
    expect(() => parseFreeText('hello world')).toThrow(/could not parse/);
    expect(() => parseFreeText('!@#$%^')).toThrow(/could not parse/);
  });

  it("throws on lowercase side 'p'", () => {
    expect(() => parseFreeText('NVDA 225p 05/22/26 @ 4.30 x 5')).toThrow(
      /uppercase/,
    );
  });

  it("throws on lowercase side 'c'", () => {
    expect(() => parseFreeText('NVDA 225c 05/22/26 @ 4.30 x 5')).toThrow(
      /uppercase/,
    );
  });

  it('throws on ticker > 6 chars', () => {
    expect(() => parseFreeText('TOOLONG 225P 05/22/26 @ 4.30 x 5')).toThrow(
      /could not parse/,
    );
  });

  it('throws on invalid date (13/22/26)', () => {
    expect(() => parseFreeText('NVDA 225P 13/22/26 @ 4.30 x 5')).toThrow(
      /out-of-range/,
    );
  });

  it('throws on non-existent calendar date (02/30/26)', () => {
    expect(() => parseFreeText('NVDA 225P 02/30/26 @ 4.30 x 5')).toThrow(
      /not a real calendar date/,
    );
  });

  it('throws on missing date', () => {
    expect(() => parseFreeText('NVDA 225P @ 4.30 x 5')).toThrow(
      /could not parse/,
    );
  });

  it('throws on missing strike+side', () => {
    expect(() => parseFreeText('NVDA 05/22/26 @ 4.30 x 5')).toThrow(
      /could not parse/,
    );
  });

  it('throws on negative entry price (not matched by regex)', () => {
    // Regex requires digits — "-4.30" cannot match the entry slot.
    expect(() => parseFreeText('NVDA 225P 05/22/26 @ -4.30 x 5')).toThrow(
      /could not parse/,
    );
  });

  it('throws on zero quantity', () => {
    expect(() => parseFreeText('NVDA 225P 05/22/26 @ 4.30 x 0')).toThrow(
      /invalid quantity/,
    );
  });
});
