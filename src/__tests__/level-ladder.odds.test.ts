import { describe, expect, it } from 'vitest';

import {
  carryForwardMove,
  finishBeyondProbability,
  formatOddsLine,
  formatOneDecimal,
  formatPercent,
  formatSigma,
  inverseNormalCDF,
  strikeOdds,
  strikeStatus,
  touchProbability,
} from '../components/Gexbot/level-ladder/odds';
import {
  LADDER_CLEAR_SIGMA,
  LADDER_TESTED_SIGMA,
  type LadderStrikeIv,
  type LadderVolatility,
} from '../components/Gexbot/level-ladder/types';
import { normalCDF } from '../utils/black-scholes';

/** A percentage at one decimal, the precision the spec states it to. */
const pct1 = (p: number) => (p * 100).toFixed(1);

/** The ATM σ alone: no strike IVs, so every strike takes the fallback. */
const atm = (expectedMove: number, daysLeft = 0.25): LadderVolatility => ({
  expectedMove,
  daysLeft,
  strikeIvs: null,
});

/** One ATM standard deviation in points for an IV, the move's own formula. */
const moveFor = (spot: number, iv: number, daysLeft: number) =>
  spot * iv * Math.sqrt(daysLeft / 365);

/** Every strike from `from` to `to` at one IV on both sides. */
function flatSmile(from: number, to: number, iv: number): LadderStrikeIv[] {
  const rows: LadderStrikeIv[] = [];
  for (let strike = from; strike <= to; strike += 5) {
    rows.push({ strike, callIv: iv, putIv: iv });
  }
  return rows;
}

// The spec's real smile: the 2026-11-25 16:00:09Z capture (10:00 CT), spot
// 7,004.43 with 5 h left.
const SMILE_SPOT = 7004.43;
const SMILE_DAYS = 0.2083;
const SMILE_IVS: LadderStrikeIv[] = [
  { strike: 6900, callIv: 0.5, putIv: 0.522 },
  { strike: 6910, callIv: 0.49, putIv: 0.514 },
  { strike: 7095, callIv: 0.465, putIv: 0.47 },
  { strike: 7105, callIv: 0.469, putIv: 0.472 },
];
const smile = (
  strikeIvs: readonly LadderStrikeIv[] | null,
): LadderVolatility => ({
  expectedMove: moveFor(SMILE_SPOT, 0.48, SMILE_DAYS),
  daysLeft: SMILE_DAYS,
  strikeIvs,
});

describe('finishBeyondProbability and touchProbability: known points on the ATM fallback', () => {
  it.each([
    // [σ away, finish beyond %, touch %]
    [1.0, '15.9', '31.7'],
    [1.28, '10.0', '20.1'],
    [0.5, '30.9', '61.7'],
    [2.0, '2.3', '4.6'],
  ] as const)(
    '%fσ gives finish %s%% and touch %s%%',
    (sigma, finish, touch) => {
      const p = finishBeyondProbability(sigma);
      expect(pct1(p)).toBe(finish);
      expect(pct1(touchProbability(p))).toBe(touch);
    },
  );

  it.each([
    // The spec's "At the boundary" column, printed.
    [LADDER_CLEAR_SIGMA, '23%', '12%'],
    [LADDER_TESTED_SIGMA, '32%', '16%'],
  ] as const)('%fσ prints touch %s and finish %s', (sigma, touch, finish) => {
    const p = finishBeyondProbability(sigma);
    expect(formatPercent(touchProbability(p))).toBe(touch);
    expect(formatPercent(p)).toBe(finish);
  });
});

