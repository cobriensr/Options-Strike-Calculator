/**
 * IntervalBARow loads TickerNetFlowChart (and with it lightweight-charts)
 * through React.lazy, so the charts chunk stays out of first paint.
 *
 * One test in its own file: React.lazy caches the resolved module for
 * the life of the module graph, so the first load can only be observed
 * once. The chart mock's factory counts imports, and an import resolves
 * asynchronously, so the Suspense fallback is on screen right after the
 * expand click.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EXPANDED_ROW_CHART_HEIGHT } from '../constants/chart-layout';
import type { IntervalBAFeedAlert } from '../hooks/useIntervalBAFeed';

const { chartModuleLoads, idle } = vi.hoisted(() => ({
  chartModuleLoads: { count: 0 },
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
vi.mock('../components/charts/TickerNetFlowChart', () => {
  chartModuleLoads.count += 1;
  return {
    TickerNetFlowChart: () => <div data-testid="ticker-netflow-chart" />,
  };
});

import { IntervalBARow } from '../components/IntervalBAFeed/IntervalBARow';

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

describe('IntervalBARow — lazy net-flow chart', () => {
  it('loads the chart module only on expand, holding the chart height until it arrives', async () => {
    render(
      <IntervalBARow alert={alert} date="2026-03-27" marketOpen={false} />,
    );
    expect(chartModuleLoads.count).toBe(0);

    fireEvent.click(
      screen.getByRole('button', { name: /Expand charts for SPXW/i }),
    );

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
    expect(chartModuleLoads.count).toBe(1);
  });
});
