import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnomalyRow } from '../AnomalyRow';
import type { IVAnomalyRow } from '../types';

function makeRow(overrides: Partial<IVAnomalyRow> = {}): IVAnomalyRow {
  return {
    id: 1,
    ticker: 'SPX',
    strike: 7135,
    side: 'put',
    expiry: '2026-04-23',
    spotAtDetect: 7140.5,
    ivAtDetect: 0.225,
    skewDelta: 2.1,
    zScore: 3.21,
    askMidDiv: 0.6,
    flagReasons: ['skew_delta', 'z_score'],
    flowPhase: 'early',
    contextSnapshot: {
      spot_delta_15m: -0.4,
      vix_level: 18.2,
      zero_gamma_distance_pct: -0.35,
    },
    resolutionOutcome: null,
    ts: '2026-04-23T15:30:00Z',
    ...overrides,
  };
}

// Mock the chart so these tests don't hit fetch.
vi.mock('../StrikeIVChart', () => ({
  StrikeIVChart: () => <div data-testid="strike-iv-chart" />,
}));

describe('AnomalyRow', () => {
  beforeEach(() => {
    // The expanded view renders the chart which would otherwise fetch.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ mode: 'history', samples: [] }), {
            status: 200,
          }),
        ),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the collapsed header with strike/side/flags/phase', () => {
    render(<AnomalyRow anomaly={makeRow()} />);
    expect(screen.getByText(/SPX 7135P/)).toBeInTheDocument();
    expect(screen.getByText('skew_delta')).toBeInTheDocument();
    expect(screen.getByText('z_score')).toBeInTheDocument();
    expect(screen.getByText('early')).toBeInTheDocument();
  });

  it('expands on click and shows detailed metrics', async () => {
    const user = userEvent.setup();
    render(<AnomalyRow anomaly={makeRow()} />);
    const toggle = screen.getByRole('button', {
      name: /Toggle details for SPX 7135 put anomaly/,
    });
    await user.click(toggle);
    expect(screen.getByText('spot @ detect')).toBeInTheDocument();
    expect(screen.getByText('Z-score')).toBeInTheDocument();
    expect(screen.getByText('3.21')).toBeInTheDocument();
    expect(screen.getByTestId('strike-iv-chart')).toBeInTheDocument();
  });

  it('formats null metrics as dashes', async () => {
    const user = userEvent.setup();
    render(
      <AnomalyRow
        anomaly={makeRow({ skewDelta: null, zScore: null, askMidDiv: null })}
      />,
    );
    const toggle = screen.getByRole('button', {
      name: /Toggle details for SPX 7135 put anomaly/,
    });
    await user.click(toggle);
    // 3 dashes for the 3 nullable metrics.
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(3);
  });

  it('notes SPX-only dark prints for SPY tickers', async () => {
    const user = userEvent.setup();
    render(
      <AnomalyRow
        anomaly={makeRow({
          ticker: 'SPY',
          strike: 705,
          contextSnapshot: { vix_level: 18 },
        })}
      />,
    );
    await user.click(
      screen.getByRole('button', {
        name: /Toggle details for SPY 705 put anomaly/,
      }),
    );
    // Click the details summary to reveal the context pane.
    await user.click(screen.getByText(/Context snapshot/));
    expect(screen.getByText(/Dark prints omitted/)).toBeInTheDocument();
  });

  it('hides the resolution section when resolutionOutcome is null', async () => {
    const user = userEvent.setup();
    render(<AnomalyRow anomaly={makeRow({ resolutionOutcome: null })} />);
    await user.click(
      screen.getByRole('button', {
        name: /Toggle details for SPX 7135 put anomaly/,
      }),
    );
    expect(screen.queryByLabelText('End-of-day resolution')).toBeNull();
  });

  it('renders the resolution section with outcome, P&L, and catalyst narrative', async () => {
    const user = userEvent.setup();
    render(
      <AnomalyRow
        anomaly={makeRow({
          resolutionOutcome: {
            outcome_class: 'winner_fast',
            notional_1c_pnl: 142.5,
            iv_at_detect: 0.225,
            iv_at_close: 0.265,
            mins_to_peak: 18,
            spot_at_detect: 7140.5,
            spot_min: 7130,
            spot_max: 7145,
            spot_at_close: 7132,
            iv_peak: 0.28,
            catalysts: {
              likely_catalyst: 'NQ led SPX by 2 mins (ρ=0.48)',
              leading_assets: [
                { ticker: 'NQ', correlation: 0.48, lag_mins: 2 },
                { ticker: 'ES', correlation: 0.42, lag_mins: 1 },
                { ticker: 'RTY', correlation: -0.1, lag_mins: 5 },
                { ticker: 'ZN', correlation: 0.05, lag_mins: 3 },
              ],
              large_dark_prints: [],
              range_breaks: [],
              flow_alerts_in_window: [],
            },
          },
        })}
      />,
    );
    await user.click(
      screen.getByRole('button', {
        name: /Toggle details for SPX 7135 put anomaly/,
      }),
    );
    const section = screen.getByLabelText('End-of-day resolution');
    expect(section).toBeInTheDocument();
    expect(section.textContent).toContain('winner_fast');
    expect(section.textContent).toContain('$143'); // rounded 142.5 → 143
    expect(section.textContent).toContain('NQ led SPX by 2 mins');
    // Top-3 leading assets by |correlation|: NQ (0.48), ES (0.42), RTY (-0.1)
    expect(section.textContent).toContain('NQ');
    expect(section.textContent).toContain('ES');
    expect(section.textContent).toContain('RTY');
    // ZN has the smallest |correlation| and should be excluded.
    expect(section.textContent).not.toContain('ZN');
  });
});
