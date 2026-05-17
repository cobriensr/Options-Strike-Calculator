import { describe, expect, it } from 'vitest';
import {
  buildFlowQuad,
  classifyMode,
  detectChainFires,
  enrichFires,
  getDominantSide,
  getTimeOfDay,
  getTimeOfDayFromCtHourMin,
  isCheapCallPm,
  isReload,
  LOTTERY_SPEC_V4,
  type OptionTradeTick,
} from '../_lib/lottery-finder.js';

// ============================================================
// Helpers — build a minimal tick stream that satisfies all V4 gates.
// Tests then mutate one field at a time to verify each gate works
// in isolation.
// ============================================================

const baseDate = new Date('2026-05-01T13:30:00Z'); // 08:30 CT

function makeTick(
  offsetSec: number,
  overrides: Partial<OptionTradeTick> = {},
): OptionTradeTick {
  return {
    executedAt: new Date(baseDate.getTime() + offsetSec * 1000),
    optionChain: 'SNDK260501C01175000',
    optionType: 'C',
    strike: 1175,
    expiry: new Date('2026-05-01T00:00:00Z'),
    price: 0.5,
    size: 10,
    underlyingPrice: 1170,
    side: 'ask',
    impliedVolatility: 0.5,
    delta: 0.2,
    gamma: 0.03,
    openInterest: 1000,
    ...overrides,
  };
}

/**
 * Build a stream that should fire — 6 ask-side ticks within a 5-min
 * window summing to 150 contracts (vol/OI = 0.15) on OI=1000, all in
 * the AM_open bucket.
 */
function fireableStream(): OptionTradeTick[] {
  return [
    makeTick(0, { size: 50 }),
    makeTick(30, { size: 20 }),
    makeTick(60, { size: 20 }),
    makeTick(90, { size: 20 }),
    makeTick(120, { size: 20 }),
    makeTick(150, { size: 20 }), // entry tick (next print after trigger)
  ];
}

// ============================================================
// Time-of-day buckets
// ============================================================

describe('getTimeOfDay', () => {
  it('buckets 08:30 CT (= 13:30 UTC) as AM_open', () => {
    expect(getTimeOfDay(new Date('2026-05-01T13:30:00Z'))).toBe('AM_open');
  });
  it('buckets 09:30 CT (14:30 UTC) as MID', () => {
    expect(getTimeOfDay(new Date('2026-05-01T14:30:00Z'))).toBe('MID');
  });
  it('buckets 11:30 CT (16:30 UTC) as LUNCH', () => {
    expect(getTimeOfDay(new Date('2026-05-01T16:30:00Z'))).toBe('LUNCH');
  });
  it('buckets 12:30 CT (17:30 UTC) as PM', () => {
    expect(getTimeOfDay(new Date('2026-05-01T17:30:00Z'))).toBe('PM');
  });
  it('buckets 14:59 CT (19:59 UTC) as PM', () => {
    expect(getTimeOfDay(new Date('2026-05-01T19:59:00Z'))).toBe('PM');
  });
});

describe('getTimeOfDayFromCtHourMin', () => {
  it('matches the Date-based variant at boundaries', () => {
    expect(getTimeOfDayFromCtHourMin(8, 30)).toBe('AM_open');
    expect(getTimeOfDayFromCtHourMin(9, 30)).toBe('MID');
    expect(getTimeOfDayFromCtHourMin(11, 30)).toBe('LUNCH');
    expect(getTimeOfDayFromCtHourMin(12, 30)).toBe('PM');
  });
});

// ============================================================
// Flow-quad + dominant side
// ============================================================

