// @vitest-environment jsdom

/**
 * Panel-level tests for `GammaNodeDetectorPanel` — exercises the
 * loading / error / empty / populated states. Inner components
 * (`FireRow`, `DayConfidenceBanner`) are covered by their own tests in
 * `GammaNodeDetector.test.tsx`; this file mocks `useGammaSetups` and
 * asserts that the panel wires their state correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import type {
  GammaSetupFire,
  GammaSetupsResponse,
  UseGammaSetupsState,
} from '../hooks/useGammaSetups';

// ── Mocks ───────────────────────────────────────────────────────

const useGammaSetupsMock = vi.fn<(open: boolean) => UseGammaSetupsState>();

vi.mock('../hooks/useGammaSetups', () => ({
  useGammaSetups: (open: boolean) => useGammaSetupsMock(open),
}));

// RollingStatsBar has its own dedicated test file; stub it here so the
// panel test stays focused on the gamma-setups data flow and doesn't
// drag in an unmocked /api/gamma-setups/weekly-stats fetch.
vi.mock('../components/GammaNodeDetector/RollingStatsBar', () => ({
  RollingStatsBar: ({ marketOpen }: { marketOpen: boolean }) => (
    <div data-testid="rolling-stats-bar-stub" data-market-open={marketOpen} />
  ),
}));

import { GammaNodeDetectorPanel } from '../components/GammaNodeDetector/GammaNodeDetectorPanel';

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

function setHookState(state: Partial<UseGammaSetupsState>): void {
  useGammaSetupsMock.mockReturnValue({
    data: null,
    loading: false,
    error: null,
    refresh: vi.fn(async () => {}),
    ...state,
  });
}

beforeEach(() => {
  useGammaSetupsMock.mockReset();
});

// ── Tests ───────────────────────────────────────────────────────

describe('GammaNodeDetectorPanel', () => {
  it('renders the SectionBox label as the heading', () => {
    setHookState({ data: makeResponse() });
    render(<GammaNodeDetectorPanel marketOpen={false} />);
    expect(screen.getByText('Gamma-Node Composite Detector')).toBeDefined();
  });

  it('shows the loading hint when data is null and loading=true', () => {
    setHookState({ loading: true });
    render(<GammaNodeDetectorPanel marketOpen={true} />);
    expect(screen.getByText('Loading setups…')).toBeDefined();
  });

  it('renders the error banner when the hook surfaces an error', () => {
    setHookState({ error: 'fetch failed: 500' });
    render(<GammaNodeDetectorPanel marketOpen={false} />);
    expect(screen.getByText('fetch failed: 500')).toBeDefined();
    // Loading hint is suppressed once an error is present (data is still null
    // but loading flipped back to false).
    expect(screen.queryByText('Loading setups…')).toBeNull();
  });

  it('shows the empty-state line when fires is empty', () => {
    setHookState({ data: makeResponse({ fires: [] }) });
    render(<GammaNodeDetectorPanel marketOpen={true} />);
    expect(screen.getByText('No setups detected yet today.')).toBeDefined();
  });

  it('renders one FireRow per fire and skips the empty-state copy', () => {
    setHookState({
      data: makeResponse({
        fires: [
          makeFire({ id: 1, signal_type: 'e1_long_call', node_strike: 7400 }),
          makeFire({ id: 2, signal_type: 'e5_long_put', node_strike: 7385 }),
          makeFire({
            id: 3,
            signal_type: 'pcs_monday',
            node_strike: 7375,
            dow_label: 'Monday',
            confidence_tier: 'MAXIMUM',
          }),
        ],
      }),
    });
    render(<GammaNodeDetectorPanel marketOpen={true} />);

    expect(screen.queryByText('No setups detected yet today.')).toBeNull();
    expect(screen.getByText('E1')).toBeDefined();
    expect(screen.getByText('E5')).toBeDefined();
    expect(screen.getByText('PCS')).toBeDefined();
    expect(screen.getByText(/Strike 7400/)).toBeDefined();
    expect(screen.getByText(/Strike 7385/)).toBeDefined();
    expect(screen.getByText(/Strike 7375/)).toBeDefined();
  });

  it('forwards marketOpen into useGammaSetups so polling gates correctly', () => {
    setHookState({ data: makeResponse() });
    render(<GammaNodeDetectorPanel marketOpen={true} />);
    expect(useGammaSetupsMock).toHaveBeenCalledWith(true);
  });

  it('renders error + populated data together when both are present', () => {
    // A successful first fetch followed by a failed refresh leaves the
    // last-known data visible while the error banner surfaces the failure.
    setHookState({
      data: makeResponse({ fires: [makeFire({ id: 99 })] }),
      error: 'fetch failed: 502',
    });
    render(<GammaNodeDetectorPanel marketOpen={true} />);
    expect(screen.getByText('fetch failed: 502')).toBeDefined();
    expect(screen.getByText('E1')).toBeDefined();
  });
});
