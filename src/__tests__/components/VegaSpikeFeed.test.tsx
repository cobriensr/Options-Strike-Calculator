import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import VegaSpikeFeed from '../../components/VegaSpikeFeed/VegaSpikeFeed';
import type { VegaSpike, VegaSpikesState } from '../../hooks/useVegaSpikes';

// ── Mock the hook ──────────────────────────────────────────

const mockHookReturn = vi.hoisted(() => ({
  value: undefined as VegaSpikesState | undefined,
}));

vi.mock('../../hooks/useVegaSpikes', async () => {
  const actual = await vi.importActual<
    typeof import('../../hooks/useVegaSpikes')
  >('../../hooks/useVegaSpikes');
  return {
    ...actual,
    useVegaSpikes: (): VegaSpikesState => {
      if (!mockHookReturn.value) {
        throw new Error('mockHookReturn.value not initialized');
      }
      return mockHookReturn.value;
    },
  };
});

// ── Helpers ───────────────────────────────────────────────

function makeSpike(overrides: Partial<VegaSpike> = {}): VegaSpike {
  return {
    id: 1,
    ticker: 'SPY',
    date: '2026-04-27',
    timestamp: '2026-04-27T17:00:00.000Z', // 12:00 CT
    dirVegaFlow: 5_620_000,
    zScore: 28.4,
    vsPriorMax: 4.8,
    priorMax: 1_170_000,
    baselineMad: 198_000,
    barsElapsed: 210,
    confluence: false,
    fwdReturn5m: 0.0018,
    fwdReturn15m: 0.0041,
    fwdReturn30m: 0.0062,
    fwdReturnEoD: 0.0085,
    insertedAt: '2026-04-27T17:00:18.412Z',
    ...overrides,
  };
}

function setHookState(overrides: Partial<VegaSpikesState> = {}) {
  const setRange = vi.fn();
  mockHookReturn.value = {
    spikes: [],
    loading: false,
    error: null,
    range: 'today',
    setRange,
    ...overrides,
  };
  return { setRange };
}

beforeEach(() => {
  mockHookReturn.value = undefined;
});

// ============================================================
// EMPTY / LOADING / ERROR STATES
// ============================================================

describe('VegaSpikeFeed: empty + loading + error', () => {
  it('renders empty state when no spikes', () => {
    setHookState({ spikes: [] });
    render(<VegaSpikeFeed marketOpen={true} />);
    expect(screen.getByTestId('vega-spike-empty')).toHaveTextContent(
      'No spikes detected for this range',
    );
    // Ensure no row was rendered.
    expect(screen.queryAllByTestId('vega-spike-row')).toHaveLength(0);
  });

  it('renders loading state on first load (loading + empty)', () => {
    setHookState({ spikes: [], loading: true });
    render(<VegaSpikeFeed marketOpen={true} />);
    expect(screen.getByTestId('vega-spike-loading')).toBeInTheDocument();
  });

  it('shows error banner above table without replacing it', () => {
    setHookState({
      spikes: [makeSpike({ id: 7 })],
      error: 'Network error',
    });
    render(<VegaSpikeFeed marketOpen={true} />);
    const errorEl = screen.getByTestId('vega-spike-error');
    expect(errorEl).toHaveTextContent('Network error');
    // Table still renders.
    expect(screen.getAllByTestId('vega-spike-row')).toHaveLength(1);
  });
});

// ============================================================
// ROW RENDERING
// ============================================================