describe('getDominantSide', () => {
  it('returns ask for askPct ≥ 0.60', () => {
    expect(getDominantSide(0.6)).toBe('ask');
    expect(getDominantSide(0.95)).toBe('ask');
  });
  it('returns bid for askPct ≤ 0.40', () => {
    expect(getDominantSide(0.4)).toBe('bid');
    expect(getDominantSide(0.05)).toBe('bid');
  });
  it('returns mixed for 0.40 < askPct < 0.60', () => {
    expect(getDominantSide(0.5)).toBe('mixed');
    expect(getDominantSide(0.41)).toBe('mixed');
    expect(getDominantSide(0.59)).toBe('mixed');
  });
});

describe('buildFlowQuad', () => {
  it('builds call_ask for call+0.7', () => {
    expect(buildFlowQuad('C', 0.7)).toBe('call_ask');
  });
  it('builds put_bid for put+0.2', () => {
    expect(buildFlowQuad('P', 0.2)).toBe('put_bid');
  });
  it('builds call_mixed for call+0.5', () => {
    expect(buildFlowQuad('C', 0.5)).toBe('call_mixed');
  });
});

// ============================================================
// Mode classification
// ============================================================

describe('classifyMode', () => {
  // Mode A doesn't gate on moneyness — any strike works.
  it('classifies SNDK 0DTE call_ask as Mode A', () => {
    expect(classifyMode('SNDK', 0, 0.8, 1175, 1170)).toBe('A_intraday_0DTE');
  });
  it('classifies SPY 0DTE as Mode A (special-cased into V3 list)', () => {
    expect(classifyMode('SPY', 0, 0.8, 500, 500)).toBe('A_intraday_0DTE');
  });
  it('classifies META 2-DTE near-ATM as Mode B', () => {
    // strike=510, spot=500 → |510/500 - 1| = 0.02 ≤ 0.10
    expect(classifyMode('META', 2, 0.8, 510, 500)).toBe('B_multi_day_DTE1_3');
  });
  it('rejects Mode B candidates outside the |moneyness|≤10% gate (p26 in_play)', () => {
    // META 2-DTE strike=$1000 vs spot=$500 → 100% OTM, not Mode B
    expect(classifyMode('META', 2, 0.8, 1000, 500)).toBe('OUT_OF_UNIVERSE');
  });
  it('keeps Mode B candidates within the |moneyness|≤10% gate', () => {
    // strike=549, spot=500 → moneyness 9.8% (just inside the 10% gate).
    // Note: 550/500 falls outside due to IEEE-754 fuzz (matches Python).
    expect(classifyMode('META', 2, 0.8, 549, 500)).toBe('B_multi_day_DTE1_3');
  });
  it('rejects SPY DTE 1-3 from Mode B (SPY is Mode-A-only)', () => {
    expect(classifyMode('SPY', 2, 0.8, 500, 500)).toBe('OUT_OF_UNIVERSE');
  });
  it('rejects DTE > 3 from both modes', () => {
    expect(classifyMode('META', 4, 0.8, 500, 500)).toBe('OUT_OF_UNIVERSE');
  });
  it('rejects ask-side fraction below the universe threshold', () => {
    expect(classifyMode('SNDK', 0, 0.5, 1175, 1170)).toBe('OUT_OF_UNIVERSE');
  });
  it('rejects unknown tickers', () => {
    expect(classifyMode('FAKE', 0, 0.9, 100, 100)).toBe('OUT_OF_UNIVERSE');
  });
  it('uppercases ticker before checking the list', () => {
    expect(classifyMode('sndk', 0, 0.8, 1175, 1170)).toBe('A_intraday_0DTE');
  });
  it('rejects Mode B when spot is 0 (cannot compute moneyness)', () => {
    expect(classifyMode('META', 2, 0.8, 500, 0)).toBe('OUT_OF_UNIVERSE');
  });
});

// ============================================================
// RE-LOAD + cheap-call-PM tags
// ============================================================

