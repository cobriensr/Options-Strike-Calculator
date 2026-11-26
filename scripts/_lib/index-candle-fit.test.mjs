// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toIndexRows } from './candles-backfill.mjs';
import { FIT, fitRatio, levelCheck, readSpots } from './index-candle-fit.mjs';

// 2026-08-12 is a Wednesday in EDT: 390 cash minutes, regular 13:30Z-19:59Z.
const DATE = '2026-08-12';
const OPEN = '2026-08-12T13:30:00Z';
// 2026-11-27 is the half day after Thanksgiving, EST: 210 cash minutes,
// regular 14:30Z-17:59Z.
const HALF_DATE = '2026-11-27';
const HALF_OPEN = '2026-11-27T14:30:00Z';

const MINUTE_MS = 60_000;

/** A UW 1-minute bar, prices as strings the way UW sends them. */
function bar(startTime, close, overrides = {}) {
  return {
    start_time: startTime,
    open: String(close),
    high: String(close),
    low: String(close),
    close: String(close),
    volume: 1200,
    market_time: 'r',
    ...overrides,
  };
}

/** `n` consecutive regular bars from `open`; `closeAt(i)` is bar i's close. */
function regularDay(open, n, closeAt = () => 637) {
  const start = Date.parse(open);
  return Array.from({ length: n }, (_, i) =>
    bar(new Date(start + i * MINUTE_MS).toISOString(), closeAt(i)),
  );
}

/** The price file's key for a bar: its start as a UTC epoch minute. */
function minuteOf(b) {
  return Math.floor(Date.parse(b.start_time) / MINUTE_MS);
}

/**
 * A readSpots-shaped answer holding a price for each bar in `bars` that
 * `priceOf(bar, i)` gives one for (null or undefined leaves the minute out).
 */
function spotsFor(bars, priceOf, source = 'tape') {
  const minutes = new Map();
  bars.forEach((b, i) => {
    const price = priceOf(b, i);
    if (price != null) minutes.set(minuteOf(b), price);
  });
  return { ok: true, source, minutes };
}

/** Prices exactly `ratio` times each bar's close. */
const times = (ratio) => (b) => Number(b.close) * ratio;

/** Closes that move bar to bar, so a wrong pairing could not hide. */
const wobble = (i) => 637 + (i % 7) * 0.5;

function fit(overrides) {
  return fitRatio({
    symbol: 'SPX',
    date: DATE,
    closeRatio: 10.04,
    ...overrides,
  });
}

describe('FIT', () => {
  it('holds the bounds the spec fixes', () => {
    expect(FIT).toEqual({
      spxMinShare: 0.99,
      ndxMinMinutes: 150,
      ndxMaxScatter: 6,
      maxDeviation: 0.0015,
      levelBound: { SPX: 2, NDX: 6 },
    });
  });
});

