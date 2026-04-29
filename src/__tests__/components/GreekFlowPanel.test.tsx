import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GreekFlowPanel } from '../../components/GreekFlowPanel';
import type {
  GreekFlowMetrics,
  GreekFlowResponse,
  GreekFlowRow,
  UseGreekFlowReturn,
} from '../../hooks/useGreekFlow';

vi.mock('../../hooks/useGreekFlow', async () => {
  const actual = await vi.importActual<
    typeof import('../../hooks/useGreekFlow')
  >('../../hooks/useGreekFlow');
  return {
    ...actual,
    useGreekFlow: vi.fn(),
  };
});

vi.mock('../../utils/timezone', async () => {
  const actual = await vi.importActual<typeof import('../../utils/timezone')>(
    '../../utils/timezone',
  );
  return {
    ...actual,
    getETToday: () => '2026-04-28',
  };
});

import { useGreekFlow } from '../../hooks/useGreekFlow';

const mockUseGreekFlow = vi.mocked(useGreekFlow);

function emptyMetric() {
  return {
    slope: { slope: null, points: 0 },
    flip: {
      occurred: false,
      atTimestamp: null,
      magnitude: 0,
      currentSign: 0 as const,
    },
    cliff: { magnitude: 0, atTimestamp: null },
  };
}

function emptyMetrics(): GreekFlowMetrics {
  return {
    dir_vega_flow: emptyMetric(),
    total_vega_flow: emptyMetric(),
    otm_dir_vega_flow: emptyMetric(),
    otm_total_vega_flow: emptyMetric(),
    dir_delta_flow: emptyMetric(),
    total_delta_flow: emptyMetric(),
    otm_dir_delta_flow: emptyMetric(),
    otm_total_delta_flow: emptyMetric(),
  };
}

function emptyDivergence(): GreekFlowResponse['divergence'] {
  const div = {
    spySign: 0 as const,
    qqqSign: 0 as const,
    diverging: false,
  };
  return {
    dir_vega_flow: div,
    total_vega_flow: div,
    otm_dir_vega_flow: div,
    otm_total_vega_flow: div,
    dir_delta_flow: div,
    total_delta_flow: div,
    otm_dir_delta_flow: div,
    otm_total_delta_flow: div,
  };
}

function fakeRow(ticker: 'SPY' | 'QQQ', i: number): GreekFlowRow {
  // 5 sample minutes; cum_* matches a running sum of monotonic per-minute
  // values so the FlowChart has something to render.
  return {
    ticker,
    timestamp: new Date(
      new Date('2026-04-28T13:30:00Z').getTime() + i * 60_000,
    ).toISOString(),
    transactions: 100,
    volume: 500,
    dir_vega_flow: 1,
    total_vega_flow: 2,
    otm_dir_vega_flow: 1,
    otm_total_vega_flow: 1,
    dir_delta_flow: 1,
    total_delta_flow: 1,
    otm_dir_delta_flow: 1,
    otm_total_delta_flow: 1,
    cum_dir_vega_flow: i + 1,
    cum_total_vega_flow: (i + 1) * 2,
    cum_otm_dir_vega_flow: i + 1,
    cum_otm_total_vega_flow: i + 1,
    cum_dir_delta_flow: i + 1,
    cum_total_delta_flow: i + 1,
    cum_otm_dir_delta_flow: i + 1,
    cum_otm_total_delta_flow: i + 1,
  };
}

function happyPathReturn(): UseGreekFlowReturn {
  const rows = (ticker: 'SPY' | 'QQQ') =>
    Array.from({ length: 5 }, (_, i) => fakeRow(ticker, i));
  const data: GreekFlowResponse = {
    date: '2026-04-28',
    tickers: {
      SPY: { rows: rows('SPY'), metrics: emptyMetrics() },
      QQQ: { rows: rows('QQQ'), metrics: emptyMetrics() },
    },
    divergence: emptyDivergence(),
    asOf: '2026-04-28T21:00:00.000Z',
  };
  return { data, loading: false, error: null, refresh: vi.fn() };
}

beforeEach(() => {
  mockUseGreekFlow.mockReset();
});

describe('GreekFlowPanel', () => {
  it('renders the heading and ticker tabs', () => {
    mockUseGreekFlow.mockReturnValue(happyPathReturn());
    render(<GreekFlowPanel marketOpen={false} />);
    expect(
      screen.getByRole('heading', { name: /greek flow/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'SPY' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'QQQ' })).toBeInTheDocument();
  });

  it('renders an alert when the hook errors', () => {
    mockUseGreekFlow.mockReturnValue({
      data: null,
      loading: false,
      error: 'boom',
      refresh: vi.fn(),
    });
    render(<GreekFlowPanel marketOpen={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });

  it('shows a loading message when loading and no data', () => {
    mockUseGreekFlow.mockReturnValue({
      data: null,
      loading: true,
      error: null,
      refresh: vi.fn(),
    });
    render(<GreekFlowPanel marketOpen={false} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('renders the empty-data message when API returns no date', () => {
    mockUseGreekFlow.mockReturnValue({
      data: {
        date: null,
        tickers: {
          SPY: { rows: [], metrics: emptyMetrics() },
          QQQ: { rows: [], metrics: emptyMetrics() },
        },
        divergence: emptyDivergence(),
        asOf: '2026-04-28T21:00:00.000Z',
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(<GreekFlowPanel marketOpen={false} />);
    expect(screen.getByText(/no greek flow data/i)).toBeInTheDocument();
  });

  it('renders all 8 chart cells for the active ticker on the happy path', () => {
    mockUseGreekFlow.mockReturnValue(happyPathReturn());
    render(<GreekFlowPanel marketOpen={true} />);
    // 8 distinct field labels per ticker; SPY is the default tab.
    const labels = [
      'Dir Vega',
      'OTM Dir Vega',
      'Vega',
      'OTM Vega',
      'Dir Delta',
      'OTM Dir Delta',
      'Delta',
      'OTM Delta',
    ];
    for (const label of labels) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('switches the visible ticker when the QQQ tab is clicked', () => {
    mockUseGreekFlow.mockReturnValue(happyPathReturn());
    render(<GreekFlowPanel marketOpen={true} />);

    const qqqTab = screen.getByRole('tab', { name: 'QQQ' });
    expect(qqqTab).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(qqqTab);
    expect(qqqTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'SPY' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });
});