describe('strikeOdds on the ATM fallback', () => {
  it('gives the same odds on the call and the put side at the same distance', () => {
    const call = strikeOdds('call', 7620, 7588.4, atm(23));
    const put = strikeOdds('put', 7556.8, 7588.4, atm(23));
    expect(call).not.toBeNull();
    expect(put).not.toBeNull();
    expect(put!.sigmaAway).toBeCloseTo(call!.sigmaAway, 12);
    expect(put!.finishBeyond).toBeCloseTo(call!.finishBeyond!, 12);
    expect(put!.touch).toBeCloseTo(call!.touch!, 12);
    expect(put!.status).toBe(call!.status);
    expect(call!.oddsSource).toBe('atm');
  });

  it('measures toward the money: (K − S) / E for a call, (S − K) / E for a put', () => {
    expect(strikeOdds('call', 7620, 7588.4, atm(23))!.sigmaAway).toBeCloseTo(
      31.6 / 23,
      12,
    );
    expect(strikeOdds('put', 7555, 7588.4, atm(23))!.sigmaAway).toBeCloseTo(
      33.4 / 23,
      12,
    );
    // A call below spot and a put above it are past the strike.
    expect(strikeOdds('call', 7580, 7588.4, atm(23))!.sigmaAway).toBeLessThan(
      0,
    );
    expect(strikeOdds('put', 7600, 7588.4, atm(23))!.sigmaAway).toBeLessThan(0);
  });

  it('carries the sample ladder: call 7,620 and put 7,555 at spot 7,588.4, E 23', () => {
    const call = strikeOdds('call', 7620, 7588.4, atm(23))!;
    expect(call.status).toBe('clear');
    expect(formatOddsLine(call)).toBe('1.37σ · touch 17% · finish beyond 8%');
    const put = strikeOdds('put', 7555, 7588.4, atm(23))!;
    expect(put.status).toBe('clear');
    expect(formatOddsLine(put)).toBe('1.45σ · touch 15% · finish beyond 7%');
  });

  it('carries the phase 4 sample: spot 7,612.6 with ±8.1 left', () => {
    const call = strikeOdds('call', 7620, 7612.6, atm(8.1))!;
    expect(call.status).toBe('tested');
    expect(formatOddsLine(call)).toBe('0.91σ · touch 36% · finish beyond 18%');
    const put = strikeOdds('put', 7555, 7612.6, atm(8.1))!;
    expect(put.status).toBe('clear');
    expect(formatOddsLine(put)).toBe(
      '7.1σ · touch under 1% · finish beyond under 1%',
    );
  });

  it('no volatility at all gives no odds and no status', () => {
    expect(strikeOdds('call', 7620, 7588.4, null)).toBeNull();
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ] as const)('a %s expected move gives no odds and no status', (_, e) => {
    expect(strikeOdds('call', 7620, 7588.4, atm(e))).toBeNull();
    expect(strikeOdds('put', 7555, 7588.4, atm(e))).toBeNull();
    // Strike IVs don't stand in for a missing move.
    expect(
      strikeOdds('call', 7620, 7588.4, {
        ...atm(e),
        strikeIvs: flatSmile(7600, 7640, 0.12),
      }),
    ).toBeNull();
  });

  it('a strike not yet reached has no points past', () => {
    expect(strikeOdds('call', 7620, 7588.4, atm(23))!.pointsPast).toBeNull();
  });
});

