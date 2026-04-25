import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnomalyRow } from '../AnomalyRow';
import {
  anomalyCompoundKey,
  type ActiveAnomaly,
  type IVAnomalyRow,
} from '../types';

function makeRow(overrides: Partial<IVAnomalyRow> = {}): IVAnomalyRow {
  return {
    id: 1,
    ticker: 'SPXW',
    strike: 7135,
    side: 'put',
    expiry: '2026-04-23',
    spotAtDetect: 7140.5,
    ivAtDetect: 0.225,
    skewDelta: 2.1,
    zScore: 3.21,
    askMidDiv: 0.6,
    volOiRatio: 48.5,
    sideSkew: 0.78,
    sideDominant: 'ask',
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

function makeActive(
  rowOverrides: Partial<IVAnomalyRow> = {},
  aggOverrides: Partial<ActiveAnomaly> = {},
): ActiveAnomaly {
  const latest = makeRow(rowOverrides);
  const base: ActiveAnomaly = {
    compoundKey: anomalyCompoundKey(latest),
    ticker:
      latest.ticker === 'SPY' || latest.ticker === 'QQQ'
        ? latest.ticker
        : 'SPXW',
    strike: latest.strike,
    side: latest.side,
    expiry: latest.expiry,
    latest,
    firstSeenTs: latest.ts,
    lastFiredTs: latest.ts,
    firingCount: 1,
    phase: 'active',
    exitReason: null,
    entryIv: latest.ivAtDetect,
    peakIv: latest.ivAtDetect,
    peakTs: latest.ts,
    entryAskMidDiv: latest.askMidDiv,
    askMidPeakTs: null,
    ivHistory: [{ ts: latest.ts, ivMid: latest.ivAtDetect }],
    firingHistory: [{ ts: latest.ts, firingCount: 1 }],
    tapeVolumeHistory: [],
    accumulatedAskSideVol: 0,
    accumulatedBidSideVol: 0,
  };
  return { ...base, ...aggOverrides };
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
    vi.useRealTimers();
  });

  it('renders the collapsed header with strike/side/flags/phase', () => {
    render(<AnomalyRow anomaly={makeActive()} />);
    expect(screen.getByText(/SPXW 7135P/)).toBeInTheDocument();
    expect(screen.getByText('skew_delta')).toBeInTheDocument();
    expect(screen.getByText('z_score')).toBeInTheDocument();
    expect(screen.getByText('early')).toBeInTheDocument();
  });

  it('expands on click and shows detailed metrics from the latest row', async () => {
    const user = userEvent.setup();
    render(<AnomalyRow anomaly={makeActive()} />);
    const toggle = screen.getByRole('button', {
      name: /Toggle details for SPXW 7135 put anomaly/,
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
        anomaly={makeActive({
          skewDelta: null,
          zScore: null,
          askMidDiv: null,
        })}
      />,
    );
    const toggle = screen.getByRole('button', {
      name: /Toggle details for SPXW 7135 put anomaly/,
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
        anomaly={makeActive({
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
    await user.click(screen.getByText(/Context snapshot/));
    expect(screen.getByText(/Dark prints omitted/)).toBeInTheDocument();
  });

  it('hides the resolution section when resolutionOutcome is null', async () => {
    const user = userEvent.setup();
    render(<AnomalyRow anomaly={makeActive({ resolutionOutcome: null })} />);
    await user.click(
      screen.getByRole('button', {
        name: /Toggle details for SPXW 7135 put anomaly/,
      }),
    );
    expect(screen.queryByLabelText('End-of-day resolution')).toBeNull();
  });

  it('renders the resolution section with outcome, P&L, and catalyst narrative', async () => {
    const user = userEvent.setup();
    render(
      <AnomalyRow
        anomaly={makeActive({
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
        name: /Toggle details for SPXW 7135 put anomaly/,
      }),
    );
    const section = screen.getByLabelText('End-of-day resolution');
    expect(section).toBeInTheDocument();
    expect(section.textContent).toContain('winner_fast');
    expect(section.textContent).toContain('$143'); // rounded 142.5 → 143
    expect(section.textContent).toContain('NQ led SPX by 2 mins');
    expect(section.textContent).toContain('NQ');
    expect(section.textContent).toContain('ES');
    expect(section.textContent).toContain('RTY');
    expect(section.textContent).not.toContain('ZN');
  });

  // ─── Aggregation telemetry (duration / freshness / firing count) ───

  it('shows "active 42m" when the span is between 1 min and 1 hour', () => {
    // Pin wall clock; firstSeenTs is 42 min before.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T16:12:00Z'));
    render(
      <AnomalyRow
        anomaly={makeActive(
          { ts: '2026-04-23T16:11:00Z' },
          {
            firstSeenTs: '2026-04-23T15:30:00Z',
            lastFiredTs: '2026-04-23T16:11:00Z',
            firingCount: 38,
          },
        )}
      />,
    );
    expect(screen.getByText(/active 42m/)).toBeInTheDocument();
  });

  it('shows "active 2h 15m" when the span exceeds one hour', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T17:45:30Z'));
    render(
      <AnomalyRow
        anomaly={makeActive(
          { ts: '2026-04-23T17:45:00Z' },
          {
            firstSeenTs: '2026-04-23T15:30:00Z',
            lastFiredTs: '2026-04-23T17:45:00Z',
            firingCount: 120,
          },
        )}
      />,
    );
    expect(screen.getByText(/active 2h 15m/)).toBeInTheDocument();
  });

  it('shows "last fire 2m ago" when the last firing was >=1m but <60m ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T15:32:00Z'));
    render(
      <AnomalyRow
        anomaly={makeActive(
          { ts: '2026-04-23T15:30:00Z' },
          {
            firstSeenTs: '2026-04-23T15:28:00Z',
            lastFiredTs: '2026-04-23T15:30:00Z',
            firingCount: 3,
          },
        )}
      />,
    );
    expect(screen.getByText(/last fire 2m ago/)).toBeInTheDocument();
  });

  it('shows "last fire just now" when the last firing was <60s ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T15:30:15Z'));
    render(
      <AnomalyRow
        anomaly={makeActive(
          { ts: '2026-04-23T15:30:00Z' },
          {
            firstSeenTs: '2026-04-23T15:29:00Z',
            lastFiredTs: '2026-04-23T15:30:00Z',
            firingCount: 2,
          },
        )}
      />,
    );
    expect(screen.getByText(/last fire just now/)).toBeInTheDocument();
  });

  it('displays the firing count label', () => {
    render(
      <AnomalyRow
        anomaly={makeActive(
          {},
          {
            firingCount: 38,
          },
        )}
      />,
    );
    expect(screen.getByText(/firings: 38/)).toBeInTheDocument();
  });

  // ─── Exit phase pill + subtitle ───

  it('renders the `active` phase pill by default', () => {
    render(<AnomalyRow anomaly={makeActive()} />);
    expect(screen.getByTestId('anomaly-phase-active')).toBeInTheDocument();
  });

  it('renders the `cooling` phase pill and an IV-regression subtitle', () => {
    render(
      <AnomalyRow
        anomaly={makeActive(
          { ivAtDetect: 0.27 },
          {
            phase: 'cooling',
            exitReason: 'iv_regression',
            entryIv: 0.22,
            peakIv: 0.3,
            peakTs: '2026-04-23T15:29:00Z',
          },
        )}
      />,
    );
    expect(screen.getByTestId('anomaly-phase-cooling')).toBeInTheDocument();
    // Drop of (0.30 - 0.27) / (0.30 - 0.22) ≈ 37.5% — floating-point
    // error rounds down to 37 ((0.029999…/0.079999…)*100 = 37.499…).
    expect(
      screen.getByText(/IV down 37% from peak \(30\.0vp → 27\.0vp\)/),
    ).toBeInTheDocument();
  });

  it('renders the `distributing` phase pill + subtitle', () => {
    render(
      <AnomalyRow
        anomaly={makeActive(
          {},
          {
            phase: 'distributing',
            exitReason: 'bid_side_surge',
          },
        )}
      />,
    );
    expect(
      screen.getByTestId('anomaly-phase-distributing'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Bid-side volume surge|Bid-side surge/),
    ).toBeInTheDocument();
  });

  // ─── Pattern pill (Phase D4 — flash / medium / persistent) ───

  it('renders the `flash` pattern pill when duration <5min and firingCount <3', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T15:32:00Z'));
    render(
      <AnomalyRow
        anomaly={makeActive(
          { ts: '2026-04-23T15:32:00Z' },
          {
            firstSeenTs: '2026-04-23T15:30:00Z',
            lastFiredTs: '2026-04-23T15:32:00Z',
            firingCount: 2,
          },
        )}
      />,
    );
    expect(screen.getByTestId('anomaly-pattern-flash')).toBeInTheDocument();
  });

  it('renders the `persistent` pattern pill when firingCount >=20', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T15:35:00Z'));
    render(
      <AnomalyRow
        anomaly={makeActive(
          { ts: '2026-04-23T15:34:00Z' },
          {
            firstSeenTs: '2026-04-23T15:30:00Z',
            lastFiredTs: '2026-04-23T15:34:00Z',
            firingCount: 25,
          },
        )}
      />,
    );
    expect(
      screen.getByTestId('anomaly-pattern-persistent'),
    ).toBeInTheDocument();
  });

  it('renders the `persistent` pattern pill when duration >=60min', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T17:30:00Z'));
    render(
      <AnomalyRow
        anomaly={makeActive(
          { ts: '2026-04-23T17:30:00Z' },
          {
            firstSeenTs: '2026-04-23T16:00:00Z',
            lastFiredTs: '2026-04-23T17:30:00Z',
            firingCount: 5,
          },
        )}
      />,
    );
    expect(
      screen.getByTestId('anomaly-pattern-persistent'),
    ).toBeInTheDocument();
  });

  it('renders the `medium` pattern pill in the default range', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T15:45:00Z'));
    render(
      <AnomalyRow
        anomaly={makeActive(
          { ts: '2026-04-23T15:45:00Z' },
          {
            firstSeenTs: '2026-04-23T15:30:00Z',
            lastFiredTs: '2026-04-23T15:45:00Z',
            firingCount: 8,
          },
        )}
      />,
    );
    expect(screen.getByTestId('anomaly-pattern-medium')).toBeInTheDocument();
  });

  it('renders the ask-mid compression subtitle when cooling for that reason', () => {
    render(
      <AnomalyRow
        anomaly={makeActive(
          {},
          {
            phase: 'cooling',
            exitReason: 'ask_mid_compression',
          },
        )}
      />,
    );
    expect(screen.getByText(/Ask-mid spread compressing/)).toBeInTheDocument();
  });
});
