import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SettlementCheck from '../components/SettlementCheck';
import { lightTheme, darkTheme } from '../themes';
import type { HistorySnapshot } from '../hooks/useHistoryData';
import type { HistoryCandle } from '../types/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandle(
  time: string,
  open: number,
  high: number,
  low: number,
  close: number,
): HistoryCandle {
  return { datetime: Date.now(), time, open, high, low, close };
}

function makeCandles(): HistoryCandle[] {
  return [
    makeCandle('09:30', 5800, 5810, 5795, 5805), // 0
    makeCandle('09:35', 5805, 5815, 5800, 5810), // 1
    makeCandle('10:00', 5810, 5820, 5805, 5815), // 2 — entry
    makeCandle('10:05', 5815, 5825, 5808, 5820), // 3
    makeCandle('10:10', 5820, 5830, 5810, 5825), // 4
    makeCandle('15:55', 5825, 5828, 5812, 5818), // 5 — settlement
  ];
}

function makeSnapshot(
  overrides: Partial<HistorySnapshot> = {},
): HistorySnapshot {
  return {
    spot: 5815,
    spy: 581.5,
    runningOHLC: { open: 5800, high: 5820, low: 5795, last: 5815 },
    openingRange: null,
    yesterday: null,
    vix: 18.0,
    vixPrevClose: 17.5,
    vix1d: 14.0,
    vix9d: 16.0,
    vvix: 90.0,
    previousClose: 5790,
    candle: makeCandle('10:00', 5810, 5820, 5805, 5815),
    candleIndex: 2,
    totalCandles: 6,
    ...overrides,
  };
}

function makeAllDeltas(
  overrides: Partial<
    Record<number, { callStrike: number; putStrike: number }>
  > = {},
) {
  const defaults: Record<number, { callStrike: number; putStrike: number }> = {
    5: { callStrike: 5900, putStrike: 5700 },
    8: { callStrike: 5880, putStrike: 5720 },
    10: { callStrike: 5860, putStrike: 5740 },
    12: { callStrike: 5850, putStrike: 5750 },
    15: { callStrike: 5840, putStrike: 5760 },
  };

  const merged = { ...defaults, ...overrides };
  return Object.entries(merged)
    .filter(
      (entry): entry is [string, { callStrike: number; putStrike: number }] =>
        entry[1] != null,
    )
    .map(([delta, strikes]) => ({
      delta: Number(delta),
      ...strikes,
    }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettlementCheck', () => {
  it('renders nothing when no valid deltas match target deltas', () => {
    const { container } = render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={[{ error: 'IV too low' }]}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when entry is the last candle', () => {
    const candles = makeCandles();
    const { container } = render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot({ candleIndex: candles.length - 1 })}
        allCandles={candles}
        allDeltas={makeAllDeltas()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders the Settlement Check heading', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas()}
      />,
    );
    expect(screen.getByText('Settlement Check')).toBeInTheDocument();
  });

  it('shows all survived verdict when all strikes hold', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas()}
      />,
    );
    expect(screen.getByText(/All Survived/)).toBeInTheDocument();
  });

  it('shows entry context in summary', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas()}
        entryTimeLabel="8:45 AM CT"
      />,
    );
    expect(screen.getByText(/Entry at 8:45 AM CT/)).toBeInTheDocument();
    expect(screen.getByText(/SPX at 5815/)).toBeInTheDocument();
    expect(screen.getByText(/settled at 5818/)).toBeInTheDocument();
  });

  it('shows actual SPX range in summary', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas()}
      />,
    );
    // From entry (index 2) onward: high = 5830, low = 5805 → range = 25 pts
    expect(screen.getByText(/25 pts/)).toBeInTheDocument();
    expect(screen.getByText(/5805/)).toBeInTheDocument();
    expect(screen.getByText(/5830/)).toBeInTheDocument();
  });

  it('shows "Safe by X pts" for survived rows', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas()}
      />,
    );
    // 15Δ: call 5840, put 5760
    // callCushion = 5840 - 5830 = 10, putCushion = 5805 - 5760 = 45
    // closer side = call, 10 pts
    expect(screen.getByText(/Safe by 10 pts/)).toBeInTheDocument();
    expect(screen.getAllByText(/nearest: call side/).length).toBeGreaterThan(0);
  });

  it('shows call breach with SPX high when call is breached', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas({
          5: { callStrike: 5825, putStrike: 5700 },
        })}
      />,
    );
    expect(screen.getByText(/Call breached by 5 pts/)).toBeInTheDocument();
    expect(screen.getByText(/SPX hit 5830/)).toBeInTheDocument();
  });

  it('shows put breach with SPX low when put is breached', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas({
          5: { callStrike: 5900, putStrike: 5810 },
        })}
      />,
    );
    expect(screen.getByText(/Put breached by 5 pts/)).toBeInTheDocument();
    expect(screen.getByText(/SPX hit 5805/)).toBeInTheDocument();
  });

  it('shows partial survival verdict', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas({
          5: { callStrike: 5825, putStrike: 5700 },
          8: { callStrike: 5828, putStrike: 5720 },
        })}
      />,
    );
    expect(screen.getByText(/3\/5 Survived/)).toBeInTheDocument();
  });

  it('shows all breached verdict when none survive', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas({
          5: { callStrike: 5825, putStrike: 5810 },
          8: { callStrike: 5825, putStrike: 5810 },
          10: { callStrike: 5825, putStrike: 5810 },
          12: { callStrike: 5825, putStrike: 5810 },
          15: { callStrike: 5825, putStrike: 5810 },
        })}
      />,
    );
    expect(screen.getByText(/All Breached/)).toBeInTheDocument();
  });

  it('only renders rows for deltas in the target list', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={[
          { delta: 20, callStrike: 5900, putStrike: 5700 },
          { delta: 10, callStrike: 5860, putStrike: 5740 },
        ]}
      />,
    );
    expect(screen.getByText('10Δ')).toBeInTheDocument();
    expect(screen.queryByText('20Δ')).not.toBeInTheDocument();
  });

  it('filters out error entries from allDeltas', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={[
          { error: 'IV too low' },
          { delta: 10, callStrike: 5860, putStrike: 5740 },
        ]}
      />,
    );
    expect(screen.getByText('10Δ')).toBeInTheDocument();
    expect(screen.getByText(/All Survived/)).toBeInTheDocument();
  });

  it('shows cushion values below the bar for both sides', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas()}
      />,
    );
    // 15Δ: callCushion = +10, putCushion = +45
    expect(screen.getByText('+10')).toBeInTheDocument();
    expect(screen.getByText('+45')).toBeInTheDocument();
  });

  it('shows legend for the bar visualization', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas()}
      />,
    );
    expect(screen.getByText('Strike corridor')).toBeInTheDocument();
    expect(screen.getByText('Actual SPX range')).toBeInTheDocument();
  });

  it('renders in both themes without crashing', () => {
    const props = {
      snapshot: makeSnapshot(),
      allCandles: makeCandles(),
      allDeltas: makeAllDeltas(),
    };

    const { unmount } = render(<SettlementCheck th={lightTheme} {...props} />);
    expect(screen.getByText('Settlement Check')).toBeInTheDocument();
    unmount();

    render(<SettlementCheck th={darkTheme} {...props} />);
    expect(screen.getByText('Settlement Check')).toBeInTheDocument();
  });
});