describe('fitRatio', () => {
  it('fits a day priced exactly ETF x 10.04 to ratio 10.04 and scatter 0', () => {
    const bars = regularDay(OPEN, 390, wobble);

    const out = fit({ bars, spots: spotsFor(bars, times(10.04)) });

    expect(out.ok).toBe(true);
    expect(out.ratio).toBeCloseTo(10.04, 10);
    expect(out.scatter).toBeCloseTo(0, 8);
    expect(out.matched).toBe(390);
  });

  it('accepts the readSpots answer itself, ok flag and all', () => {
    const bars = regularDay(OPEN, 390);
    const spots = spotsFor(bars, times(10.04));

    expect(fit({ bars, spots }).ok).toBe(true);
    expect(fit({ bars, spots: { ...spots, ok: undefined } }).ok).toBe(true);
  });

  it('is the median of price / close: a few wild minutes do not move it', () => {
    const bars = regularDay(OPEN, 390, wobble);
    const spots = spotsFor(bars, (b, i) =>
      i % 39 === 0 ? Number(b.close) * 25 : Number(b.close) * 10.04,
    );

    const out = fit({ bars, spots });

    expect(out.ok).toBe(true);
    expect(out.ratio).toBeCloseTo(10.04, 10);
  });

  it('takes the mean of the two middle ratios when the count is even', () => {
    const bars = regularDay(OPEN, 390);
    // 195 minutes at 10.00 and 195 at 10.02: the median sits between them.
    const spots = spotsFor(
      bars,
      (b, i) => Number(b.close) * (i < 195 ? 10 : 10.02),
    );

    const out = fit({ bars, spots, closeRatio: 10.01 });

    expect(out.ok).toBe(true);
    expect(out.ratio).toBeCloseTo(10.01, 10);
  });

  it('matches a bar to the price file by its start minute, not its end', () => {
    // 150 bars two minutes apart, so a price keyed on a bar's end minute (its
    // start + 1) is no other bar's start.
    const start = Date.parse(OPEN);
    const bars = Array.from({ length: 150 }, (_, i) =>
      bar(new Date(start + 2 * i * MINUTE_MS).toISOString(), 573),
    );
    const byStart = spotsFor(bars, times(41), 'parity');
    const byEnd = {
      ...byStart,
      minutes: new Map([...byStart.minutes].map(([m, p]) => [m + 1, p])),
    };
    const ndx = (spots) =>
      fitRatio({ symbol: 'NDX', date: DATE, bars, spots, closeRatio: 41 });

    expect(ndx(byStart)).toMatchObject({ ok: true, matched: 150 });
    const out = ndx(byEnd);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('matched minutes 0 ');
  });

  describe('SPX matched minutes', () => {
    it('fails at 386 of 390 and passes at 387, the ceil of 99%', () => {
      const bars = regularDay(OPEN, 390);

      const at386 = fit({
        bars,
        spots: spotsFor(bars, (b, i) =>
          i < 386 ? Number(b.close) * 10.04 : null,
        ),
      });
      const at387 = fit({
        bars,
        spots: spotsFor(bars, (b, i) =>
          i < 387 ? Number(b.close) * 10.04 : null,
        ),
      });

      expect(at386.ok).toBe(false);
      expect(at386.reason).toBe(
        'matched minutes 386 is under the 387 an SPX day needs ' +
          '(99% of its 390 cash minutes)',
      );
      expect(at387.ok).toBe(true);
      expect(at387.matched).toBe(387);
    });

    it('needs 208 of a half day of 210 minutes', () => {
      const bars = regularDay(HALF_OPEN, 210);
      const upTo = (n) => (b, i) => (i < n ? Number(b.close) * 10.04 : null);

      const at207 = fit({
        date: HALF_DATE,
        bars,
        spots: spotsFor(bars, upTo(207)),
      });
      const at208 = fit({
        date: HALF_DATE,
        bars,
        spots: spotsFor(bars, upTo(208)),
      });

      expect(at207.ok).toBe(false);
      expect(at207.reason).toContain('matched minutes 207');
      expect(at207.reason).toContain('208');
      expect(at208.ok).toBe(true);
    });

    it('counts only the minutes UW sent a bar for, even with a full price file', () => {
      const bars = regularDay(OPEN, 386);
      const full = regularDay(OPEN, 390);

      const out = fit({ bars, spots: spotsFor(full, times(10.04)) });

      expect(out.ok).toBe(false);
      expect(out.reason).toContain('matched minutes 386');
    });

    it('fails a day with no bar matched, with a reason, never a NaN ratio', () => {
      const out = fit({
        bars: regularDay(OPEN, 390),
        spots: { source: 'tape', minutes: new Map() },
      });

      expect(out.ok).toBe(false);
      expect(out.reason).toContain('matched minutes 0');
    });

    it('fails a date with no cash session, with a reason, never a NaN ratio', () => {
      // 2026-08-15 is a Saturday: cashSessionMinutes is 0.
      const out = fit({
        date: '2026-08-15',
        bars: [],
        spots: { source: 'tape', minutes: new Map() },
      });

      expect(out.ok).toBe(false);
      expect(out.reason).toContain('matched minutes 0');
    });

    it('does not gate on scatter: SPX takes any scatter', () => {
      const bars = regularDay(OPEN, 390);
      const spots = spotsFor(
        bars,
        (b, i) => Number(b.close) * 10.04 + (i % 2 === 0 ? 40 : -40),
      );

      const out = fit({ bars, spots });

      expect(out.ok).toBe(true);
      expect(out.scatter).toBeGreaterThan(30);
    });
  });

  describe('NDX', () => {
    const ndx = (overrides) =>
      fitRatio({ symbol: 'NDX', date: DATE, closeRatio: 41, ...overrides });

    it('fails at 149 matched minutes and passes at 150', () => {
      const bars149 = regularDay(OPEN, 149, () => 573);
      const bars150 = regularDay(OPEN, 150, () => 573);

      const at149 = ndx({
        bars: bars149,
        spots: spotsFor(bars149, times(41), 'parity'),
      });
      const at150 = ndx({
        bars: bars150,
        spots: spotsFor(bars150, times(41), 'parity'),
      });

      expect(at149.ok).toBe(false);
      expect(at149.reason).toBe(
        'matched minutes 149 is under the 150 an NDX day needs',
      );
      expect(at150.ok).toBe(true);
      expect(at150.matched).toBe(150);
      expect(at150.ratio).toBeCloseTo(41, 10);
    });

    /**
     * 150 minutes at close 4 and price 164 +/- `d`, half each way: the ratio is
     * exactly 41, every residual is +/- d, and the scatter is d.
     */
    function scatterDay(d) {
      const bars = regularDay(OPEN, 150, () => 4);
      return ndx({
        bars,
        spots: spotsFor(
          bars,
          (_b, i) => (i % 2 === 0 ? 164 - d : 164 + d),
          'parity',
        ),
      });
    }

    it('passes a scatter of exactly 6 and 5.99', () => {
      const exact = scatterDay(6);
      expect(exact.ok).toBe(true);
      expect(exact.scatter).toBe(6);
      expect(exact.ratio).toBe(41);

      expect(scatterDay(5.99).ok).toBe(true);
    });

    it('fails a scatter of 6.01, naming the measure, its value and the bound', () => {
      const out = scatterDay(6.01);

      expect(out.ok).toBe(false);
      expect(out.reason).toMatch(
        /^scatter 6\.01\d* is over the 6 pt an NDX day allows$/,
      );
    });
  });

  it('measures scatter as the median of |e - median(e)|, e = price - close x ratio', () => {
    // [minutes, close, price] groups: 195 minutes at ratio 40 and 195 at 42, so
    // the fitted ratio is exactly 41 and e is -20, -1, +9 and +20 per group.
    // Median e is 4 ((-1 + 9) / 2); about it the scatter is 16. Taken about
    // zero it would be 20, so this pins the centring.
    const groups = [
      [130, 20, 800],
      [65, 1, 40],
      [65, 9, 378],
      [130, 20, 840],
    ];
    const pairs = groups.flatMap(([n, close, price]) =>
      Array.from({ length: n }, () => [close, price]),
    );
    const bars = regularDay(OPEN, 390, (i) => pairs[i][0]);

    const out = fit({
      bars,
      spots: spotsFor(bars, (_b, i) => pairs[i][1]),
      closeRatio: 41,
    });

    expect(out.ok).toBe(true);
    expect(out.ratio).toBe(41);
    expect(out.scatter).toBe(16);
  });

  describe('against the close ratio', () => {
    const deviated = (factor) => {
      const bars = regularDay(OPEN, 390, wobble);
      return fit({
        bars,
        spots: spotsFor(bars, times(10.04 * factor)),
        closeRatio: 10.04,
      });
    };

    it('fails a deviation of 0.00151, either way, naming the value and the bound', () => {
      for (const factor of [1.00151, 1 - 0.00151]) {
        const out = deviated(factor);
        expect(out.ok).toBe(false);
        expect(out.reason).toMatch(
          /^fitted ratio 10\.\d+ is 0\.0015\d* from the close ratio 10\.04, over the 0\.0015 allowed$/,
        );
      }
    });

    it('passes a deviation of 0.0014, either way', () => {
      expect(deviated(1.0014).ok).toBe(true);
      expect(deviated(1 - 0.0014).ok).toBe(true);
    });

    it('applies to NDX too', () => {
      const bars = regularDay(OPEN, 150, () => 573);

      const out = fitRatio({
        symbol: 'NDX',
        date: DATE,
        bars,
        spots: spotsFor(bars, times(41 * 1.00151), 'parity'),
        closeRatio: 41,
      });

      expect(out.ok).toBe(false);
      expect(out.reason).toContain('close ratio 41');
    });
  });

  describe('the price file source', () => {
    it('fails an SPX day on a parity file, naming both sources', () => {
      const bars = regularDay(OPEN, 390);

      const out = fit({ bars, spots: spotsFor(bars, times(10.04), 'parity') });

      expect(out.ok).toBe(false);
      expect(out.reason).toBe(
        'price file source parity is not tape, which SPX needs',
      );
    });

    it('fails an NDX day on a tape file, naming both sources', () => {
      const bars = regularDay(OPEN, 150, () => 573);

      const out = fitRatio({
        symbol: 'NDX',
        date: DATE,
        bars,
        spots: spotsFor(bars, times(41), 'tape'),
        closeRatio: 41,
      });

      expect(out.ok).toBe(false);
      expect(out.reason).toBe(
        'price file source tape is not parity, which NDX needs',
      );
    });
  });

  describe('which bars count', () => {
    it('leaves pre- and post-market bars out of the count and the median', () => {
      // 386 regular minutes, plus 12 extended-hours bars that all have a price
      // at a very different ratio: 398 matched in the file, 386 count.
      const regular = regularDay(OPEN, 386);
      const pre = regularDay('2026-08-12T08:00:00Z', 6).map((b) => ({
        ...b,
        market_time: 'pr',
      }));
      const post = regularDay('2026-08-12T20:00:00Z', 6).map((b) => ({
        ...b,
        market_time: 'po',
      }));
      const bars = [...pre, ...regular, ...post];
      const spots = spotsFor(
        bars,
        (b) => Number(b.close) * (b.market_time === 'r' ? 10.04 : 99),
      );

      const out = fit({ bars, spots });

      expect(out.ok).toBe(false);
      expect(out.reason).toContain('matched minutes 386');
    });

    it('does not let extended-hours bars move the ratio', () => {
      const regular = regularDay(OPEN, 390);
      // 330 pre-market minutes, 08:00Z to 13:29Z: none shares a minute with
      // a regular bar.
      const extended = regularDay('2026-08-12T08:00:00Z', 330).map((b) => ({
        ...b,
        market_time: 'pr',
      }));
      const bars = [...extended, ...regular];
      const spots = spotsFor(
        bars,
        (b) => Number(b.close) * (b.market_time === 'r' ? 10.04 : 99),
      );

      const out = fit({ bars, spots });

      expect(out.ok).toBe(true);
      expect(out.matched).toBe(390);
      expect(out.ratio).toBeCloseTo(10.04, 10);
    });

    it('does not count a bar toIndexRows would drop', () => {
      const bars = regularDay(OPEN, 387);
      bars[5] = { ...bars[5], volume: 10.5 };
      const spots = spotsFor(bars, times(10.04));

      const out = fit({ bars, spots });

      expect(out.ok).toBe(false);
      expect(out.reason).toContain('matched minutes 386');
    });

    it('does not count a bar with no positive close', () => {
      const bars = regularDay(OPEN, 387);
      bars[5] = { ...bars[5], close: '0' };
      const spots = spotsFor(bars, () => 6400);

      const out = fit({ bars, spots });

      expect(out.ok).toBe(false);
      expect(out.reason).toContain('matched minutes 386');
    });

    it('agrees with toIndexRows on which minutes are regular', () => {
      const bars = [
        ...regularDay('2026-08-12T08:00:00Z', 3).map((b) => ({
          ...b,
          market_time: 'pr',
        })),
        ...regularDay(OPEN, 390),
      ];
      const mapped = toIndexRows('SPX', DATE, bars, 10.04).rows.filter(
        (row) => row.market_time === 'r',
      );

      const out = fit({ bars, spots: spotsFor(bars, times(10.04)) });

      expect(out.matched).toBe(mapped.length);
    });
  });

  it('fails a symbol it has no fit for, with a reason', () => {
    const bars = regularDay(OPEN, 390);

    const out = fit({
      symbol: 'RUT',
      bars,
      spots: spotsFor(bars, times(10.04)),
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('RUT');
  });
});

describe('levelCheck', () => {
  const HIGH = 6420.5;
  const LOW = 6390.25;

  /** Regular rows reaching `HIGH + dh` and `LOW + dl`, as toIndexRows maps them. */
  function rowsAt(dh, dl, extra = []) {
    return [
      { market_time: 'r', high: HIGH + dh - 3, low: LOW + dl + 4 },
      { market_time: 'r', high: HIGH + dh, low: LOW + dl + 9 },
      { market_time: 'r', high: HIGH + dh - 8, low: LOW + dl },
      ...extra,
    ];
  }

  function check(dh, dl, symbol = 'SPX') {
    return levelCheck({ symbol, rows: rowsAt(dh, dl), high: HIGH, low: LOW });
  }

  it('fails SPX at dh 2.01 and dl 2.5, naming both, the smaller miss and the bound', () => {
    const out = check(2.01, 2.5);

    expect(out.ok).toBe(false);
    expect(out.dh).toBeCloseTo(2.01, 9);
    expect(out.dl).toBeCloseTo(2.5, 9);
    expect(out.reason).toMatch(
      /^SPX regular range misses Schwab's daily range on one side: dh \+2\.01, dl \+2\.5, the smaller miss 2\.01 is over the 2 pt allowed$/,
    );
  });

  it('fails when both misses are below the range', () => {
    const out = check(-2.01, -2.5);

    expect(out.ok).toBe(false);
    expect(out.dh).toBeCloseTo(-2.01, 9);
    expect(out.dl).toBeCloseTo(-2.5, 9);
    expect(out.reason).toContain('dh -2.01, dl -2.5');
  });

  it('passes SPX at exactly 2, and when only one side is over', () => {
    expect(check(2, 2).ok).toBe(true);
    expect(check(2, 40).ok).toBe(true);
    expect(check(2.01, 1.99).ok).toBe(true);
    expect(check(0, 0)).toMatchObject({ ok: true, dh: 0, dl: 0 });
  });

  it.each([
    [50, -50],
    [-50, 50],
    [2.5, -9],
    [-26.9, 0.5],
  ])('passes opposite signs at any size: dh %s, dl %s', (dh, dl) => {
    const out = check(dh, dl);

    expect(out.ok).toBe(true);
    expect(out.reason).toBeUndefined();
  });

  it('passes NDX at exactly 6 and fails at 6.01', () => {
    const high = 23600;
    const low = 23400.5;
    const rows = (d) => [
      { market_time: 'r', high: high + d, low: low + d },
      { market_time: 'r', high: high + d - 10, low: low + d + 10 },
    ];

    const at6 = levelCheck({ symbol: 'NDX', rows: rows(6), high, low });
    const at601 = levelCheck({ symbol: 'NDX', rows: rows(6.01), high, low });

    expect(at6).toMatchObject({ ok: true, dh: 6, dl: 6 });
    expect(at601.ok).toBe(false);
    expect(at601.reason).toContain('NDX');
    expect(at601.reason).toContain('over the 6 pt allowed');
  });

  it('reads dh from the highest regular high and dl from the lowest regular low', () => {
    const out = levelCheck({
      symbol: 'SPX',
      rows: [
        { market_time: 'r', high: 6421, low: 6395 },
        { market_time: 'r', high: 6430, low: 6392 },
        { market_time: 'r', high: 6410, low: 6388.25 },
      ],
      high: HIGH,
      low: LOW,
    });

    expect(out.dh).toBeCloseTo(9.5, 9);
    expect(out.dl).toBeCloseTo(-2, 9);
    expect(out.ok).toBe(true);
  });

  it('ignores pre- and post-market rows', () => {
    const extra = [
      { market_time: 'pr', high: HIGH + 90, low: LOW - 90 },
      { market_time: 'po', high: HIGH + 80, low: LOW - 80 },
    ];

    const out = levelCheck({
      symbol: 'SPX',
      rows: rowsAt(1, 1, extra),
      high: HIGH,
      low: LOW,
    });

    expect(out.ok).toBe(true);
    expect(out.dh).toBeCloseTo(1, 9);
    expect(out.dl).toBeCloseTo(1, 9);
  });

  it('fails a day with no regular row, with a reason', () => {
    const out = levelCheck({
      symbol: 'SPX',
      rows: [{ market_time: 'pr', high: 6400, low: 6390 }],
      high: HIGH,
      low: LOW,
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('no regular rows');
  });

  it.each([
    ['no high', { high: undefined }],
    ['a NaN low', { low: Number.NaN }],
  ])('fails, with a reason, when Schwab gives %s', (_label, overrides) => {
    const out = levelCheck({
      symbol: 'SPX',
      rows: rowsAt(0, 0),
      high: HIGH,
      low: LOW,
      ...overrides,
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('no usable Schwab daily high and low');
  });

  it('fails a symbol with no bound, never passes it', () => {
    const out = levelCheck({
      symbol: 'RUT',
      rows: rowsAt(0, 0),
      high: HIGH,
      low: LOW,
    });

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('RUT');
  });
});

describe('readSpots', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'index-candle-fit-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write a price file the way the tape tool does: JSON and a newline. */
  function put(body, name = `SPX-${DATE}-spots.json`) {
    writeFileSync(
      path.join(dir, name),
      `${typeof body === 'string' ? body : JSON.stringify(body)}\n`,
    );
  }

  const good = (overrides = {}) => ({
    symbol: 'SPX',
    date: DATE,
    source: 'tape',
    minutes: { 29_000_000: 6401.5, 29_000_001: 6402.25 },
    ...overrides,
  });

  it('reads the source and the minutes as numbers', async () => {
    put(good());

    const out = await readSpots(dir, 'SPX', DATE);

    expect(out).toEqual({
      ok: true,
      source: 'tape',
      minutes: new Map([
        [29_000_000, 6401.5],
        [29_000_001, 6402.25],
      ]),
    });
  });

  it('reads an NDX parity file from its own name', async () => {
    put(good({ symbol: 'NDX', source: 'parity' }), `NDX-${DATE}-spots.json`);

    const out = await readSpots(dir, 'NDX', DATE);

    expect(out).toMatchObject({ ok: true, source: 'parity' });
  });

  it('fails, naming the file, when there is none', async () => {
    const out = await readSpots(dir, 'SPX', DATE);

    expect(out.ok).toBe(false);
    expect(out.reason).toContain(`SPX-${DATE}-spots.json`);
    expect(out.reason).toContain('no price file');
  });

  it('fails when the directory is not one', async () => {
    const out = await readSpots(path.join(dir, 'nope', 'deeper'), 'SPX', DATE);

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('no price file');
  });

  it('fails, naming the file, when it is not JSON', async () => {
    put('{"symbol": "SPX", ');

    const out = await readSpots(dir, 'SPX', DATE);

    expect(out.ok).toBe(false);
    expect(out.reason).toContain(`SPX-${DATE}-spots.json`);
    expect(out.reason).toContain('not JSON');
  });

  it('fails, with the reason, on a file it cannot read, which is not a missing one', async () => {
    // A directory where the file should be: readFile fails with EISDIR.
    mkdirSync(path.join(dir, `SPX-${DATE}-spots.json`));

    const out = await readSpots(dir, 'SPX', DATE);

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('cannot read');
    expect(out.reason).toContain('EISDIR');
  });

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a number', '7'],
  ])('fails when the JSON is %s, not an object', async (_label, text) => {
    put(text);

    const out = await readSpots(dir, 'SPX', DATE);

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('not a JSON object');
  });

  it('fails a file for another symbol', async () => {
    put(good({ symbol: 'NDX' }));

    const out = await readSpots(dir, 'SPX', DATE);

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('symbol NDX');
    expect(out.reason).toContain('SPX');
  });

  it('fails a file for another date', async () => {
    put(good({ date: '2026-08-13' }));

    const out = await readSpots(dir, 'SPX', DATE);

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('date 2026-08-13');
    expect(out.reason).toContain(DATE);
  });

  it.each([
    ['an unknown source', { source: 'es' }],
    ['no source', { source: undefined }],
  ])('fails a file with %s', async (_label, overrides) => {
    put(good(overrides));

    const out = await readSpots(dir, 'SPX', DATE);

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('source');
  });

  it.each([
    ['an empty minutes object', { minutes: {} }],
    ['no minutes', { minutes: undefined }],
    ['minutes as an array', { minutes: [6400] }],
    ['minutes as null', { minutes: null }],
  ])('fails a file with %s', async (_label, overrides) => {
    put(good(overrides));

    const out = await readSpots(dir, 'SPX', DATE);

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('no minutes');
  });

  it.each([
    ['a fractional minute key', { 29_000_000.5: 6400 }],
    ['a text key', { soon: 6400 }],
    ['an empty key', { '': 6400 }],
    ['a negative key', { '-5': 6400 }],
    ['an exponent key', { '2.9e7': 6400 }],
  ])('fails a file with %s, naming the key', async (_label, minutes) => {
    put(good({ minutes: { 29_000_000: 6401.5, ...minutes } }));

    const out = await readSpots(dir, 'SPX', DATE);

    expect(out.ok).toBe(false);
    expect(out.reason).toContain(
      `minute key ${JSON.stringify(Object.keys(minutes)[0])}`,
    );
  });

  it.each([
    ['a text price', 'high'],
    ['a null price', null],
    ['a boolean price', true],
    ['an object price', {}],
  ])('fails a file with %s, naming the minute', async (_label, price) => {
    put(good({ minutes: { 29_000_000: 6401.5, 29_000_001: price } }));

    const out = await readSpots(dir, 'SPX', DATE);

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('minute 29000001');
    expect(out.reason).toContain('price');
  });

  it('fails a file with a price JSON cannot carry as a finite number', async () => {
    // JSON.stringify turns NaN and Infinity into null; a hand-written 1e999
    // parses to Infinity.
    put(
      `{"symbol":"SPX","date":"${DATE}","source":"tape","minutes":{"29000000":1e999}}`,
    );

    const out = await readSpots(dir, 'SPX', DATE);

    expect(out.ok).toBe(false);
    expect(out.reason).toContain('minute 29000000');
  });
});
