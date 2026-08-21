/**
 * useTickerNetFlowBatch × malformed /api/ticker-net-flow-current payload
 * — crash regression (client-shape-hardening-2026-08-20 follow-up).
 *
 * Unlike useTickerNetFlowBatch.test.ts (gating / URL / cadence), this file
 * renders the REAL hook feeding a REAL consumer (LotteryRow, wired the
 * same way LotteryFinder/index.tsx wires it:
 * `tickerFlowSnapshots.get(g.ticker) ?? null`) with only `fetch` stubbed.
 * The hook casts the body straight to its response interface and then
 * does `for (const s of json.snapshots)`, so a shapeless body reaches the
 * Map builder — and any per-ticker entry that survives goes on to drive
 * the Flow Match / Flow Mismatch / Flow Inverted badges.
 *
 * Contract under test: a malformed envelope leaves the badge surface in
 * its no-snapshot state with ZERO console errors; a malformed entry for
 * ONE ticker never discards the healthy tickers (StrikeBattleMap
 * precedent).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { MockInstance } from 'vitest';

import { useTickerNetFlowBatch } from '../../hooks/useTickerNetFlowBatch';
import { LotteryRow } from '../../components/LotteryFinder/LotteryRow';
import type {
  LotteryFire,
  LotteryFireMacro,
} from '../../components/LotteryFinder/types';

const DATE = '2026-05-08';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Only /api/ticker-net-flow-current matters here; the row's other three
 * hooks are `enabled: expanded` (false while collapsed) so they never
 * fire. Anything unexpected gets an empty-but-valid body rather than a
 * throw, so a stray call can't be mistaken for the crash under test.
 */
function stubFetch(payload: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/api/ticker-net-flow-current')) {
        return jsonResponse(payload);
      }
      return jsonResponse({ series: [], candles: [] });
    }),
  );
}

function makeMacro(
  overrides: Partial<LotteryFireMacro> = {},
): LotteryFireMacro {
  return {
    mktTideNcp: null,
    mktTideNpp: null,
    mktTideDiff: null,
    mktTideOtmDiff: null,
    tickerCumNcpAtFire: null,
    tickerCumNppAtFire: null,
    spxFlowDiff: null,
    spyEtfDiff: null,
    qqqEtfDiff: null,
    zeroDteDiff: null,
    spxSpotGammaOi: null,
    spxSpotGammaVol: null,
    spxSpotCharmOi: null,
    spxSpotVannaOi: null,
    gexStrikeCallMinusPut: null,
    gexStrikeCallAskMinusBid: null,
    gexStrikePutAskMinusBid: null,
    gexStrikeActualStrike: null,
    ...overrides,
  };
}

function makeFire(overrides: Partial<LotteryFire> = {}): LotteryFire {
  return {
    id: 1,
    date: DATE,
    triggerTimeCt: '2026-05-08T14:30:00Z',
    entryTimeCt: '2026-05-08T14:31:00Z',
    optionChainId: 'AAPL260508C00200000',
    underlyingSymbol: 'AAPL',
    optionType: 'C',
    strike: 200,
    expiry: DATE,
    dte: 0,
    score: 15,
    scoreTier: 'tier2',
    directionGated: false,
    forecastHighPeakPct: '40-60%',
    avgHoldMinutes: 160,
    tickerStats: null,
    fireCount: 1,
    firstFireTimeCt: '2026-05-08T14:30:00Z',
    trigger: {
      volToOiWindow: 1.5,
      volToOiCum: 2.2,
      iv: 0.35,
      delta: 0.25,
      askPct: 0.7,
      windowSize: 5,
      windowPrints: 50,
    },
    entry: {
      price: 0.85,
      openInterest: 5000,
      spotAtFirst: 198.5,
      spotAtTrigger: 198.5,
      alertSeq: 7,
      minutesSincePrevFire: 30,
    },
    tags: {
      flowQuad: 'call_ask',
      tod: 'PM',
      mode: 'A_intraday_0DTE',
      reload: false,
      cheapCallPm: true,
      burstRatioVsPrev: null,
      entryDropPctVsPrev: null,
    },
    macro: makeMacro(),
    gex: {
      oneCvroflow: null,
      netPutDex: null,
      oneDexoflow: null,
      oneGexoflow: null,
      zcvr: null,
      zeroGamma: null,
      spot: null,
      capturedAt: null,
    },
    outcomes: {
      realizedTrail30_10Pct: 22.5,
      realizedHard30mPct: null,
      realizedTier50HoldEodPct: null,
      realizedFlowInversionPct: null,
      realizedEodPct: -10,
      peakCeilingPct: 47,
      minutesToPeak: 12,
      enrichedAt: '2026-05-08T20:00:00Z',
    },
    hoursToNextMacroEvent: null,
    rangePosAtTrigger: null,
    qualityAdjustedScore: 15,
    inversionQuintile: null,
    inversionBlend: null,
    inversionN21d: null,
    inversionN90d: null,
    insertedAt: '2026-05-08T14:31:00Z',
    ...overrides,
  };
}

