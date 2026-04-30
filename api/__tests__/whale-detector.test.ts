// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  classifyWhale,
  detectPairing,
  WHALE_THRESHOLDS,
  WHALE_TICKERS,
  type WhaleCandidate,
  type PairingPeer,
} from '../_lib/whale-detector.js';

// ── Fixtures ────────────────────────────────────────────────

/** Today's anchor whale: SPXW 7150 P 0DTE BID $12M (Type 1 floor). */
const SPXW_7150P_2026_04_29: WhaleCandidate = {
  ticker: 'SPXW',
  option_chain: 'SPXW260429P07150000',
  strike: 7150,
  option_type: 'put',
  expiry: '2026-04-29',
  first_ts: new Date('2026-04-29T16:56:52Z'), // 11:56 CT
  last_ts: new Date('2026-04-29T19:33:07Z'), // 14:33 CT
  side_ask_premium: 600_000, // ~5%
  side_bid_premium: 11_400_000, // ~95%
  total_premium: 12_037_400,
  trade_count: 5,
  underlying_price: 7120.12,
  vol_oi_ratio: 10.2,
  dte: 0,
};

/** SPXW 7150 C 0DTE ASK $2.68M (the morning call that lost — should fail
 *  the premium threshold). */
const SPXW_7150C_2026_04_29: WhaleCandidate = {
  ticker: 'SPXW',
  option_chain: 'SPXW260429C07150000',
  strike: 7150,
  option_type: 'call',
  expiry: '2026-04-29',
  first_ts: new Date('2026-04-29T14:39:31Z'), // 09:39 CT
  last_ts: new Date('2026-04-29T16:56:52Z'), // 11:56 CT
  side_ask_premium: 1_815_000, // 68%
  side_bid_premium: 853_000, // 32%
  total_premium: 2_675_540,
  trade_count: 7,
  underlying_price: 7143.76,
  vol_oi_ratio: 20.7,
  dte: 0,
};

/** SPXW 7130 C 4d BID $29.4M (Type 2 ceiling, 04-22). */
const SPXW_7130C_2026_04_22: WhaleCandidate = {
  ticker: 'SPXW',
  option_chain: 'SPXW260426C07130000',
  strike: 7130,
  option_type: 'call',
  expiry: '2026-04-26',
  first_ts: new Date('2026-04-22T15:29:00Z'),
  last_ts: new Date('2026-04-22T15:35:00Z'),
  side_ask_premium: 1_470_000, // 5%
  side_bid_premium: 27_930_000, // 95%
  total_premium: 29_400_000,
  trade_count: 17,
  underlying_price: 7126.43,
  vol_oi_ratio: 50,
  dte: 4,
};

/** SPY 699 P 7d ASK $18.7M (Type 3 floor break, 04-22). */
const SPY_699P_2026_04_22: WhaleCandidate = {
  ticker: 'SPY',
  option_chain: 'SPY260429P00699000',
  strike: 699,
  option_type: 'put',
  expiry: '2026-04-29',
  first_ts: new Date('2026-04-22T14:04:00Z'),
  last_ts: new Date('2026-04-22T14:30:00Z'),
  side_ask_premium: 17_391_000, // 93%
  side_bid_premium: 1_309_000, // 7%
  total_premium: 18_700_000,
  trade_count: 52,
  underlying_price: 709.53,
  vol_oi_ratio: 5,
  dte: 7,
};

/** SPXW 7155 C 9d ASK $11.1M (Type 4 ceiling break, 04-17). */
const SPXW_7155C_2026_04_17: WhaleCandidate = {
  ticker: 'SPXW',
  option_chain: 'SPXW260426C07155000',
  strike: 7155,
  option_type: 'call',
  expiry: '2026-04-26',
  first_ts: new Date('2026-04-17T14:19:00Z'),
  last_ts: new Date('2026-04-17T14:25:00Z'),
  side_ask_premium: 11_100_000, // 100%
  side_bid_premium: 0,
  total_premium: 11_100_000,
  trade_count: 15,
  underlying_price: 7114.15,
  vol_oi_ratio: 6,
  dte: 9,
};

// ── classifyWhale tests ─────────────────────────────────────