describe('isReload', () => {
  it('returns false on the first fire (NULL prev)', () => {
    expect(isReload(null, null)).toBe(false);
  });
  it('returns true when burst ≥ 2× AND entry dropped ≥ 30%', () => {
    expect(isReload(2.5, -35)).toBe(true);
  });
  it('returns false when burst is < 2×', () => {
    expect(isReload(1.9, -50)).toBe(false);
  });
  it('returns false when entry didn’t drop ≥ 30%', () => {
    expect(isReload(3.0, -25)).toBe(false);
  });
  it('returns false when entry rose vs prev', () => {
    expect(isReload(3.0, 10)).toBe(false);
  });
});

describe('isCheapCallPm', () => {
  it('tags a call entered in PM under $1', () => {
    expect(isCheapCallPm('C', 0.5, 'PM')).toBe(true);
  });
  it('rejects puts', () => {
    expect(isCheapCallPm('P', 0.5, 'PM')).toBe(false);
  });
  it('rejects entries ≥ $1', () => {
    expect(isCheapCallPm('C', 1.0, 'PM')).toBe(false);
  });
  it('rejects non-PM time-of-day', () => {
    expect(isCheapCallPm('C', 0.5, 'AM_open')).toBe(false);
    expect(isCheapCallPm('C', 0.5, 'MID')).toBe(false);
    expect(isCheapCallPm('C', 0.5, 'LUNCH')).toBe(false);
  });
});

// ============================================================
// Detector core — single-fire happy path
// ============================================================

describe('detectChainFires', () => {
  it('emits one fire when all V4 gates are satisfied', () => {
    const fires = detectChainFires(fireableStream(), 1000, 0);
    expect(fires).toHaveLength(1);
    const f = fires[0]!;
    expect(f.alertSeq).toBe(1);
    expect(f.minutesSincePrevFire).toBe(0);
    expect(f.openInterest).toBe(1000);
    expect(f.spotAtFirst).toBe(1170);
    expect(f.entryPrice).toBe(0.5);
    expect(f.triggerWindowPrints).toBeGreaterThanOrEqual(
      LOTTERY_SPEC_V4.cntWindowMin,
    );
    expect(f.triggerVolToOiWindow).toBeGreaterThanOrEqual(
      LOTTERY_SPEC_V4.volToOiWindowMin,
    );
    expect(f.triggerIv).toBeCloseTo(0.5, 6);
    expect(Math.abs(f.triggerDelta)).toBeGreaterThanOrEqual(
      LOTTERY_SPEC_V4.absDeltaMin,
    );
    expect(f.triggerAskPct).toBeGreaterThanOrEqual(LOTTERY_SPEC_V4.askPctMin);
  });

  it('returns no fires when DTE > 7', () => {
    expect(detectChainFires(fireableStream(), 1000, 8)).toHaveLength(0);
  });

  it('returns no fires when OI is 0', () => {
    expect(detectChainFires(fireableStream(), 0, 0)).toHaveLength(0);
  });

  it('returns no fires when fewer than cntWindowMin ticks exist', () => {
    expect(
      detectChainFires(fireableStream().slice(0, 4), 1000, 0),
    ).toHaveLength(0);
  });

  it('returns no fires when window vol/OI is below threshold', () => {
    // 5 ticks of size=1 → vol/OI = 0.005 ≪ 0.05
    const ticks = Array.from({ length: 6 }, (_, i) =>
      makeTick(i * 30, { size: 1 }),
    );
    expect(detectChainFires(ticks, 1000, 0)).toHaveLength(0);
  });

  it('returns no fires when ask% is below threshold', () => {
    // Override sides so ask is only 2/6 = 0.33 (< 0.52 askPctMin).
    const sides: ('ask' | 'bid')[] = ['ask', 'ask', 'bid', 'bid', 'bid', 'bid'];
    const ticks = fireableStream().map((t, i) => ({ ...t, side: sides[i]! }));
    expect(detectChainFires(ticks, 1000, 0)).toHaveLength(0);
  });

  it('returns no fires when IV is below threshold', () => {
    const ticks = fireableStream().map((t) => ({
      ...t,
      impliedVolatility: 0.2,
    }));
    expect(detectChainFires(ticks, 1000, 0)).toHaveLength(0);
  });

  it('returns no fires when |delta| is below threshold', () => {
    const ticks = fireableStream().map((t) => ({ ...t, delta: 0.05 }));
    expect(detectChainFires(ticks, 1000, 0)).toHaveLength(0);
  });

  it('returns no fires when first tick has null underlying price (matches Python iloc[0])', () => {
    const stream = fireableStream();
    const first = stream[0]!;
    const ticks = [{ ...first, underlyingPrice: null }, ...stream.slice(1)];
    expect(detectChainFires(ticks, 1000, 0)).toHaveLength(0);
  });

  it('skips ticks with null IV from windowed-mean denominator without rejecting the fire', () => {
    // 6 ticks; ticks 0,2,4 have IV=0.5, ticks 1,3,5 have IV=null.
    // Windowed mean over non-null subset = 0.5 (above 0.35 ivMin) → fires.
    const stream = fireableStream();
    const ticks = stream.map((t, i) =>
      i % 2 === 1 ? { ...t, impliedVolatility: null } : t,
    );
    expect(detectChainFires(ticks, 1000, 0)).toHaveLength(1);
  });

  it('cumulative vol/OI gate suppresses fires until the chain context is hot enough', () => {
    // OI=10000 → fireableStream's 150 contracts gives cum vol/OI = 0.015,
    // well below the 0.10 cum threshold. Window vol/OI also computed
    // against same OI = 0.015 < 0.05. Should not fire.
    expect(detectChainFires(fireableStream(), 10000, 0)).toHaveLength(0);
  });
});

