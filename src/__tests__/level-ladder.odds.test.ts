import { describe, expect, it } from 'vitest';

import {
  carryForwardExpectedMove,
  finishBeyondProbability,
  formatOddsLine,
  formatOneDecimal,
  formatPercent,
  formatSigma,
  statusForSigma,
  strikeOdds,
  touchProbability,
} from '../components/Gexbot/level-ladder/odds';
import {
  LADDER_CLEAR_SIGMA,
  LADDER_TESTED_SIGMA,
} from '../components/Gexbot/level-ladder/types';

/** A percentage at one decimal, the precision the spec states it to. */
const pct1 = (p: number) => (p * 100).toFixed(1);

describe('finishBeyondProbability and touchProbability: known points', () => {
  it.each([
    // [σ away, finish beyond %, touch %]
    [1.0, '15.9', '31.7'],
    [1.28, '10.0', '20.1'],
    [0.5, '30.9', '61.7'],
    [2.0, '2.3', '4.6'],
  ] as const)(
    '%fσ gives finish %s%% and touch %s%%',
    (sigma, finish, touch) => {
      expect(pct1(finishBeyondProbability(sigma))).toBe(finish);
      expect(pct1(touchProbability(sigma))).toBe(touch);
    },
  );

  it.each([
    // The spec's "At the boundary" column, printed.
    [LADDER_CLEAR_SIGMA, '23%', '12%'],
    [LADDER_TESTED_SIGMA, '32%', '16%'],
  ] as const)('%fσ prints touch %s and finish %s', (sigma, touch, finish) => {
    expect(formatPercent(touchProbability(sigma))).toBe(touch);
    expect(formatPercent(finishBeyondProbability(sigma))).toBe(finish);
  });
});