describe('classifyWhale — checklist filters', () => {
  it('classifies the 04-29 SPXW 7150P as Type 1 (floor declared)', () => {
    const out = classifyWhale(SPXW_7150P_2026_04_29);
    expect(out).not.toBeNull();
    expect(out!.whale_type).toBe(1);
    expect(out!.direction).toBe('bullish');
    expect(out!.side).toBe('BID');
    expect(out!.ask_pct).toBeCloseTo(600_000 / 12_000_000, 2);
  });

  it('classifies the 04-22 SPXW 7130C as Type 2 (ceiling declared)', () => {
    const out = classifyWhale(SPXW_7130C_2026_04_22);
    expect(out).not.toBeNull();
    expect(out!.whale_type).toBe(2);
    expect(out!.direction).toBe('bearish');
    expect(out!.side).toBe('BID');
  });

  it('classifies the 04-22 SPY 699P as Type 3 (floor break expected)', () => {
    const out = classifyWhale(SPY_699P_2026_04_22);
    expect(out).not.toBeNull();
    expect(out!.whale_type).toBe(3);
    expect(out!.direction).toBe('bearish');
    expect(out!.side).toBe('ASK');
  });

  it('classifies the 04-17 SPXW 7155C as Type 4 (ceiling break expected)', () => {
    const out = classifyWhale(SPXW_7155C_2026_04_17);
    expect(out).not.toBeNull();
    expect(out!.whale_type).toBe(4);
    expect(out!.direction).toBe('bullish');
    expect(out!.side).toBe('ASK');
  });

  it('rejects the 04-29 SPXW 7150C — premium below SPXW p95', () => {
    expect(classifyWhale(SPXW_7150C_2026_04_29)).toBeNull();
  });

  it('rejects non-whale tickers (e.g. AAPL)', () => {
    const aapl = { ...SPXW_7150P_2026_04_29, ticker: 'AAPL' };
    expect(classifyWhale(aapl)).toBeNull();
  });

  it('rejects when premium is below per-ticker threshold', () => {
    const small = {
      ...SPXW_7150P_2026_04_29,
      total_premium: 1_000_000,
      side_bid_premium: 950_000,
      side_ask_premium: 50_000,
    };
    expect(classifyWhale(small)).toBeNull();
  });

  it('rejects when trade_count < 5', () => {
    const fewTrades = { ...SPXW_7150P_2026_04_29, trade_count: 4 };
    expect(classifyWhale(fewTrades)).toBeNull();
  });

  it('rejects when DTE > 14', () => {
    const longDte = { ...SPXW_7150P_2026_04_29, dte: 15 };
    expect(classifyWhale(longDte)).toBeNull();
  });

  it('rejects when moneyness > 5%', () => {
    const farOtm = {
      ...SPXW_7150P_2026_04_29,
      strike: 7600, // 6.7% above 7120 spot
    };
    expect(classifyWhale(farOtm)).toBeNull();
  });

  it('rejects when neither side is ≥85%', () => {
    const balanced = {
      ...SPXW_7150P_2026_04_29,
      side_ask_premium: 6_000_000,
      side_bid_premium: 6_000_000,
    };
    expect(classifyWhale(balanced)).toBeNull();
  });

  it('rejects ASK calls with very negative moneyness (deep ITM call ASK is permissive but 5% is the cutoff)', () => {
    const deepItm = {
      ...SPXW_7155C_2026_04_17,
      strike: 6700, // -5.8% of 7114
    };
    expect(classifyWhale(deepItm)).toBeNull();
  });

  it('handles missing underlying_price (NDX/NDXP) by assuming near-ATM', () => {
    const ndxpRow: WhaleCandidate = {
      ticker: 'NDXP',
      option_chain: 'NDXP260505C24500000',
      strike: 24500,
      option_type: 'call',
      expiry: '2026-05-05',
      first_ts: new Date('2026-04-29T13:40:00Z'),
      last_ts: new Date('2026-04-29T13:42:00Z'),
      side_ask_premium: 4_200_000,
      side_bid_premium: 0,
      total_premium: 4_200_000,
      trade_count: 14,
      underlying_price: null, // NDX/NDXP often null in dataset
      vol_oi_ratio: null,
      dte: 5,
    };
    const out = classifyWhale(ndxpRow);
    expect(out).not.toBeNull();
    expect(out!.whale_type).toBe(4);
    expect(out!.direction).toBe('bullish');
    expect(out!.moneyness).toBeNull();
  });
});