/**
 * Real hook → real rows, one per ticker, exactly as
 * LotteryFinder/index.tsx does it.
 */
function Harness({ tickers }: { tickers: string[] }) {
  const { data } = useTickerNetFlowBatch({
    tickers,
    date: DATE,
    marketOpen: true,
  });
  return (
    <>
      {tickers.map((t) => (
        <LotteryRow
          key={t}
          fire={makeFire({
            id: t.length,
            underlyingSymbol: t,
            optionChainId: `${t}260508C00200000`,
          })}
          exitPolicy="realizedTrail30_10Pct"
          marketOpen={true}
          liveFlowSnapshot={data.get(t) ?? null}
        />
      ))}
    </>
  );
}

describe('useTickerNetFlowBatch — malformed payload crash regression', () => {
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the rows with no badge on a shapeless {} payload and zero console errors', async () => {
    stubFetch({});

    render(<Harness tickers={['AAPL']} />);

    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByText(/Flow (Match|Mismatch)/),
      ).not.toBeInTheDocument();
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('renders the rows with no badge on an HTML-ish string body and zero console errors', async () => {
    stubFetch('<!doctype html><html>oops</html>');

    render(<Harness tickers={['AAPL']} />);

    expect(await screen.findByText('AAPL')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByText(/Flow (Match|Mismatch)/),
      ).not.toBeInTheDocument();
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('keeps healthy tickers when one ticker entry is malformed', async () => {
    stubFetch({
      date: DATE,
      requestedTickers: ['AAPL', 'NVDA'],
      count: 2,
      snapshots: [
        {
          ticker: 'AAPL',
          asOfTs: '2026-05-08T19:00:00.000Z',
          cumNcp: 5_000_000,
          cumNpp: 1_000_000,
        },
        // Malformed entry — non-numeric cumNcp. Must be dropped WITHOUT
        // discarding AAPL.
        {
          ticker: 'NVDA',
          asOfTs: '2026-05-08T19:00:00.000Z',
          cumNcp: 'oops',
          cumNpp: null,
        },
      ],
    });

    render(<Harness tickers={['AAPL', 'NVDA']} />);

    // AAPL: NCP > NPP on a call alert → Flow Match badge renders.
    expect(await screen.findByText('Flow Match')).toBeInTheDocument();
    // NVDA: dropped entry → no badge, no NaN tooltip.
    expect(screen.queryByText('Flow Mismatch')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$NaNM/);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('keeps healthy tickers when a null entry sits in the snapshots array', async () => {
    // The StrikeBattleMap precedent: one unusable entry must not discard
    // the whole batch. A `null` element makes the Map builder throw
    // mid-loop, so without row-level validation every healthy ticker in
    // the same response is lost.
    stubFetch({
      date: DATE,
      requestedTickers: ['AAPL', 'NVDA'],
      count: 2,
      snapshots: [
        {
          ticker: 'AAPL',
          asOfTs: '2026-05-08T19:00:00.000Z',
          cumNcp: 5_000_000,
          cumNpp: 1_000_000,
        },
        null,
      ],
    });

    render(<Harness tickers={['AAPL', 'NVDA']} />);

    expect(await screen.findByText('Flow Match')).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('keeps zero and negative cumulative values (legitimate flow readings)', async () => {
    stubFetch({
      date: DATE,
      requestedTickers: ['AAPL'],
      count: 1,
      snapshots: [
        {
          ticker: 'AAPL',
          asOfTs: '2026-05-08T19:00:00.000Z',
          cumNcp: -4_000_000,
          cumNpp: 0,
        },
      ],
    });

    render(<Harness tickers={['AAPL']} />);

    // Negative NCP vs zero NPP on a call alert → Flow Mismatch. The
    // validator must not reject 0 / negative magnitudes.
    expect(await screen.findByText('Flow Mismatch')).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
