import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GreekFlowPanel } from '../../components/GreekFlowPanel';
import type {
  DivergenceResult,
  GreekFlowMetrics,
  GreekFlowResponse,
  GreekFlowRow,
  Sign,
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

function div(spy: Sign, qqq: Sign): DivergenceResult {
  return {
    spySign: spy,
    qqqSign: qqq,
    diverging: spy !== 0 && qqq !== 0 && spy !== qqq,
  };
}

const NEUTRAL_DIV = div(0, 0);

function divergenceFor(
  delta: DivergenceResult,
  vega: DivergenceResult,
): GreekFlowResponse['divergence'] {
  return {
    dir_vega_flow: NEUTRAL_DIV,
    total_vega_flow: NEUTRAL_DIV,
    otm_dir_vega_flow: vega,
    otm_total_vega_flow: NEUTRAL_DIV,
    dir_delta_flow: NEUTRAL_DIV,
    total_delta_flow: NEUTRAL_DIV,
    otm_dir_delta_flow: delta,
    otm_total_delta_flow: NEUTRAL_DIV,
  };
}

function fakeRow(
  ticker: 'SPY' | 'QQQ',
  i: number,
  deltaSign: 1 | -1 = 1,
  vegaSign: 1 | -1 = 1,
): GreekFlowRow {
  const cumDelta = (i + 1) * deltaSign;
  const cumVega = (i + 1) * vegaSign;
  return {
    ticker,
    timestamp: new Date(
      new Date('2026-04-28T13:30:00Z').getTime() + i * 60_000,
    ).toISOString(),
    transactions: 100,
    volume: 500,
    dir_vega_flow: vegaSign,
    total_vega_flow: 2,
    otm_dir_vega_flow: vegaSign,
    otm_total_vega_flow: 1,
    dir_delta_flow: deltaSign,
    total_delta_flow: 1,
    otm_dir_delta_flow: deltaSign,
    otm_total_delta_flow: 1,
    cum_dir_vega_flow: cumVega,
    cum_total_vega_flow: (i + 1) * 2,
    cum_otm_dir_vega_flow: cumVega,
    cum_otm_total_vega_flow: i + 1,
    cum_dir_delta_flow: cumDelta,
    cum_total_delta_flow: i + 1,
    cum_otm_dir_delta_flow: cumDelta,
    cum_otm_total_delta_flow: i + 1,
  };
}

interface ScenarioOpts {
  spyDelta?: 1 | -1;
  qqqDelta?: 1 | -1;
  spyVega?: 1 | -1;
  qqqVega?: 1 | -1;
}

function happyPathReturn(opts: ScenarioOpts = {}): UseGreekFlowReturn {
  const spyDelta = opts.spyDelta ?? -1;
  const qqqDelta = opts.qqqDelta ?? -1;
  const spyVega = opts.spyVega ?? -1;
  const qqqVega = opts.qqqVega ?? -1;
  const spyRows = Array.from({ length: 5 }, (_, i) =>
    fakeRow('SPY', i, spyDelta, spyVega),
  );
  const qqqRows = Array.from({ length: 5 }, (_, i) =>
    fakeRow('QQQ', i, qqqDelta, qqqVega),
  );
  const data: GreekFlowResponse = {
    date: '2026-04-28',
    tickers: {
      SPY: { rows: spyRows, metrics: emptyMetrics() },
      QQQ: { rows: qqqRows, metrics: emptyMetrics() },
    },
    divergence: divergenceFor(div(spyDelta, qqqDelta), div(spyVega, qqqVega)),
    asOf: '2026-04-28T21:00:00.000Z',
  };
  return { data, loading: false, error: null, refresh: vi.fn() };
}

beforeEach(() => {
  mockUseGreekFlow.mockReset();
});

describe('GreekFlowPanel', () => {
  it('renders the heading', () => {
    mockUseGreekFlow.mockReturnValue(happyPathReturn());
    render(<GreekFlowPanel marketOpen={false} />);
    expect(
      screen.getByRole('heading', { name: /greek flow/i }),
    ).toBeInTheDocument();
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

  it('renders empty state when API returns no date', () => {
    mockUseGreekFlow.mockReturnValue({
      data: {
        date: null,
        tickers: {
          SPY: { rows: [], metrics: emptyMetrics() },
          QQQ: { rows: [], metrics: emptyMetrics() },
        },
        divergence: divergenceFor(NEUTRAL_DIV, NEUTRAL_DIV),
        asOf: '2026-04-28T21:00:00.000Z',
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(<GreekFlowPanel marketOpen={false} />);
    expect(screen.getByText(/no greek flow data/i)).toBeInTheDocument();
  });

  it('renders the 4 OTM Dir Delta + OTM Dir Vega charts for SPY and QQQ', () => {
    mockUseGreekFlow.mockReturnValue(happyPathReturn());
    render(<GreekFlowPanel marketOpen={true} />);
    expect(
      screen.getByLabelText('SPY cumulative OTM Dir Delta'),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('QQQ cumulative OTM Dir Delta'),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('SPY cumulative OTM Dir Vega'),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('QQQ cumulative OTM Dir Vega'),
    ).toBeInTheDocument();
  });

  it('renders the verdict tile and the timeline strip', () => {
    mockUseGreekFlow.mockReturnValue(happyPathReturn());
    render(<GreekFlowPanel marketOpen={true} />);
    expect(screen.getByTestId('greek-flow-verdict')).toBeInTheDocument();
    expect(screen.getByTestId('greek-flow-timeline')).toBeInTheDocument();
  });

  it('shows directional-bear verdict when both deltas are negative', () => {
    mockUseGreekFlow.mockReturnValue(
      happyPathReturn({ spyDelta: -1, qqqDelta: -1, spyVega: -1, qqqVega: -1 }),
    );
    render(<GreekFlowPanel marketOpen={true} />);
    const tile = screen.getByTestId('greek-flow-verdict');
    expect(tile).toHaveAttribute('data-verdict-kind', 'directional-bear');
  });

  it('shows directional-bull verdict when both deltas are positive', () => {
    mockUseGreekFlow.mockReturnValue(
      happyPathReturn({ spyDelta: 1, qqqDelta: 1, spyVega: 1, qqqVega: 1 }),
    );
    render(<GreekFlowPanel marketOpen={true} />);
    const tile = screen.getByTestId('greek-flow-verdict');
    expect(tile).toHaveAttribute('data-verdict-kind', 'directional-bull');
  });

  it('shows pin-harvest verdict when deltas disagree but vegas both short', () => {
    mockUseGreekFlow.mockReturnValue(
      happyPathReturn({ spyDelta: 1, qqqDelta: -1, spyVega: -1, qqqVega: -1 }),
    );
    render(<GreekFlowPanel marketOpen={true} />);
    const tile = screen.getByTestId('greek-flow-verdict');
    expect(tile).toHaveAttribute('data-verdict-kind', 'pin-harvest');
  });
});