// ── Threshold table sanity ──────────────────────────────────

describe('WHALE_THRESHOLDS', () => {
  it('has a threshold for every WHALE_TICKER', () => {
    for (const t of WHALE_TICKERS) {
      expect(WHALE_THRESHOLDS[t]).toBeGreaterThan(0);
    }
  });

  it('SPX threshold is much larger than NDXP threshold (different ticker scales)', () => {
    expect(WHALE_THRESHOLDS.SPX).toBeGreaterThan(WHALE_THRESHOLDS.NDXP * 10);
  });
});

// ── detectPairing tests ─────────────────────────────────────

describe('detectPairing', () => {
  it('returns "alone" when no peer exists', () => {
    expect(
      detectPairing(
        {
          first_ts: new Date('2026-04-29T16:56:52Z'),
          last_ts: new Date('2026-04-29T19:33:07Z'),
          option_type: 'put',
        },
        [],
      ),
    ).toBe('alone');
  });

  it('returns "sequential" when call closes at the second the put opens (today\'s 7150)', () => {
    // Real data: call 09:39:31 → 11:56:52, put 11:56:52 → 14:33:07.
    // Peer is the call.
    const peers: PairingPeer[] = [
      {
        option_type: 'call',
        first_ts: new Date('2026-04-29T14:39:31Z'),
        last_ts: new Date('2026-04-29T16:56:52Z'),
      },
    ];
    expect(
      detectPairing(
        {
          first_ts: new Date('2026-04-29T16:56:52Z'),
          last_ts: new Date('2026-04-29T19:33:07Z'),
          option_type: 'put',
        },
        peers,
      ),
    ).toBe('sequential');
  });

  it('returns "simultaneous_filtered" when peer overlaps the candidate window > 60s', () => {
    // Both legs trade overlapping for 5+ minutes — pure synthetic.
    const peers: PairingPeer[] = [
      {
        option_type: 'call',
        first_ts: new Date('2026-04-29T16:56:00Z'),
        last_ts: new Date('2026-04-29T17:01:00Z'),
      },
    ];
    expect(
      detectPairing(
        {
          first_ts: new Date('2026-04-29T16:56:30Z'),
          last_ts: new Date('2026-04-29T17:00:00Z'),
          option_type: 'put',
        },
        peers,
      ),
    ).toBe('simultaneous_filtered');
  });

  it('returns "alone" when only same-side peers exist', () => {
    // Same-type peer (put + put) is not a pairing.
    const peers: PairingPeer[] = [
      {
        option_type: 'put',
        first_ts: new Date('2026-04-29T16:56:00Z'),
        last_ts: new Date('2026-04-29T17:01:00Z'),
      },
    ];
    expect(
      detectPairing(
        {
          first_ts: new Date('2026-04-29T16:56:30Z'),
          last_ts: new Date('2026-04-29T17:00:00Z'),
          option_type: 'put',
        },
        peers,
      ),
    ).toBe('alone');
  });

  it('returns "simultaneous_filtered" if ANY of multiple peers overlaps', () => {
    const peers: PairingPeer[] = [
      // First peer is sequential.
      {
        option_type: 'call',
        first_ts: new Date('2026-04-29T13:00:00Z'),
        last_ts: new Date('2026-04-29T14:00:00Z'),
      },
      // Second peer overlaps.
      {
        option_type: 'call',
        first_ts: new Date('2026-04-29T16:55:00Z'),
        last_ts: new Date('2026-04-29T17:30:00Z'),
      },
    ];
    expect(
      detectPairing(
        {
          first_ts: new Date('2026-04-29T16:56:00Z'),
          last_ts: new Date('2026-04-29T18:00:00Z'),
          option_type: 'put',
        },
        peers,
      ),
    ).toBe('simultaneous_filtered');
  });
});