describe('strikeOdds', () => {
  it('gives the same odds on the call and the put side at the same distance', () => {
    const call = strikeOdds('call', 7620, 7588.4, 23);
    const put = strikeOdds('put', 7556.8, 7588.4, 23);
    expect(call).not.toBeNull();
    expect(put).not.toBeNull();
    expect(put!.sigmaAway).toBeCloseTo(call!.sigmaAway, 12);
    expect(put!.finishBeyond).toBeCloseTo(call!.finishBeyond!, 12);
    expect(put!.touch).toBeCloseTo(call!.touch!, 12);
    expect(put!.status).toBe(call!.status);
  });

  it('measures toward the money: (K − S) / E for a call, (S − K) / E for a put', () => {
    expect(strikeOdds('call', 7620, 7588.4, 23)!.sigmaAway).toBeCloseTo(
      31.6 / 23,
      12,
    );
    expect(strikeOdds('put', 7555, 7588.4, 23)!.sigmaAway).toBeCloseTo(
      33.4 / 23,
      12,
    );
    // A call below spot and a put above it are past the strike.
    expect(strikeOdds('call', 7580, 7588.4, 23)!.sigmaAway).toBeLessThan(0);
    expect(strikeOdds('put', 7600, 7588.4, 23)!.sigmaAway).toBeLessThan(0);
  });

  it('carries the sample ladder: call 7,620 and put 7,555 at spot 7,588.4, E 23', () => {
    const call = strikeOdds('call', 7620, 7588.4, 23)!;
    expect(call.status).toBe('clear');
    expect(formatOddsLine(call)).toBe('1.37σ · touch 17% · finish beyond 8%');
    const put = strikeOdds('put', 7555, 7588.4, 23)!;
    expect(put.status).toBe('clear');
    expect(formatOddsLine(put)).toBe('1.45σ · touch 15% · finish beyond 7%');
  });

  it('carries the phase 4 sample: spot 7,612.6 with ±8.1 left', () => {
    const call = strikeOdds('call', 7620, 7612.6, 8.1)!;
    expect(call.status).toBe('tested');
    expect(formatOddsLine(call)).toBe('0.91σ · touch 36% · finish beyond 18%');
    const put = strikeOdds('put', 7555, 7612.6, 8.1)!;
    expect(put.status).toBe('clear');
    expect(formatOddsLine(put)).toBe(
      '7.1σ · touch under 1% · finish beyond under 1%',
    );
  });

  it.each([
    ['null', null],
    ['zero', 0],
    ['negative', -5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ] as const)('a %s expected move gives no odds and no status', (_, e) => {
    expect(strikeOdds('call', 7620, 7588.4, e)).toBeNull();
    expect(strikeOdds('put', 7555, 7588.4, e)).toBeNull();
  });

  it('a breached strike carries no touch and no finish beyond, only how far past it spot is', () => {
    const odds = strikeOdds('call', 7620, 7622.4, 23)!;
    expect(odds.status).toBe('breached');
    expect(odds.touch).toBeNull();
    expect(odds.finishBeyond).toBeNull();
    expect(odds.pointsPast).toBeCloseTo(2.4, 9);
    const put = strikeOdds('put', 7555, 7550, 23)!;
    expect(put.status).toBe('breached');
    expect(put.pointsPast).toBeCloseTo(5, 9);
  });

  it('a strike spot sits exactly on is breached, zero points past it', () => {
    const odds = strikeOdds('put', 7590, 7590, 23)!;
    expect(odds.sigmaAway).toBe(0);
    expect(odds.status).toBe('breached');
    expect(odds.pointsPast).toBe(0);
  });

  it('a strike not yet reached has no points past', () => {
    expect(strikeOdds('call', 7620, 7588.4, 23)!.pointsPast).toBeNull();
  });
});

describe('statusForSigma', () => {
  it.each([
    [1.2, 'clear'],
    [1.6, 'clear'],
    [1.1999, 'watch'],
    [1.0, 'watch'],
    [0.9999, 'tested'],
    [0.0001, 'tested'],
    [0, 'breached'],
    [-0.3, 'breached'],
  ] as const)('%fσ is %s', (sigma, status) => {
    expect(statusForSigma(sigma)).toBe(status);
  });

  it('uses the two threshold constants', () => {
    expect(LADDER_CLEAR_SIGMA).toBe(1.2);
    expect(LADDER_TESTED_SIGMA).toBe(1.0);
  });
});

describe('touchProbability', () => {
  it.each([0, -0.01, -0.5, -3, 0.01, 0.2, 1, 4])(
    'never exceeds 1 (at %fσ)',
    (sigma) => {
      expect(touchProbability(sigma)).toBeLessThanOrEqual(1);
      expect(touchProbability(sigma)).toBeGreaterThan(0);
    },
  );

  it('is capped at exactly 1 at and past the strike, where 2 × finish ≥ 1', () => {
    expect(touchProbability(0)).toBe(1);
    expect(touchProbability(-0.5)).toBe(1);
    expect(2 * finishBeyondProbability(-0.5)).toBeGreaterThan(1);
  });
});

describe('carryForwardExpectedMove', () => {
  const ASOF = '2026-11-25T20:53:00.000Z';
  const asOfMs = Date.parse(ASOF);
  const MIN = 60_000;
  /** A row sized with `minutesLeft` of the session to go. */
  const row = (minutesLeft: number, expectedMove: number | null = 10) => ({
    expectedMove,
    dteFraction: minutesLeft / 1440,
    asOf: ASOF,
  });

  it('a row stamped with 7 min left, read 2 min later, gives E × √(5 ÷ 7)', () => {
    expect(carryForwardExpectedMove(row(7), asOfMs + 2 * MIN)).toBeCloseTo(
      10 * Math.sqrt(5 / 7),
      12,
    );
  });

  it('read at its own stamp, the row is unchanged', () => {
    expect(carryForwardExpectedMove(row(30, 23), asOfMs)).toBe(23);
  });

  it('a row stamped after now never widens E (elapsed time clamps at 0)', () => {
    expect(carryForwardExpectedMove(row(30, 23), asOfMs - 5 * MIN)).toBe(23);
  });

  it.each([
    ['exactly at expiry', 7],
    ['past expiry', 9],
  ] as const)('T_now ≤ 0 gives no E (%s)', (_, minutesLater) => {
    expect(
      carryForwardExpectedMove(row(7), asOfMs + minutesLater * MIN),
    ).toBeNull();
  });

  it.each([
    ['a null expected move', { ...row(30), expectedMove: null }],
    ['a zero expected move', { ...row(30), expectedMove: 0 }],
    ['a negative expected move', { ...row(30), expectedMove: -4 }],
    ['a NaN expected move', { ...row(30), expectedMove: Number.NaN }],
    ['a null dteFraction', { ...row(30), dteFraction: null }],
    ['a zero dteFraction', { ...row(30), dteFraction: 0 }],
    ['an unreadable asOf', { ...row(30), asOf: 'not a time' }],
  ])('%s gives no E', (_, r) => {
    expect(carryForwardExpectedMove(r, asOfMs)).toBeNull();
  });
});

describe('printing', () => {
  it.each([
    [0, 'under 1%'],
    [0.004, 'under 1%'],
    [0.0099, 'under 1%'],
    [0.01, '1%'],
    [0.084, '8%'],
    [0.1694, '17%'],
    [0.5, '50%'],
    [0.99, '99%'],
    [0.9901, 'over 99%'],
    [1, 'over 99%'],
  ] as const)('percent %f prints %s', (p, text) => {
    expect(formatPercent(p)).toBe(text);
  });

  it.each([
    [0.9136, '0.91σ'],
    [1.3739, '1.37σ'],
    [2.994, '2.99σ'],
    [3, '3.0σ'],
    [3.04, '3.0σ'],
    [7.111, '7.1σ'],
  ] as const)('σ %f prints %s: two decimals below 3, one from 3 up', (s, t) => {
    expect(formatSigma(s)).toBe(t);
  });

  it.each([
    [2.4, '2.4'],
    [31.6000000004, '31.6'],
    [1234.56, '1,234.6'],
    [7588.4, '7,588.4'],
    [0, '0.0'],
  ] as const)('points and spot-like prices: %f prints as %s', (n, text) => {
    expect(formatOneDecimal(n)).toBe(text);
  });

  it('a breached strike prints no touch and no finish beyond', () => {
    const line = formatOddsLine(strikeOdds('call', 7620, 7622.4, 23)!);
    expect(line).toBe('spot is 2.4 pts past it');
    expect(line).not.toMatch(/touch|finish/);
  });

  it('spot exactly on a breached strike prints "spot is at it"', () => {
    expect(formatOddsLine(strikeOdds('call', 7620, 7620, 23)!)).toBe(
      'spot is at it',
    );
  });
});