describe('strikeOdds from the spread price', () => {
  it.each([
    // [side, strike, σ on the ATM formula]
    ['call', 7080, 1.0],
    ['call', 7100, 1.28],
    ['put', 6930, 1.0],
    ['put', 6905, 1.28],
  ] as const)(
    "a flat smile gives the fallback's finish within 0.1 point (%s %d at %fσ)",
    (side, strike, sigma) => {
      const distance =
        side === 'call' ? strike - SMILE_SPOT : SMILE_SPOT - strike;
      const expectedMove = distance / sigma;
      const iv = expectedMove / moveFor(SMILE_SPOT, 1, SMILE_DAYS);
      const odds = strikeOdds(side, strike, SMILE_SPOT, {
        expectedMove,
        daysLeft: SMILE_DAYS,
        strikeIvs: flatSmile(6850, 7150, iv),
      })!;
      expect(odds.oddsSource).toBe('spread');
      expect(
        Math.abs(odds.finishBeyond! - finishBeyondProbability(sigma)),
      ).toBeLessThan(0.001);
    },
  );

  it("a real smile: short put 6,905 prices about 9.8%, below its own IV's 12.6%", () => {
    const odds = strikeOdds('put', 6905, SMILE_SPOT, smile(SMILE_IVS))!;
    expect(odds.oddsSource).toBe('spread');
    expect(Math.abs(odds.finishBeyond! * 100 - 9.8)).toBeLessThan(0.3);
    // The strike's own put IV (0.518) in the ATM formula reads much riskier.
    const ownIv = finishBeyondProbability(
      (SMILE_SPOT - 6905) / moveFor(SMILE_SPOT, 0.518, SMILE_DAYS),
    );
    expect(Math.abs(ownIv * 100 - 12.6)).toBeLessThan(0.3);
  });

  it('a real smile: short call 7,100 prices about 9.8%', () => {
    const odds = strikeOdds('call', 7100, SMILE_SPOT, smile(SMILE_IVS))!;
    expect(odds.oddsSource).toBe('spread');
    expect(Math.abs(odds.finishBeyond! * 100 - 9.8)).toBeLessThan(0.3);
  });

  it("uses the IVs of the short leg's side only", () => {
    // Swap the put IVs onto the call side: the short put's price must not move.
    const swapped = SMILE_IVS.map((r) => ({ ...r, callIv: r.putIv }));
    const base = strikeOdds('put', 6905, SMILE_SPOT, smile(SMILE_IVS))!;
    const other = strikeOdds('put', 6905, SMILE_SPOT, smile(swapped))!;
    expect(other.finishBeyond).toBe(base.finishBeyond);
    // And the call's price moves when its own side's IVs do.
    const calls = strikeOdds('call', 7100, SMILE_SPOT, smile(swapped))!;
    expect(calls.finishBeyond).not.toBe(
      strikeOdds('call', 7100, SMILE_SPOT, smile(SMILE_IVS))!.finishBeyond,
    );
  });

  it('a symmetric flat smile gives the same odds on both sides at the same distance', () => {
    const vol: LadderVolatility = {
      expectedMove: moveFor(7002.5, 0.45, SMILE_DAYS),
      daysLeft: SMILE_DAYS,
      strikeIvs: flatSmile(6850, 7150, 0.45),
    };
    const call = strikeOdds('call', 7080, 7002.5, vol)!;
    const put = strikeOdds('put', 6925, 7002.5, vol)!;
    expect(call.oddsSource).toBe('spread');
    expect(put.finishBeyond).toBeCloseTo(call.finishBeyond!, 12);
    expect(put.sigmaAway).toBeCloseTo(call.sigmaAway, 9);
  });

  it('prints σ from the priced chance, so σ and odds always agree', () => {
    for (const odds of [
      strikeOdds('put', 6905, SMILE_SPOT, smile(SMILE_IVS))!,
      strikeOdds('call', 7100, SMILE_SPOT, smile(SMILE_IVS))!,
    ]) {
      expect(
        Math.abs(normalCDF(-odds.sigmaAway) - odds.finishBeyond!),
      ).toBeLessThan(1e-8);
    }
    const fallback = strikeOdds('call', 7620, 7588.4, atm(23))!;
    expect(normalCDF(-fallback.sigmaAway)).toBe(fallback.finishBeyond);
  });
});

