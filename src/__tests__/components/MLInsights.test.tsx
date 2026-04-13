import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import type { MLInsightsState, MLPlot } from '../../hooks/useMLInsights';

// ============================================================
// MOCKS
// ============================================================

const mockRefetch = vi.fn();

const defaultState: MLInsightsState = {
  plots: [],
  findings: null,
  pipelineDate: null,
  loading: false,
  error: null,
  refetch: mockRefetch,
};

let hookReturn: MLInsightsState = { ...defaultState };

vi.mock('../../hooks/useMLInsights', () => ({
  useMLInsights: () => hookReturn,
}));

// Must import AFTER vi.mock
const { default: MLInsights } =
  await import('../../components/MLInsights');

// ============================================================
// HELPERS
// ============================================================

function makePlot(overrides: Partial<MLPlot> = {}): MLPlot {
  return {
    name: 'timeline',
    imageUrl: '/plots/timeline.png',
    analysis: {
      what_it_means: 'Shows trend over time',
      how_to_apply: 'Use for timing entries',
      watch_out_for: 'Regime changes',
    },
    model: 'claude-sonnet-4-20250514',
    pipelineDate: '2026-04-03',
    updatedAt: '2026-04-03T06:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  hookReturn = { ...defaultState };
  mockRefetch.mockReset();
});

// ============================================================
// RENDERING
// ============================================================

