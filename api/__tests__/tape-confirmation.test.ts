import { describe, it, expect } from 'vitest';
import {
  etfTideSource,
  evaluateTapeAgreement,
  tickerFlowSource,
  type FlowRow,
  type TapeInputs,
} from '../_lib/tape-confirmation.js';

const bullishFlow: FlowRow = {
  ncp: 100_000_000,
  npp: -50_000_000,
  netVolume: 500_000,
  otmNcp: 60_000_000,
  otmNpp: -20_000_000,
};

const bearishFlow: FlowRow = {
  ncp: -100_000_000,
  npp: 50_000_000,
  netVolume: -500_000,
  otmNcp: -60_000_000,
  otmNpp: 20_000_000,
};

const flatFlow: FlowRow = {
  ncp: null,
  npp: null,
  netVolume: 0,
  otmNcp: null,
  otmNpp: null,
};

function inputs(overrides: Partial<TapeInputs> = {}): TapeInputs {
  return {
    marketTide: null,
    marketTideOtm: null,
    tickerFlow: null,
    etfTide: null,
    ...overrides,
  };
}

describe('evaluateTapeAgreement', () => {
  it('returns 0/0 when no signals have data', () => {
    const result = evaluateTapeAgreement('call', inputs());
    expect(result.signals).toHaveLength(4);
    expect(result.agreeCount).toBe(0);
    expect(result.total).toBe(0);
    expect(result.signals.every((s) => s.agrees == null)).toBe(true);
  });

  it('marks all signals "agrees=true" when call alert has fully bullish tape', () => {
    const result = evaluateTapeAgreement(
      'call',
      inputs({
        marketTide: bullishFlow,
        marketTideOtm: bullishFlow,
        tickerFlow: bullishFlow,
        etfTide: bullishFlow,
      }),
    );
    expect(result.agreeCount).toBe(4);
    expect(result.total).toBe(4);
    expect(result.signals.every((s) => s.agrees === true)).toBe(true);
  });

  it('marks all signals "agrees=false" when call alert has fully bearish tape', () => {
    const result = evaluateTapeAgreement(
      'call',
      inputs({
        marketTide: bearishFlow,
        marketTideOtm: bearishFlow,
        tickerFlow: bearishFlow,
        etfTide: bearishFlow,
      }),
    );
    expect(result.agreeCount).toBe(0);
    expect(result.total).toBe(4);
    expect(result.signals.every((s) => s.agrees === false)).toBe(true);
  });

  it('inverts the rule for put alerts (bearish tape = agree)', () => {
    const result = evaluateTapeAgreement(
      'put',
      inputs({
        marketTide: bearishFlow,
        marketTideOtm: bearishFlow,
        tickerFlow: bearishFlow,
        etfTide: bearishFlow,
      }),
    );
    expect(result.agreeCount).toBe(4);
    expect(result.total).toBe(4);
    expect(result.signals.every((s) => s.agrees === true)).toBe(true);
  });

  it('counts only signals with non-null verdicts in `total`', () => {
    const result = evaluateTapeAgreement(
      'call',
      inputs({
        marketTide: bullishFlow,
        marketTideOtm: bullishFlow,
        tickerFlow: null, // no data
        etfTide: null, // no data
      }),
    );
    expect(result.agreeCount).toBe(2);
    expect(result.total).toBe(2);
    expect(result.signals[0]!.agrees).toBe(true);
    expect(result.signals[1]!.agrees).toBe(true);
    expect(result.signals[2]!.agrees).toBeNull();
    expect(result.signals[3]!.agrees).toBeNull();
  });

  it('treats flat flow (null ncp/npp) as no-data', () => {
    const result = evaluateTapeAgreement(
      'call',
      inputs({
        marketTide: flatFlow,
        marketTideOtm: flatFlow,
      }),
    );
    expect(result.total).toBe(0);
  });

  it('handles a mixed tape — partial agreement', () => {
    const result = evaluateTapeAgreement(
      'call',
      inputs({
        marketTide: bullishFlow,
        marketTideOtm: bearishFlow, // disagrees
        tickerFlow: bullishFlow,
        etfTide: null,
      }),
    );
    expect(result.agreeCount).toBe(2);
    expect(result.total).toBe(3);
  });

  it('preserves signal order in the output (market_tide, otm, ticker_flow, etf_tide)', () => {
    const result = evaluateTapeAgreement('call', inputs());
    const keys = result.signals.map((s) => s.key);
    expect(keys).toEqual([
      'market_tide',
      'market_tide_otm',
      'ticker_flow',
      'etf_tide',
    ]);
  });

  it('attaches ncp/npp values to each signal for tooltip rendering', () => {
    const result = evaluateTapeAgreement(
      'call',
      inputs({ marketTide: bullishFlow }),
    );
    expect(result.signals[0]!.ncp).toBe(100_000_000);
    expect(result.signals[0]!.npp).toBe(-50_000_000);
  });
});

describe('tickerFlowSource', () => {
  it('maps SPX-complex tickers to spx_flow', () => {
    expect(tickerFlowSource('SPXW')).toBe('spx_flow');
    expect(tickerFlowSource('SPX')).toBe('spx_flow');
  });
  it('maps SPY/QQQ to their dedicated sources', () => {
    expect(tickerFlowSource('SPY')).toBe('spy_flow');
    expect(tickerFlowSource('QQQ')).toBe('qqq_flow');
  });
  it('returns null for tickers without a flow source', () => {
    expect(tickerFlowSource('NVDA')).toBeNull();
    expect(tickerFlowSource('IWM')).toBeNull();
    expect(tickerFlowSource('UNKNOWN')).toBeNull();
  });
});

describe('etfTideSource', () => {
  it('maps SPY/QQQ to their ETF tide sources', () => {
    expect(etfTideSource('SPY')).toBe('spy_etf_tide');
    expect(etfTideSource('QQQ')).toBe('qqq_etf_tide');
  });
  it('returns null for everything else', () => {
    expect(etfTideSource('SPXW')).toBeNull();
    expect(etfTideSource('IWM')).toBeNull();
    expect(etfTideSource('NVDA')).toBeNull();
  });
});