describe('strikeOdds falls back to the ATM σ', () => {
  const putAtm = (strikeIvs: readonly LadderStrikeIv[] | null) =>
    strikeOdds('put', 6905, SMILE_SPOT, smile(strikeIvs))!;
  const expected = finishBeyondProbability(
    (SMILE_SPOT - 6905) / smile(null).expectedMove,
  );

  it.each([
    ['strikeIvs null', null],
    ['strikeIvs empty', []],
    [
      'a neighbour with no IV on the needed side (the other side present)',
      SMILE_IVS.map((r) =>
        r.strike === 6900 ? { ...r, putIv: null, callIv: 0.5 } : r,
      ),
    ],
    [
      // An IV of 0 on the far leg would price it at nothing and the spread
      // at a plausible 59%: only the IV check catches it.
      'a neighbour with an IV of 0',
      SMILE_IVS.map((r) => (r.strike === 6900 ? { ...r, putIv: 0 } : r)),
    ],
    [
      'a neighbour with a NaN IV',
      SMILE_IVS.map((r) =>
        r.strike === 6910 ? { ...r, putIv: Number.NaN } : r,
      ),
    ],
    ['a neighbour strike not in the list', SMILE_IVS.slice(1)],
    [
      'a spread result outside (0, 1) from crafted IVs',
      [
        { strike: 6900, callIv: null, putIv: 3.0 },
        { strike: 6910, callIv: null, putIv: 0.05 },
      ],
    ],
  ])('%s', (_, strikeIvs) => {
    const odds = putAtm(strikeIvs);
    expect(odds.oddsSource).toBe('atm');
    expect(odds.finishBeyond).toBe(expected);
  });
});