describe('VegaSpikeFeed: rows', () => {
  it('renders one row per spike', () => {
    setHookState({
      spikes: [
        makeSpike({ id: 1 }),
        makeSpike({ id: 2, ticker: 'QQQ', dirVegaFlow: 510_000 }),
        makeSpike({ id: 3, ticker: 'SPY', dirVegaFlow: -2_300_000 }),
      ],
    });
    render(<VegaSpikeFeed marketOpen={true} />);
    expect(screen.getAllByTestId('vega-spike-row')).toHaveLength(3);
  });

  it('renders spike count in header', () => {
    setHookState({
      spikes: [makeSpike({ id: 1 }), makeSpike({ id: 2 })],
    });
    render(<VegaSpikeFeed marketOpen={true} />);
    expect(screen.getByTestId('vega-spike-count')).toHaveTextContent(
      'n=2 events',
    );
  });

  it('formats Dir Vega values with M/K suffix and forced sign', () => {
    setHookState({
      spikes: [
        makeSpike({ id: 1, dirVegaFlow: 5_620_000 }),
        makeSpike({ id: 2, dirVegaFlow: 510_000 }),
        makeSpike({ id: 3, dirVegaFlow: -2_300_000 }),
      ],
    });
    render(<VegaSpikeFeed marketOpen={true} />);
    expect(screen.getByText('+5.62M')).toBeInTheDocument();
    expect(screen.getByText('+510K')).toBeInTheDocument();
    expect(screen.getByText('-2.30M')).toBeInTheDocument();
  });

  it('positive Dir Vega gets text-success class; negative gets text-danger', () => {
    setHookState({
      spikes: [
        makeSpike({ id: 1, dirVegaFlow: 5_620_000 }),
        makeSpike({ id: 2, dirVegaFlow: -2_300_000 }),
      ],
    });
    render(<VegaSpikeFeed marketOpen={true} />);
    const positiveCell = screen.getByText('+5.62M');
    const negativeCell = screen.getByText('-2.30M');
    expect(positiveCell.className).toContain('text-success');
    expect(negativeCell.className).toContain('text-danger');
  });

  it('renders Time column in CT (en-US 24h, America/Chicago)', () => {
    // 17:00 UTC -> 12:00 CT (CDT, UTC-5).
    setHookState({
      spikes: [makeSpike({ id: 1, timestamp: '2026-04-27T17:00:00.000Z' })],
    });
    render(<VegaSpikeFeed marketOpen={true} />);
    expect(screen.getByText('12:00')).toBeInTheDocument();
  });

  it('prepends date for 7d/30d ranges', () => {
    setHookState({
      range: '7d',
      spikes: [makeSpike({ id: 1, timestamp: '2026-04-23T16:30:00.000Z' })],
    });
    render(<VegaSpikeFeed marketOpen={true} />);
    // 16:30 UTC -> 11:30 CT on Apr 23.
    expect(screen.getByText(/Apr 23/)).toBeInTheDocument();
    expect(screen.getByText(/11:30/)).toBeInTheDocument();
  });

  it('renders forward-return null as em dash, not "null"', () => {
    setHookState({
      spikes: [
        makeSpike({
          id: 1,
          fwdReturn5m: null,
          fwdReturn15m: null,
          fwdReturn30m: null,
          fwdReturnEoD: null,
        }),
      ],
    });
    render(<VegaSpikeFeed marketOpen={true} />);
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('null')).not.toBeInTheDocument();
  });

  it('confluence row gets a distinguishing data-confluence attribute', () => {
    setHookState({
      spikes: [
        makeSpike({ id: 1, confluence: false }),
        makeSpike({ id: 2, confluence: true }),
      ],
    });
    render(<VegaSpikeFeed marketOpen={true} />);
    const rows = screen.getAllByTestId('vega-spike-row');
    expect(rows[0]?.getAttribute('data-confluence')).toBeNull();
    expect(rows[1]?.getAttribute('data-confluence')).toBe('true');
    // Ring class applied for visual emphasis.
    expect(rows[1]?.className).toContain('ring-amber-500/40');
  });
});

// ============================================================
// RANGE TOGGLE
// ============================================================