describe('MLInsights: rendering', () => {
  it('renders the section with label', () => {
    render(<MLInsights />);
    expect(
      screen.getByRole('region', { name: /ml insights/i }),
    ).toBeInTheDocument();
  });

  it('renders the refresh button', () => {
    render(<MLInsights />);
    expect(
      screen.getByRole('button', { name: /refresh ml insights/i }),
    ).toBeInTheDocument();
  });

  it('shows badge with pipeline date when available', () => {
    hookReturn = {
      ...defaultState,
      pipelineDate: '2026-04-03',
      plots: [makePlot()],
    };
    render(<MLInsights />);
    const matches = screen.getAllByText('2026-04-03');
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// LOADING STATE
// ============================================================

describe('MLInsights: loading state', () => {
  it('shows loading skeleton when loading with no plots', () => {
    hookReturn = { ...defaultState, loading: true, plots: [] };
    render(<MLInsights />);
    expect(
      screen.getByRole('region', { name: /ml insights/i }),
    ).toBeInTheDocument();
    // The skeleton has aria-busy
    const busyEl = document.querySelector('[aria-busy="true"]');
    expect(busyEl).toBeInTheDocument();
  });

  it('shows "Loading..." on refresh button when loading', () => {
    hookReturn = { ...defaultState, loading: true };
    render(<MLInsights />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('does not show skeleton when loading but plots exist', () => {
    hookReturn = {
      ...defaultState,
      loading: true,
      plots: [makePlot()],
    };
    render(<MLInsights />);
    const busyEl = document.querySelector('[aria-busy="true"]');
    expect(busyEl).not.toBeInTheDocument();
  });
});

// ============================================================
// ERROR STATE
// ============================================================

describe('MLInsights: error state', () => {
  it('displays error message', () => {
    hookReturn = {
      ...defaultState,
      error: 'Failed to fetch ML plots (HTTP 500)',
    };
    render(<MLInsights />);
    expect(
      screen.getByText('Failed to fetch ML plots (HTTP 500)'),
    ).toBeInTheDocument();
  });
});

// ============================================================
// EMPTY STATE
// ============================================================

describe('MLInsights: empty state', () => {
  it('shows empty message when no plots and not loading', () => {
    hookReturn = { ...defaultState, loading: false, plots: [] };
    render(<MLInsights />);
    expect(screen.getByText('Pipeline has not run yet')).toBeInTheDocument();
    expect(
      screen.getByText(/ml plots and analyses will appear/i),
    ).toBeInTheDocument();
  });

  it('does not show empty state when loading', () => {
    hookReturn = { ...defaultState, loading: true, plots: [] };
    render(<MLInsights />);
    expect(
      screen.queryByText('Pipeline has not run yet'),
    ).not.toBeInTheDocument();
  });

  it('does not show empty state when error present', () => {
    hookReturn = {
      ...defaultState,
      error: 'Some error',
      plots: [],
    };
    render(<MLInsights />);
    expect(
      screen.queryByText('Pipeline has not run yet'),
    ).not.toBeInTheDocument();
  });
});

// ============================================================
// CONTENT STATE (plots available)
// ============================================================

describe('MLInsights: content', () => {
  it('renders FindingsSummary when plots are available', () => {
    hookReturn = {
      ...defaultState,
      plots: [makePlot()],
      findings: {
        dataset: { total_days: 120, labeled_days: 95 },
        eda: { overall_accuracy: 0.72 },
        health: { status: 'healthy' },
      },
      pipelineDate: '2026-04-03',
    };
    render(<MLInsights />);
    // FindingsSummary renders "Pipeline Date" label
    expect(screen.getByText('Pipeline Date')).toBeInTheDocument();
    // And Accuracy
    expect(screen.getByText('Accuracy')).toBeInTheDocument();
  });

  it('renders PlotCarousel when plots are available', () => {
    hookReturn = {
      ...defaultState,
      plots: [makePlot()],
    };
    render(<MLInsights />);
    // PlotCarousel renders the section with aria-label
    expect(
      screen.getByRole('toolbar', { name: /ml plot carousel/i }),
    ).toBeInTheDocument();
  });

  it('counts analyzed plots correctly', () => {
    hookReturn = {
      ...defaultState,
      plots: [
        makePlot({
          name: 'timeline',
          analysis: {
            what_it_means: 'a',
            how_to_apply: 'b',
            watch_out_for: 'c',
          },
        }),
        makePlot({ name: 'correlations', analysis: null }),
        makePlot({
          name: 'stationarity',
          analysis: {
            what_it_means: 'x',
            how_to_apply: 'y',
            watch_out_for: 'z',
          },
        }),
      ],
    };
    render(<MLInsights />);
    // FindingsSummary shows "2/3 analyzed"
    expect(screen.getByText('2/3 analyzed')).toBeInTheDocument();
  });
});

// ============================================================
// INTERACTIONS
// ============================================================

describe('MLInsights: interactions', () => {
  it('calls refetch when refresh button clicked', () => {
    render(<MLInsights />);
    fireEvent.click(
      screen.getByRole('button', { name: /refresh ml insights/i }),
    );
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('disables refresh button when loading', () => {
    hookReturn = { ...defaultState, loading: true };
    render(<MLInsights />);
    const btn = screen.getByRole('button', {
      name: /refresh ml insights/i,
    });
    expect(btn).toBeDisabled();
  });

  it('enables refresh button when not loading', () => {
    hookReturn = { ...defaultState, loading: false };
    render(<MLInsights />);
    const btn = screen.getByRole('button', {
      name: /refresh ml insights/i,
    });
    expect(btn).not.toBeDisabled();
  });
});

// ============================================================
// ANALYZE BUTTON — triggerAnalyze flow (lines 27-34, 46)
// ============================================================

describe('MLInsights: analyze button', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('renders the analyze button in idle state', () => {
    render(<MLInsights />);
    expect(
      screen.getByRole('button', { name: /run claude plot analysis/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /run claude plot analysis/i }),
    ).toHaveTextContent('Analyze');
  });

  it('analyze button is enabled in idle state', () => {
    render(<MLInsights />);
    expect(
      screen.getByRole('button', { name: /run claude plot analysis/i }),
    ).not.toBeDisabled();
  });

  it('shows "Starting..." while fetch is in flight', async () => {
    // Never-resolving promise keeps the button in 'running' state
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    render(<MLInsights />);

    fireEvent.click(
      screen.getByRole('button', { name: /run claude plot analysis/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /run claude plot analysis/i }),
      ).toHaveTextContent('Starting...');
    });
  });

  it('disables analyze button while running', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    render(<MLInsights />);

    fireEvent.click(
      screen.getByRole('button', { name: /run claude plot analysis/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /run claude plot analysis/i }),
      ).toBeDisabled();
    });
  });

  it('shows "Started ✓" when fetch resolves with ok:true', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    render(<MLInsights />);

    fireEvent.click(
      screen.getByRole('button', { name: /run claude plot analysis/i }),
    );

    // Flush the promise microtask queue without advancing fake timers.
    // act(async () => {}) yields to the microtask queue, letting the
    // awaited fetch() inside triggerAnalyze() resolve and call setState.
    await act(async () => {});

    expect(
      screen.getByRole('button', { name: /run claude plot analysis/i }),
    ).toHaveTextContent('Started ✓');
  });

  it('shows "Failed" when fetch resolves with ok:false', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    render(<MLInsights />);

    fireEvent.click(
      screen.getByRole('button', { name: /run claude plot analysis/i }),
    );
    await act(async () => {});

    expect(
      screen.getByRole('button', { name: /run claude plot analysis/i }),
    ).toHaveTextContent('Failed');
  });

  it('shows "Failed" when fetch throws a network error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network error')),
    );
    render(<MLInsights />);

    fireEvent.click(
      screen.getByRole('button', { name: /run claude plot analysis/i }),
    );
    await act(async () => {});

    expect(
      screen.getByRole('button', { name: /run claude plot analysis/i }),
    ).toHaveTextContent('Failed');
  });

  it('resets to "Analyze" after 3 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    render(<MLInsights />);

    // Click and flush promise microtasks so fetch resolves → 'done'
    fireEvent.click(
      screen.getByRole('button', { name: /run claude plot analysis/i }),
    );
    await act(async () => {});

    expect(
      screen.getByRole('button', { name: /run claude plot analysis/i }),
    ).toHaveTextContent('Started ✓');

    // Advance past the 3-second reset setTimeout
    await act(async () => {
      vi.advanceTimersByTime(3001);
    });

    expect(
      screen.getByRole('button', { name: /run claude plot analysis/i }),
    ).toHaveTextContent('Analyze');
  });

  it('POSTs to /api/ml/trigger-analyze', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    render(<MLInsights />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /run claude plot analysis/i }),
      );
    });

    expect(fetchSpy).toHaveBeenCalledWith('/api/ml/trigger-analyze', {
      method: 'POST',
    });
  });
});