describe('inverseNormalCDF (Φ⁻¹)', () => {
  it('0.5 gives 0 and 0.1 gives −1.2816', () => {
    expect(inverseNormalCDF(0.5)).toBeCloseTo(0, 8);
    expect(inverseNormalCDF(0.1).toFixed(4)).toBe('-1.2816');
  });

  it('round-trips through normalCDF within 1e-8 from 1e-6 to 1 − 1e-6', () => {
    const ps: number[] = [];
    for (let e = -6; e <= -1; e += 0.25) ps.push(10 ** e, 1 - 10 ** e);
    for (let p = 0.05; p < 0.96; p += 0.01) ps.push(p);
    let worst = 0;
    for (const p of ps) {
      worst = Math.max(worst, Math.abs(normalCDF(inverseNormalCDF(p)) - p));
    }
    expect(worst).toBeLessThan(1e-8);
  });

  it('is infinite at 0 and 1', () => {
    expect(inverseNormalCDF(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(inverseNormalCDF(1)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('strikeStatus', () => {
  it.each([
    // [σ away, distance toward the money in points, status]
    [1.2, 30, 'clear'],
    [1.6, 30, 'clear'],
    [1.1999, 30, 'watch'],
    [1.0, 30, 'watch'],
    [0.9999, 30, 'tested'],
    [0.0001, 0.1, 'tested'],
    // Not reached, but priced at 50% or more: tested, never breached.
    [-0.33, 0.57, 'tested'],
    // Breached is spot's position, whatever σ says.
    [0, 0, 'breached'],
    [5, 0, 'breached'],
    [-0.3, -2.4, 'breached'],
  ] as const)('%fσ at %f pts is %s', (sigma, distance, status) => {
    expect(strikeStatus(sigma, distance)).toBe(status);
  });

  it('uses the two threshold constants', () => {
    expect(LADDER_CLEAR_SIGMA).toBe(1.2);
    expect(LADDER_TESTED_SIGMA).toBe(1.0);
  });

  it('spot at the strike and past it are breached, with how far past', () => {
    const at = strikeOdds('put', 7590, 7590, atm(23))!;
    expect(at.sigmaAway).toBe(0);
    expect(at.status).toBe('breached');
    expect(at.pointsPast).toBe(0);
    const past = strikeOdds('call', 7620, 7622.4, atm(23))!;
    expect(past.status).toBe('breached');
    expect(past.touch).toBeNull();
    expect(past.finishBeyond).toBeNull();
    expect(past.pointsPast).toBeCloseTo(2.4, 9);
    const put = strikeOdds('put', 7555, 7550, atm(23))!;
    expect(put.status).toBe('breached');
    expect(put.pointsPast).toBeCloseTo(5, 9);
  });

  it('a strike spot has not reached, priced over 50%, is tested and prints 0.00σ', () => {
    // Call IVs falling with the strike, 0.57 pts above spot.
    const odds = strikeOdds('call', 7005, SMILE_SPOT, {
      ...smile(null),
      strikeIvs: [
        { strike: 7000, callIv: 0.47, putIv: 0.47 },
        { strike: 7010, callIv: 0.45, putIv: 0.45 },
      ],
    })!;
    expect(odds.oddsSource).toBe('spread');
    expect(odds.finishBeyond).toBeGreaterThan(0.5);
    expect(odds.sigmaAway).toBeLessThan(0);
    expect(odds.status).toBe('tested');
    expect(formatOddsLine(odds)).toBe(
      '0.00σ · touch over 99% · finish beyond 63%',
    );
  });
});

describe('touchProbability', () => {
  it.each([0, 0.001, 0.2, 0.4999, 0.5, 0.63, 0.99, 1])(
    'never exceeds 1 (finish beyond %f)',
    (finish) => {
      expect(touchProbability(finish)).toBeLessThanOrEqual(1);
    },
  );

  it('is twice the finish beyond, capped at exactly 1 from 50% up', () => {
    expect(touchProbability(0.2)).toBeCloseTo(0.4, 12);
    expect(touchProbability(0.5)).toBe(1);
    expect(touchProbability(0.63)).toBe(1);
  });
});

describe('carryForwardMove', () => {
  const ASOF = '2026-11-25T20:53:00.000Z';
  const asOfMs = Date.parse(ASOF);
  const MIN = 60_000;
  /** A row sized with `minutesLeft` of the session to go. */
  const row = (minutesLeft: number, expectedMove: number | null = 10) => ({
    expectedMove,
    dteFraction: minutesLeft / 1440,
    asOf: ASOF,
  });

  it('a row stamped with 7 min left, read 2 min later, gives E × √(5 ÷ 7) and 5 min left', () => {
    const carried = carryForwardMove(row(7), asOfMs + 2 * MIN)!;
    expect(carried.expectedMove).toBeCloseTo(10 * Math.sqrt(5 / 7), 12);
    expect(carried.daysLeft).toBeCloseTo(5 / 1440, 12);
  });

  it('read at its own stamp, the row is unchanged', () => {
    expect(carryForwardMove(row(30, 23), asOfMs)).toEqual({
      expectedMove: 23,
      daysLeft: 30 / 1440,
    });
  });

  it('a row stamped after now never widens E (elapsed time clamps at 0)', () => {
    expect(carryForwardMove(row(30, 23), asOfMs - 5 * MIN)).toEqual({
      expectedMove: 23,
      daysLeft: 30 / 1440,
    });
  });

  it.each([
    ['exactly at expiry', 7],
    ['past expiry', 9],
  ] as const)('T_now ≤ 0 gives no odds (%s)', (_, minutesLater) => {
    expect(carryForwardMove(row(7), asOfMs + minutesLater * MIN)).toBeNull();
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
    expect(carryForwardMove(r, asOfMs)).toBeNull();
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
    // A strike priced at 50% or more before spot reaches it.
    [-0.33, '0.00σ'],
    [-0.001, '0.00σ'],
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
    const line = formatOddsLine(strikeOdds('call', 7620, 7622.4, atm(23))!);
    expect(line).toBe('spot is 2.4 pts past it');
    expect(line).not.toMatch(/touch|finish/);
  });

  it('spot exactly on a breached strike prints "spot is at it"', () => {
    expect(formatOddsLine(strikeOdds('call', 7620, 7620, atm(23))!)).toBe(
      'spot is at it',
    );
  });
});
