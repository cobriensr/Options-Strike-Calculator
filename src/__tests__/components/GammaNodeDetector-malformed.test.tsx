/**
 * GammaNodeDetectorPanel × malformed API payloads — crash regression.
 *
 * Unlike GammaNodeDetectorPanel.test.tsx (which mocks useGammaSetups), this
 * file renders the REAL panel + REAL hooks (useGammaSetups AND
 * useGammaWeeklyStats via RollingStatsBar) with only `fetch` mocked, because
 * the production crash lived in the seam between them: a shapeless response
 * body (`{}`, an HTML error page parsed loosely, a 5xx JSON blob) was cast
 * straight to the typed response, so `data.fires.map` /
 * `data.anti_filters.is_fomc_day` threw and the section ErrorBoundary ate
 * the panel.
 *
 * Contract under test: on a malformed payload the panel settles into its
 * normal error/empty state with ZERO console errors; malformed rows inside
 * a valid envelope are dropped while valid rows still render.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { MockInstance } from 'vitest';

import { GammaNodeDetectorPanel } from '../../components/GammaNodeDetector/GammaNodeDetectorPanel';
import type {
  GammaSetupFire,
  GammaSetupsResponse,
} from '../../hooks/useGammaSetups';
import type { AggregateStats } from '../../hooks/useGammaWeeklyStats';

vi.mock('../../utils/auth', () => ({
  getAccessMode: () => 'owner',
  checkIsOwner: () => true,
}));

// ── Fixtures ────────────────────────────────────────────────────

function makeFire(overrides: Partial<GammaSetupFire> = {}): GammaSetupFire {
  return {
    id: 1,
    fired_at: '2026-05-21T14:30:00Z',
    signal_type: 'e1_long_call',
    dow_label: 'Thursday',
    confidence_tier: 'MEDIUM',
    spot_at_fire: 7401,
    node_strike: 7400,
    node_gex: 300_000,
    bar_open: 7395,
    bar_high: 7402,
    bar_low: 7394,
    bar_close: 7401,
    bar_range: 8,
    es_basis_change_5m: 0.5,
    ret_15m: null,
    ret_30m: null,
    ret_60m: null,
    ret_eod: null,
    trade_taken: false,
    trade_pnl_dollars: null,
    ...overrides,
  };
}

function makeResponse(
  overrides: Partial<GammaSetupsResponse> = {},
): GammaSetupsResponse {
  return {
    today: '2026-05-21',
    dow_label: 'Thursday',
    confidence_tier: 'MEDIUM',
    pre_day_filter_fires: false,
    prior_5d_ret: 0.002,
    prior_iv_rank: 18,
    open_gap_pct: 0.1,
    anti_filters: {
      is_fomc_day: false,
      is_dom_1_5: false,
      is_dom_16_20: false,
    },
    nearest_floor: { strike: 7390, gex: 250_000 },
    nearest_ceiling: { strike: 7415, gex: 400_000 },
    fires: [],
    ...overrides,
  };
}

function makeStats(overrides: Partial<AggregateStats> = {}): AggregateStats {
  return {
    from: '2026-04-21',
    to: '2026-05-21',
    n_total: 18,
    n_with_outcome: 15,
    n_winners: 10,
    win_rate: 10 / 15,
    mean_edge_pts: 6.4,
    by_signal: [],
    ...overrides,
  };
}

// ── Fetch stub (routes by URL) ─────────────────────────────────

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(routes: { active: unknown; weeklyStats: unknown }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/gamma-setups/weekly-stats')) {
        return jsonResponse(routes.weeklyStats);
      }
      return jsonResponse(routes.active);
    }),
  );
}

// ── Tests ───────────────────────────────────────────────────────

describe('GammaNodeDetectorPanel — malformed payload crash regression', () => {
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

  it('settles into the error state on a shapeless {} payload with zero console errors', async () => {
    stubFetch({ active: {}, weeklyStats: {} });

    render(<GammaNodeDetectorPanel marketOpen={false} />);

    await waitFor(() =>
      expect(
        screen.getByText(/unexpected response shape/i),
      ).toBeInTheDocument(),
    );
    // Loading hint clears once the fetch settles.
    expect(screen.queryByText('Loading setups…')).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the error state on a garbage (string) payload with zero console errors', async () => {
    stubFetch({
      active: '<!doctype html><h1>502 Bad Gateway</h1>',
      weeklyStats: '<!doctype html><h1>502 Bad Gateway</h1>',
    });

    render(<GammaNodeDetectorPanel marketOpen={false} />);

    await waitFor(() =>
      expect(
        screen.getByText(/unexpected response shape/i),
      ).toBeInTheDocument(),
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('drops malformed fire rows while valid rows still render', async () => {
    const fires = [
      makeFire({ id: 1 }),
      { unexpected: true },
      { ...makeFire({ id: 2, signal_type: 'e5_long_put' }), node_strike: 'x' },
    ] as unknown as GammaSetupFire[];
    stubFetch({
      active: makeResponse({ fires }),
      weeklyStats: makeStats(),
    });

    render(<GammaNodeDetectorPanel marketOpen={false} />);

    // Valid fire renders...
    await waitFor(() =>
      expect(screen.getByTestId('gamma-fire-1')).toBeInTheDocument(),
    );
    expect(screen.getByText('E1')).toBeInTheDocument();
    // ...malformed rows are dropped, not fatal.
    expect(screen.queryByTestId('gamma-fire-2')).toBeNull();
    expect(screen.queryByText('E5')).toBeNull();
    // Day banner renders from the same validated envelope (happy path
    // through the real hooks).
    expect(screen.getByText('Thursday')).toBeInTheDocument();
    // The real weekly-stats fetch feeds the rolling bar.
    expect(await screen.findByText('18 fires')).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('shows the stats error chip when only weekly-stats returns a shapeless payload', async () => {
    stubFetch({ active: makeResponse(), weeklyStats: {} });

    render(<GammaNodeDetectorPanel marketOpen={false} />);

    await waitFor(() =>
      expect(
        screen.getByText('No setups detected yet today.'),
      ).toBeInTheDocument(),
    );
    // RollingStatsBar degrades to its normal error chip.
    expect(await screen.findByText('stats error')).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