describe('VegaSpikeFeed: range toggle', () => {
  it('calls setRange("today") when Today is clicked', async () => {
    const user = userEvent.setup();
    const { setRange } = setHookState({ range: '7d' });
    render(<VegaSpikeFeed marketOpen={true} />);
    await user.click(screen.getByTestId('vega-range-today'));
    expect(setRange).toHaveBeenCalledWith('today');
  });

  it('calls setRange("7d") when 7 days is clicked', async () => {
    const user = userEvent.setup();
    const { setRange } = setHookState({ range: 'today' });
    render(<VegaSpikeFeed marketOpen={true} />);
    await user.click(screen.getByTestId('vega-range-7d'));
    expect(setRange).toHaveBeenCalledWith('7d');
  });

  it('calls setRange("30d") when 30 days is clicked', async () => {
    const user = userEvent.setup();
    const { setRange } = setHookState({ range: 'today' });
    render(<VegaSpikeFeed marketOpen={true} />);
    await user.click(screen.getByTestId('vega-range-30d'));
    expect(setRange).toHaveBeenCalledWith('30d');
  });

  it('marks the active range with aria-pressed="true"', () => {
    setHookState({ range: '7d' });
    render(<VegaSpikeFeed marketOpen={true} />);
    expect(
      screen.getByTestId('vega-range-7d').getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByTestId('vega-range-today').getAttribute('aria-pressed'),
    ).toBe('false');
  });
});

// ============================================================
// ACCESSIBILITY
// ============================================================

describe('VegaSpikeFeed: accessibility', () => {
  it('renders the panel as a region with an aria-label', () => {
    setHookState({ spikes: [makeSpike()] });
    render(<VegaSpikeFeed marketOpen={true} />);
    const region = screen.getByRole('region', { name: 'Dir Vega Spikes' });
    expect(region).toBeInTheDocument();
  });

  it('column headers use scope="col"', () => {
    setHookState({ spikes: [makeSpike()] });
    render(<VegaSpikeFeed marketOpen={true} />);
    const headers = screen.getAllByRole('columnheader');
    // 9 columns: Time, Tkr, Dir Vega, z, vs prior max, +5m, +15m, +30m, +EoD.
    expect(headers).toHaveLength(9);
    for (const h of headers) {
      expect(h.getAttribute('scope')).toBe('col');
    }
  });

  it('range toggle is grouped with role="group" and aria-label', () => {
    setHookState({});
    render(<VegaSpikeFeed marketOpen={true} />);
    expect(
      screen.getByRole('group', { name: 'Vega spike range' }),
    ).toBeInTheDocument();
  });

  it('ticker filter toggle is grouped with role="group" and aria-label', () => {
    setHookState({});
    render(<VegaSpikeFeed marketOpen={true} />);
    expect(
      screen.getByRole('group', { name: 'Vega spike ticker filter' }),
    ).toBeInTheDocument();
  });
});

// ============================================================
// TICKER FILTER
// ============================================================

describe('VegaSpikeFeed: ticker filter', () => {
  it('defaults to "All" — both SPY and QQQ rows render', () => {
    setHookState({
      spikes: [
        makeSpike({ id: 1, ticker: 'SPY' }),
        makeSpike({ id: 2, ticker: 'QQQ' }),
      ],
    });
    render(<VegaSpikeFeed marketOpen={true} />);
    expect(screen.getAllByTestId('vega-spike-row')).toHaveLength(2);
    expect(
      screen.getByTestId('vega-ticker-all').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('filters to SPY only when SPY toggle is clicked', async () => {
    const user = userEvent.setup();
    setHookState({
      spikes: [
        makeSpike({ id: 1, ticker: 'SPY' }),
        makeSpike({ id: 2, ticker: 'QQQ' }),
        makeSpike({ id: 3, ticker: 'SPY' }),
      ],
    });
    render(<VegaSpikeFeed marketOpen={true} />);
    await user.click(screen.getByTestId('vega-ticker-SPY'));

    const rows = screen.getAllByTestId('vega-spike-row');
    expect(rows).toHaveLength(2);
    // Count badge tracks the filtered count.
    expect(screen.getByTestId('vega-spike-count')).toHaveTextContent(
      'n=2 events',
    );
  });

  it('shows ticker-aware empty state when filter excludes all rows', async () => {
    const user = userEvent.setup();
    setHookState({
      spikes: [makeSpike({ id: 1, ticker: 'SPY' })],
    });
    render(<VegaSpikeFeed marketOpen={true} />);
    await user.click(screen.getByTestId('vega-ticker-QQQ'));

    expect(screen.getByTestId('vega-spike-empty')).toHaveTextContent(
      'No QQQ spikes in this range',
    );
  });
});