// ============================================================
// Detector — cooldown and multi-fire (the SNDK 5/1 fire #4 case)
// ============================================================

describe('detectChainFires — cooldown', () => {
  it('emits two fires when separated by ≥ 5 min on the same chain', () => {
    // First burst at t=0..150, second burst starting at t=400 (>5min later)
    const ticks: OptionTradeTick[] = [
      ...fireableStream(),
      makeTick(400, { size: 50, price: 0.3 }),
      makeTick(420, { size: 30, price: 0.3 }),
      makeTick(440, { size: 30, price: 0.3 }),
      makeTick(460, { size: 30, price: 0.3 }),
      makeTick(480, { size: 30, price: 0.3 }),
      makeTick(500, { size: 30, price: 0.3 }),
    ];
    const fires = detectChainFires(ticks, 1000, 0);
    expect(fires.length).toBeGreaterThanOrEqual(2);
    expect(fires[0]!.alertSeq).toBe(1);
    expect(fires[1]!.alertSeq).toBe(2);
    expect(fires[1]!.minutesSincePrevFire).toBeGreaterThan(5);
  });

  it('evicts ticks at exactly the 5-min boundary (closed=right semantics)', () => {
    // 6 ticks at exact 60-second spacing — at i=5 (offset=300s = 5min),
    // the tick at offset=0 is exactly windowMs old and must be evicted
    // (matches pandas rolling('5min'), closed='right').
    // Sizes 1000 each so vol/OI = 0.005 with OI=1M (window vol/OI gate
    // intentionally falls below 0.05 — we only care that the eviction
    // happened, not that the fire fires).
    const ticks: OptionTradeTick[] = [
      makeTick(0, { size: 1000 }),
      makeTick(60, { size: 1000 }),
      makeTick(120, { size: 1000 }),
      makeTick(180, { size: 1000 }),
      makeTick(240, { size: 1000 }),
      makeTick(300, { size: 1000 }),
    ];
    const fires = detectChainFires(ticks, 1_000_000, 0);
    // Below window-vol/OI gate, so no fires either way — but the test
    // exists to document the boundary semantics and lock in `>=` over `>`.
    expect(fires).toHaveLength(0);
  });

  it('suppresses a second fire within the 5-min cooldown', () => {
    // Both bursts within 4 minutes — only the first should fire.
    const ticks: OptionTradeTick[] = [
      ...fireableStream(),
      makeTick(180, { size: 50, price: 0.5 }),
      makeTick(190, { size: 50, price: 0.5 }),
      makeTick(200, { size: 50, price: 0.5 }),
      makeTick(210, { size: 50, price: 0.5 }),
      makeTick(220, { size: 50, price: 0.5 }),
    ];
    const fires = detectChainFires(ticks, 1000, 0);
    expect(fires).toHaveLength(1);
  });
});

