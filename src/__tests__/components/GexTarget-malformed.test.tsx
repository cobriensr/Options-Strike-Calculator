/**
 * GexTarget × malformed API payloads — crash regression
 * (client-shape-hardening-2026-08-20, GexTarget group).
 *
 * The GexTarget panel is fed by THREE endpoints through three hooks, all
 * of which used to parse with an identity cast:
 *
 *   - `/api/gex-target-history?all=true` → useGexTarget (bulk)
 *   - `/api/gex-target-history`          → useGexTarget (single/poll/scrub)
 *   - `/api/periscope-strikes`           → usePeriscopeStrikes (latest slot)
 *   - `/api/nope-intraday`               → useNopeIntraday
 *
 * Unlike GexTarget.test.tsx (which hands the component a hand-built
 * `UseGexTargetReturn` fixture), this file renders the REAL component +
 * REAL hooks with only `fetch` and `lightweight-charts` stubbed, because
 * the crashes live in the seam between hook and render pass.
 *
 * Each case malforms exactly ONE endpoint and returns valid fixtures for
 * the other two, so a failure is attributable to a single parse site.
 *
 * Contract under test: a malformed payload settles into the panel's normal
 * empty/error state with ZERO console errors and no throw.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
} from '@testing-library/react';
import type { MockInstance } from 'vitest';
import { useGexTarget } from '../../hooks/useGexTarget';
import { GexTarget } from '../../components/GexTarget';
import { POLL_INTERVALS } from '../../constants';
import type {
  StrikeScore,
  TargetScore,
  MagnetFeatures,
  ComponentScores,
} from '../../utils/gex-target';

vi.mock('../../utils/auth', () => ({
  getAccessMode: () => 'owner',
  checkIsOwner: () => true,
}));

// ── lightweight-charts stub ───────────────────────────────────────────
// Faithful in the one way that matters here: the real library throws when
// `createPriceLine` receives a non-finite price (the bug fixed in
// e14e9cdc), so the stub throws too. `setData` payloads are recorded so a
// "survives but renders garbage" (NaN axis) outcome is observable.

const { chartState } = vi.hoisted(() => ({
  chartState: {
    priceLines: [] as unknown[],
    seriesData: [] as unknown[][],
  },
}));

vi.mock('lightweight-charts', () => {
  const makeSeries = () => ({
    setData: (data: unknown[]) => {
      chartState.seriesData.push(data);
    },
    createPriceLine: (opts: { price?: unknown }) => {
      if (typeof opts.price !== 'number' || !Number.isFinite(opts.price)) {
        throw new Error(
          `lightweight-charts: invalid price line value ${String(opts.price)}`,
        );
      }
      chartState.priceLines.push(opts);
      return opts;
    },
    removePriceLine: (line: unknown) => {
      chartState.priceLines = chartState.priceLines.filter((l) => l !== line);
    },
  });
  return {
    createChart: () => ({
      addSeries: () => makeSeries(),
      applyOptions: () => undefined,
      remove: () => undefined,
      timeScale: () => ({ fitContent: () => undefined }),
    }),
    CrosshairMode: { Normal: 1 },
    LineStyle: { Dashed: 1, Solid: 0 },
    CandlestickSeries: class CandlestickSeries {},
    LineSeries: class LineSeries {},
  };
});

// ── Fixtures ──────────────────────────────────────────────────────────

const T1 = '2026-08-20T14:00:00.000Z';
const T2 = '2026-08-20T14:05:00.000Z';
const DATE = '2026-08-20';

function makeFeatures(overrides: Partial<MagnetFeatures> = {}): MagnetFeatures {
  return {
    strike: 5800,
    spot: 5795,
    distFromSpot: 5,
    gexDollars: 1_000_000_000,
    callGexDollars: 600_000_000,
    putGexDollars: 400_000_000,
    callDelta: null,
    putDelta: null,
    deltaGex_1m: 10_000_000,
    deltaGex_5m: 50_000_000,
    deltaGex_20m: 150_000_000,
    deltaGex_60m: 300_000_000,
    prevGexDollars_1m: 990_000_000,
    prevGexDollars_5m: 950_000_000,
    prevGexDollars_10m: 930_000_000,
    prevGexDollars_15m: 900_000_000,
    prevGexDollars_20m: 850_000_000,
    prevGexDollars_60m: 700_000_000,
    deltaPct_1m: 0.01,
    deltaPct_5m: 0.053,
    deltaPct_20m: 0.18,
    deltaPct_60m: 0.43,
    callRatio: 0.2,
    charmNet: 1e7,
    deltaNet: 5e8,
    vannaNet: 1e7,
    minutesAfterNoonCT: 60,
    ...overrides,
  };
}

function makeComponents(
  overrides: Partial<ComponentScores> = {},
): ComponentScores {
  return {
    flowConfluence: 0.6,
    priceConfirm: 0.4,
    charmScore: 0.3,
    dominance: 0.7,
    clarity: 0.8,
    proximity: 0.9,
    ...overrides,
  };
}

function makeStrike(overrides: Partial<StrikeScore> = {}): StrikeScore {
  return {
    strike: 5800,
    features: makeFeatures(),
    components: makeComponents(),
    finalScore: 0.55,
    tier: 'HIGH',
    wallSide: 'CALL',
    rankByScore: 1,
    rankBySize: 2,
    isTarget: true,
    ...overrides,
  };
}

function makeTargetScore(overrides: Partial<TargetScore> = {}): TargetScore {
  const target = makeStrike();
  return { target, leaderboard: [target], ...overrides };
}

function makeSnapshot(
  timestamp: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    timestamp,
    spot: 5795,
    oi: makeTargetScore(),
    vol: makeTargetScore(),
    dir: makeTargetScore(),
    ...overrides,
  };
}

// 13:35 UTC = 08:35 CDT — inside the 08:30–15:00 CT regular session filter.
const CANDLES = [
  {
    datetime: Date.UTC(2026, 7, 20, 13, 35),
    open: 5790,
    high: 5800,
    low: 5785,
    close: 5795,
    volume: 12_000,
  },
  {
    datetime: Date.UTC(2026, 7, 20, 13, 36),
    open: 5795,
    high: 5805,
    low: 5790,
    close: 5800,
    volume: 11_000,
  },
];

function validBulk(overrides: Record<string, unknown> = {}) {
  return {
    availableDates: [DATE],
    date: DATE,
    timestamps: [T1, T2],
    candles: CANDLES,
    previousClose: 5788,
    snapshots: [makeSnapshot(T1), makeSnapshot(T2)],
    ...overrides,
  };
}

function validSingle(overrides: Record<string, unknown> = {}) {
  return {
    availableDates: [DATE],
    date: DATE,
    timestamps: [T1, T2],
    timestamp: T2,
    spot: 5795,
    oi: makeTargetScore(),
    vol: makeTargetScore(),
    dir: makeTargetScore(),
    candles: CANDLES,
    previousClose: 5788,
    ...overrides,
  };
}

const SLOTS = [
  '2026-08-20T13:40:00.000Z',
  '2026-08-20T13:50:00.000Z',
  '2026-08-20T14:00:00.000Z',
  '2026-08-20T14:10:00.000Z',
];

function validPeriscope(overrides: Record<string, unknown> = {}) {
  return {
    marketOpen: true,
    asOf: '2026-08-20T14:12:00.000Z',
    capturedAt: SLOTS.at(-1),
    priorCapturedAt: SLOTS[2],
    spot: 5795,
    strikes: [
      { strike: 5800, gamma: 5000, charm: -400_000 },
      { strike: 5825, gamma: 3000, charm: 33_000 },
    ],
    availableSlots: SLOTS,
    ...overrides,
  };
}

function validNope(overrides: Record<string, unknown> = {}) {
  return {
    ticker: 'SPY',
    date: DATE,
    availableDates: [DATE],
    points: [
      {
        timestamp: '2026-08-20T14:00:00.000Z',
        nope: -0.000648,
        nope_fill: -0.0004,
      },
      {
        timestamp: '2026-08-20T14:01:00.000Z',
        nope: 0.000123,
        nope_fill: 0.0001,
      },
    ],
    ...overrides,
  };
}

// ── Fetch router ──────────────────────────────────────────────────────

interface RouteOverrides {
  bulk?: unknown;
  single?: unknown;
  periscopeLatest?: unknown;
  nope?: unknown;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(routes: RouteOverrides = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      calls.push(url);
      if (url.includes('/api/nope-intraday')) {
        return jsonResponse(routes.nope ?? validNope());
      }
      if (url.includes('/api/periscope-strikes')) {
        return jsonResponse(routes.periscopeLatest ?? validPeriscope());
      }
      if (url.includes('/api/gex-target-history')) {
        if (url.includes('all=true')) {
          return jsonResponse(routes.bulk ?? validBulk());
        }
        return jsonResponse(routes.single ?? validSingle());
      }
      return jsonResponse({});
    }),
  );
  return calls;
}

// ── Harness ───────────────────────────────────────────────────────────

function Harness({ marketOpen = true }: { marketOpen?: boolean }) {
  const gexTarget = useGexTarget(marketOpen);
  return <GexTarget marketOpen={marketOpen} gexTarget={gexTarget} />;
}

/**
 * Flush the trailing async state updates. Three endpoints resolve on
 * independent promise chains (bulk, periscope latest, NOPE);
 * without this the later ones land after the test body finishes and React
 * logs an act(...) warning through console.error, which would masquerade
 * as a shape-hardening failure.
 */
