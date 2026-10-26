/**
 * IntervalBARow loads TickerNetFlowChart (and with it lightweight-charts)
 * through React.lazy, so the charts chunk stays out of first paint.
 *
 * React.lazy caches its module for the life of the module graph, so each
 * test resets modules, registers a fresh chart mock with vi.doMock and
 * imports the row anew. The mock counts imports, or rejects the import the
 * way a chunk that failed to load does. An import resolves asynchronously,
 * so the Suspense fallback is on screen right after the expand click.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from '../components/ErrorBoundary';
import { EXPANDED_ROW_CHART_HEIGHT } from '../constants/chart-layout';
import type { IntervalBAFeedAlert } from '../hooks/useIntervalBAFeed';

const { idle } = vi.hoisted(() => ({
  idle: {
    loading: false,
    error: null,
    fetchedAt: null,
    refresh: () => undefined,
  },
}));

vi.mock('../hooks/useContractTape', () => ({
  useContractTape: () => ({ ...idle, data: { series: [] } }),
}));
vi.mock('../hooks/useNetFlowHistory', () => ({
  useNetFlowHistory: () => ({ ...idle, data: { series: [] } }),
}));
vi.mock('../hooks/useTickerCandles', () => ({
  useTickerCandles: () => ({ ...idle, data: null }),
}));
vi.mock('../components/charts/ContractTapeChart', () => ({
  ContractTapeChart: () => <div data-testid="contract-tape-chart" />,
}));

let chartModuleLoads = 0;
let failChartImport = false;

beforeEach(() => {
  chartModuleLoads = 0;
  failChartImport = false;
  vi.resetModules();
  vi.doMock('../components/charts/TickerNetFlowChart', () => {
    chartModuleLoads += 1;
    if (failChartImport) throw new Error('chunk failed to load');
    return {
      TickerNetFlowChart: () => <div data-testid="ticker-netflow-chart" />,
    };
  });
});

afterEach(() => {
  vi.doUnmock('../components/charts/TickerNetFlowChart');
  vi.restoreAllMocks();
});

async function loadRow() {
  const { IntervalBARow } =
    await import('../components/IntervalBAFeed/IntervalBARow');
  return IntervalBARow;
}

const alert = {
  id: 1,
  option_chain: 'SPXW260327C05800000',
  ticker: 'SPXW',
  option_type: 'C',
  strike: 5800,
  expiry: '2026-03-27',
  bucket_start: '2026-03-27T17:05:00.000Z',
  bucket_end: '2026-03-27T17:10:00.000Z',
  fired_at: '2026-03-27T17:06:24.000Z',
  ratio_pct: 85.5,
  ask_premium: 1_200_000,
  total_premium: 1_400_000,
  trade_count: 8,
  top_trade_premium: 600_000,
  top_trade_size: 1000,
  top_trade_executed_at: '2026-03-27T17:06:23.000Z',
  top_trade_is_sweep: false,
  top_trade_is_floor: false,
  underlying_price: 5795,
  confluence_tickers: [],
  severity: 'extreme',
} satisfies IntervalBAFeedAlert;

function expand(ticker: string) {
  fireEvent.click(
    screen.getByRole('button', {
      name: new RegExp(`Expand charts for ${ticker}`),
    }),
  );
}

describe('IntervalBARow — lazy net-flow chart', () => {
  it('loads the chart module only on expand, holding the chart height until it arrives', async () => {
    const IntervalBARow = await loadRow();
    render(
      <IntervalBARow alert={alert} date="2026-03-27" marketOpen={false} />,
    );
    expect(chartModuleLoads).toBe(0);

    expand('SPXW');

    const placeholder = screen.getByText('Loading chart…');
    expect(placeholder).toHaveStyle({
      height: `${EXPANDED_ROW_CHART_HEIGHT}px`,
    });
    expect(screen.queryByTestId('ticker-netflow-chart')).toBeNull();
    // The contract tape panel does not wait on the chart chunk.
    expect(screen.getByTestId('contract-tape-chart')).toBeInTheDocument();

    expect(
      await screen.findByTestId('ticker-netflow-chart'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Loading chart…')).toBeNull();
    expect(chartModuleLoads).toBe(1);
  });

  it('re-expands from the loaded module with no placeholder and no second import', async () => {
    const IntervalBARow = await loadRow();
    render(
      <IntervalBARow alert={alert} date="2026-03-27" marketOpen={false} />,
    );
    expand('SPXW');
    await screen.findByTestId('ticker-netflow-chart');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse charts' }));
    expect(screen.queryByTestId('ticker-netflow-chart')).toBeNull();

    expand('SPXW');
    expect(screen.getByTestId('ticker-netflow-chart')).toBeInTheDocument();
    expect(screen.queryByText('Loading chart…')).toBeNull();
    expect(chartModuleLoads).toBe(1);
  });

  it('contains a failed chart import to its panel, leaving the row and the feed', async () => {
    // React and the ErrorBoundary log the caught error.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    failChartImport = true;
    const IntervalBARow = await loadRow();
    // Stands in for the GatedSection boundary around the whole feed.
    render(
      <ErrorBoundary label="Interval B/A History">
        <IntervalBARow alert={alert} date="2026-03-27" marketOpen={false} />
        <IntervalBARow
          alert={{ ...alert, id: 2, ticker: 'QQQ', option_chain: 'QQQ1' }}
          date="2026-03-27"
          marketOpen={false}
        />
      </ErrorBoundary>,
    );
    expand('SPXW');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Net-flow chart failed to render.',
    );
    expect(
      screen.queryByText('Interval B/A History failed to render.'),
    ).toBeNull();
    // The failing row keeps its header and tape panel; the next row is
    // untouched.
    expect(
      screen.getByRole('link', {
        name: 'Open SPXW260327C05800000 on Unusual Whales',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Collapse charts' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('contract-tape-chart')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Expand charts for QQQ/ }),
    ).toBeInTheDocument();
    expect(chartModuleLoads).toBe(1);
  });
});