// ============================================================
// enrichFires — derived discriminators
// ============================================================

describe('enrichFires', () => {
  it('tags first fire with NULL prev-fire fields and reload=false', () => {
    const fires = detectChainFires(fireableStream(), 1000, 0);
    expect(fires).toHaveLength(1);
    const records = enrichFires(fires, {
      date: '2026-05-01',
      optionChainId: 'SNDK260501C01175000',
      underlyingSymbol: 'SNDK',
      optionType: 'C',
      strike: 1175,
      expiry: '2026-05-01',
      dte: 0,
    });
    const r = records[0]!;
    expect(r.burstRatioVsPrev).toBeNull();
    expect(r.entryDropPctVsPrev).toBeNull();
    expect(r.reloadTagged).toBe(false);
    expect(r.tod).toBe('AM_open');
    expect(r.flowQuad).toBe('call_ask');
    expect(r.mode).toBe('A_intraday_0DTE');
    // entry price 0.5 in AM_open → cheap-call-PM is false (wrong tod)
    expect(r.cheapCallPmTagged).toBe(false);
  });

  it('tags fire #2 as RE-LOAD when burst ≥2× and entry dropped ≥30%', () => {
    // SNDK 1175C 5/1 fire #4 archetype: second burst is bigger and
    // option is cheaper.
    const fires = [
      {
        triggerTimeCt: new Date('2026-05-01T13:30:00Z'),
        entryTimeCt: new Date('2026-05-01T13:31:00Z'),
        entryPrice: 0.5,
        triggerVolToOiWindow: 0.06,
        triggerVolToOiCum: 0.12,
        triggerIv: 0.4,
        triggerDelta: 0.2,
        triggerGamma: 0.03,
        triggerAskPct: 0.7,
        triggerWindowPrints: 5,
        triggerWindowSize: 100,
        openInterest: 1000,
        spotAtFirst: 1170,
        alertSeq: 1,
        minutesSincePrevFire: 0,
      },
      {
        triggerTimeCt: new Date('2026-05-01T19:00:00Z'), // PM bucket
        entryTimeCt: new Date('2026-05-01T19:01:00Z'),
        entryPrice: 0.3, // -40% from 0.5
        triggerVolToOiWindow: 0.06,
        triggerVolToOiCum: 0.12,
        triggerIv: 0.4,
        triggerDelta: 0.2,
        triggerGamma: 0.03,
        triggerAskPct: 0.7,
        triggerWindowPrints: 5,
        triggerWindowSize: 250, // 2.5× the prior burst
        openInterest: 1000,
        spotAtFirst: 1170,
        alertSeq: 2,
        minutesSincePrevFire: 330,
      },
    ];
    const records = enrichFires(fires, {
      date: '2026-05-01',
      optionChainId: 'SNDK260501C01175000',
      underlyingSymbol: 'SNDK',
      optionType: 'C',
      strike: 1175,
      expiry: '2026-05-01',
      dte: 0,
    });
    expect(records[0]!.reloadTagged).toBe(false);
    expect(records[1]!.reloadTagged).toBe(true);
    expect(records[1]!.burstRatioVsPrev).toBeCloseTo(2.5, 6);
    expect(records[1]!.entryDropPctVsPrev).toBeCloseTo(-40, 6);
    // PM + call + entry < 1 → cheap-call-PM
    expect(records[1]!.tod).toBe('PM');
    expect(records[1]!.cheapCallPmTagged).toBe(true);
  });
});