async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Panel rendered its content (not the ErrorBoundary / not still loading). */
async function waitForPanel() {
  await waitFor(() =>
    expect(screen.queryByText(/loading gex target/i)).not.toBeInTheDocument(),
  );
  await settle();
}

describe('GexTarget — malformed payload crash regression', () => {
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    chartState.priceLines = [];
    chartState.seriesData = [];
    consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── Cast 1: /api/gex-target-history?all=true (useGexTarget:423) ──────

  describe('bulk /api/gex-target-history?all=true', () => {
    it('settles with a shapeless {} bulk payload', async () => {
      stubFetch({ bulk: {} });
      render(<Harness />);
      await waitForPanel();
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('settles with an HTML-ish string bulk body', async () => {
      stubFetch({ bulk: '<!doctype html><html>gateway timeout</html>' });
      render(<Harness />);
      await waitForPanel();
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('settles when the latest snapshot has a shapeless mode object', async () => {
      stubFetch({
        bulk: validBulk({
          snapshots: [
            makeSnapshot(T1),
            // `oi` present but shapeless — `leaderboard` missing entirely.
            makeSnapshot(T2, { oi: { target: null } }),
          ],
        }),
      });
      render(<Harness />);
      await waitForPanel();
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('drops malformed leaderboard rows and renders the valid ones', async () => {
      stubFetch({
        bulk: validBulk({
          snapshots: [
            makeSnapshot(T1),
            makeSnapshot(T2, {
              oi: {
                target: null,
                leaderboard: [
                  makeStrike({ strike: 5800 }),
                  // Malformed row — no `features`. Dropped, not fatal.
                  { strike: 5850, finalScore: 0.1 },
                ],
              },
            }),
          ],
        }),
      });
      render(<Harness />);
      await waitForPanel();
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('settles when snapshots is a non-array scalar', async () => {
      stubFetch({ bulk: validBulk({ snapshots: 7 }) });
      render(<Harness />);
      await waitForPanel();
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('settles when the envelope arrays arrive as objects', async () => {
      stubFetch({
        bulk: validBulk({ availableDates: { a: 1 }, timestamps: { b: 2 } }),
      });
      render(<Harness />);
      await waitForPanel();
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('settles when candles rows are shapeless', async () => {
      stubFetch({
        bulk: validBulk({ candles: [{ nope: true }, 'garbage'] }),
      });
      render(<Harness />);
      await waitForPanel();
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  // ── Cast 2: /api/gex-target-history (single) (useGexTarget:363) ──────

  describe('single /api/gex-target-history (poll path)', () => {
    it('settles when the polled single payload is shapeless', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      stubFetch({ single: {} });
      render(<Harness />);
      await waitForPanel();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_INTERVALS.GEX_TARGET + 100);
      });
      await settle();
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('settles when the polled single payload has a shapeless mode object', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      stubFetch({ single: validSingle({ oi: { target: null } }) });
      render(<Harness />);
      await waitForPanel();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_INTERVALS.GEX_TARGET + 100);
      });
      await settle();
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  // ── Cast 3/4: /api/periscope-strikes (usePeriscopeStrikes:107, :132) ─

  describe('/api/periscope-strikes', () => {
    it('settles when the latest slot payload is shapeless {}', async () => {
      stubFetch({ periscopeLatest: {} });
      render(<Harness />);
      await waitForPanel();
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('settles when the latest slot payload is an HTML-ish string', async () => {
      stubFetch({ periscopeLatest: '<!doctype html><html>oops</html>' });
      render(<Harness />);
      await waitForPanel();
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('requests the latest slot only — no lookback round-trips', async () => {
      // Companion to the hook-level count pin
      // (src/__tests__/hooks/usePeriscopeStrikes.test.ts). Asserted from
      // the real panel so a consumer that reintroduces Δ%-map lookbacks
      // is caught here too. Lookbacks were the only periscope requests
      // that carried `time=` for an unscrubbed panel.
      const calls = stubFetch();
      render(<Harness />);
      await waitForPanel();
      const periscopeCalls = calls.filter((u) =>
        u.includes('/api/periscope-strikes'),
      );
      expect(periscopeCalls).toHaveLength(1);
      expect(periscopeCalls.some((u) => u.includes('time='))).toBe(false);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('settles when availableSlots is missing but capturedAt is present', async () => {
      stubFetch({
        periscopeLatest: validPeriscope({ availableSlots: undefined }),
      });
      render(<Harness />);
      await waitForPanel();
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('settles when strikes arrives as a non-iterable object', async () => {
      stubFetch({ periscopeLatest: validPeriscope({ strikes: { a: 1 } }) });
      render(<Harness />);
      await waitForPanel();
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('drops malformed strike rows and keeps the valid ones', async () => {
      stubFetch({
        periscopeLatest: validPeriscope({
          strikes: [
            { strike: 5800, gamma: 5000, charm: -1 },
            'garbage',
            { strike: 'oops', gamma: 1, charm: 1 },
          ],
        }),
      });
      render(<Harness />);
      await waitForPanel();
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  // ── Cast 5: /api/nope-intraday (useNopeIntraday:78) ──────────────────

  describe('/api/nope-intraday', () => {
    it('settles with a shapeless {} payload', async () => {
      stubFetch({ nope: {} });
      render(<Harness />);
      await waitForPanel();
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('settles when points is a non-array scalar', async () => {
      stubFetch({ nope: validNope({ points: 'garbage' }) });
      render(<Harness />);
      await waitForPanel();
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('drops malformed NOPE points instead of plotting NaN', async () => {
      stubFetch({
        nope: validNope({
          points: [
            {
              timestamp: '2026-08-20T14:00:00.000Z',
              nope: 0.001,
              nope_fill: 0,
            },
            'garbage',
            { timestamp: 'not-a-date', nope: 0.002, nope_fill: 0 },
            { timestamp: '2026-08-20T14:02:00.000Z', nope: null, nope_fill: 0 },
          ],
        }),
      });
      render(<Harness />);
      await waitForPanel();
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      // No NaN time / value ever reaches the chart series.
      const plotted = chartState.seriesData.flat() as Array<{
        time?: unknown;
        value?: unknown;
      }>;
      for (const p of plotted) {
        expect(Number.isNaN(p.time)).toBe(false);
        expect(Number.isNaN(p.value)).toBe(false);
      }
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('settles with a shapeless {} payload while scrubbed', async () => {
      stubFetch({ nope: {} });
      render(<Harness />);
      await waitForPanel();
      // Step back one snapshot — the scrubbed branch filters nopePoints.
      const prev = screen.getByLabelText('Previous snapshot');
      await act(async () => {
        fireEvent.click(prev);
      });
      expect(screen.getByText('GEX TARGET')).toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });
});
