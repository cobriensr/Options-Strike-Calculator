import { describe, it, expect } from 'vitest';
import {
  gexNear,
  gradeGate,
  flipStrike,
  countCandles,
  ivBreak,
  evaluateRegime0dte,
  REGIME_0DTE,
} from '../_lib/regime-0dte';

const strikes = [
  { strike: 7400, netGex: -0.2 },
  { strike: 7450, netGex: -0.1 },
  { strike: 7500, netGex: 0.05 },
  { strike: 7600, netGex: 0.3 },
  { strike: 7700, netGex: 0.4 }, // far OTM, outside +/-1% band, satisfies MIN_STRIKES
];

describe('gexNear', () => {
  it('sums net GEX within +/-1% of spot', () => {
    // spot 7450, band +/-74.5 -> strikes 7400,7450,7500 in band
    expect(gexNear(strikes, 7450)).toBeCloseTo(-0.25, 5);
  });

  it('returns null when the chain is too sparse (< MIN_STRIKES)', () => {
    expect(gexNear(strikes.slice(0, 3), 7450)).toBeNull();
  });
});

describe('gradeGate', () => {
  it('positive -> calm', () => expect(gradeGate(0.1)).toBe('calm'));
  it('mild negative -> big_move', () =>
    expect(gradeGate(-0.05)).toBe('big_move'));
  it('deep negative -> lean_down', () =>
    expect(gradeGate(REGIME_0DTE.GATE_DEEP_NEG - 0.01)).toBe('lean_down'));
  it('null -> unknown', () => expect(gradeGate(null)).toBe('unknown'));
});

describe('flipStrike', () => {
  it('nearest sign-change to spot', () => {
    expect(
      flipStrike(
        [
          { strike: 7450, netGex: -0.1 },
          { strike: 7500, netGex: 0.05 },
        ],
        7470,
      ),
    ).toBeCloseTo(7475, 0);
  });
});

describe('countCandles', () => {
  it('counts green/red up to a CT minute', () => {
    const c = [
      { ctMin: 510, open: 100, close: 99 },
      { ctMin: 540, open: 99, close: 98 },
      { ctMin: 570, open: 98, close: 97 },
      { ctMin: 600, open: 97, close: 96 },
      { ctMin: 630, open: 96, close: 97 }, // 1 green, 4 red by 11:00
    ];
    expect(countCandles(c, 660)).toEqual({ green: 1, red: 4 });
  });
});

describe('ivBreak', () => {
  const series = [
    { ctMin: 520, iv: 0.2 },
    { ctMin: 580, iv: 0.21 }, // ref range hi 0.21
    { ctMin: 620, iv: 0.213 }, // ~1.4% over refHi 0.21 -> below 2% rel -> no break
    { ctMin: 650, iv: 0.25 }, // break at 650
  ];
  it('fires when IV exceeds morning range by >2% within the window', () => {
    const r = ivBreak(series, 700);
    expect(r.fired).toBe(true);
    expect(r.atCtMin).toBe(650);
  });
  it('ignores breaks after 12:30 (EOD blowup)', () => {
    expect(
      ivBreak(
        [
          { ctMin: 520, iv: 0.2 },
          { ctMin: 800, iv: 0.9 },
        ],
        820,
      ).fired,
    ).toBe(false);
  });
});

describe('evaluateRegime0dte', () => {
  it('lean_down + mostly_red on a crash-shaped day', () => {
    const s = evaluateRegime0dte({
      nowCtMin: 700,
      spot: 7450,
      openSpot: 7530,
      gexStrikes: [
        { strike: 7440, netGex: -0.3 },
        { strike: 7450, netGex: -0.2 },
        { strike: 7460, netGex: -0.2 },
        { strike: 7470, netGex: -0.1 },
        { strike: 7480, netGex: -0.1 },
      ],
      putIv: [
        { ctMin: 520, iv: 0.2 },
        { ctMin: 650, iv: 0.26 },
      ],
      candles30: [
        { ctMin: 510, open: 7530, close: 7520 },
        { ctMin: 540, open: 7520, close: 7510 },
        { ctMin: 570, open: 7510, close: 7500 },
        { ctMin: 600, open: 7500, close: 7480 },
        { ctMin: 630, open: 7480, close: 7470 },
      ],
    });
    expect(s.gate).toBe('lean_down');
    expect(s.triggers.mostlyRed.fired).toBe(true);
    expect(s.triggers.ivBreak.fired).toBe(true);
  });
});
