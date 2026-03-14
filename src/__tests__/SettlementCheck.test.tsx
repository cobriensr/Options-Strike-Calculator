import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
    Record<
      number,
      {
        callStrike: number;
        putStrike: number;
        callSnapped?: number;
        putSnapped?: number;
      }
    >
  > = {},
) {
  const defaults: Record<
    number,
    {
      callStrike: number;
      putStrike: number;
      callSnapped: number;
      putSnapped: number;
    }
  > = {
    5: {
      callStrike: 5902,
      putStrike: 5703,
      callSnapped: 5900,
      putSnapped: 5705,
    },
    8: {
      callStrike: 5881,
      putStrike: 5722,
      callSnapped: 5880,
      putSnapped: 5720,
    },
    10: {
      callStrike: 5863,
      putStrike: 5741,
      callSnapped: 5865,
      putSnapped: 5740,
    },
    12: {
      callStrike: 5848,
      putStrike: 5752,
      callSnapped: 5850,
      putSnapped: 5750,
    },
    15: {
      callStrike: 5839,
      putStrike: 5762,
      callSnapped: 5840,
      putSnapped: 5760,
    },
  };

  const merged = { ...defaults, ...overrides };
  return Object.entries(merged)
    .filter(
      (
        entry,
      ): entry is [
        string,
        {
          callStrike: number;
          putStrike: number;
          callSnapped?: number;
          putSnapped?: number;
        },
      ] => entry[1] != null,
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
    expect(screen.getByText(/All survived/)).toBeInTheDocument();
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
    expect(screen.getByText(/ranged\s+25\s+pts/)).toBeInTheDocument();
    expect(screen.getByText(/5805\s+–\s+5830/)).toBeInTheDocument();
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
    expect(
      screen.getAllByText(/nearest: call side/).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('shows call breach with settled-at text when call is breached and settlement outside strikes', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas({
          5: {
            callStrike: 5810,
            putStrike: 5700,
            callSnapped: 5810,
            putSnapped: 5700,
          },
        })}
      />,
    );
    // callSnapped=5810, remainingHigh=5830, callCushion=-20, settlement=5818 > 5810 → loss
    expect(screen.getByText(/Call breached by 20 pts/)).toBeInTheDocument();
    expect(
      screen.getAllByText(/settled at 5818/).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('shows put breach with settled-at text when put is breached and settlement outside strikes', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas({
          5: {
            callStrike: 5900,
            putStrike: 5820,
            callSnapped: 5900,
            putSnapped: 5820,
          },
        })}
      />,
    );
    // putSnapped=5820, remainingLow=5805, putCushion=-15, settlement=5818 < 5820 → loss
    expect(screen.getByText(/Put breached by 15 pts/)).toBeInTheDocument();
    expect(
      screen.getAllByText(/settled at 5818/).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('shows partial survival verdict', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas({
          5: {
            callStrike: 5810,
            putStrike: 5700,
            callSnapped: 5810,
            putSnapped: 5700,
          },
          8: {
            callStrike: 5815,
            putStrike: 5720,
            callSnapped: 5815,
            putSnapped: 5720,
          },
        })}
      />,
    );
    // 5Δ callSnapped=5810, settlement=5818 > 5810 → loss (not settledSafe)
    // 8Δ callSnapped=5815, settlement=5818 > 5815 → loss (not settledSafe)
    // 10,12,15Δ → settledSafe
    // settledSafeCount=3, settledLossCount=2
    expect(
      screen.getByText(/3\/5 max profit at settlement/),
    ).toBeInTheDocument();
  });

  it('shows all settled beyond strikes verdict when none settle safe', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas({
          5: {
            callStrike: 5815,
            putStrike: 5700,
            callSnapped: 5815,
            putSnapped: 5700,
          },
          8: {
            callStrike: 5815,
            putStrike: 5700,
            callSnapped: 5815,
            putSnapped: 5700,
          },
          10: {
            callStrike: 5815,
            putStrike: 5700,
            callSnapped: 5815,
            putSnapped: 5700,
          },
          12: {
            callStrike: 5815,
            putStrike: 5700,
            callSnapped: 5815,
            putSnapped: 5700,
          },
          15: {
            callStrike: 5815,
            putStrike: 5700,
            callSnapped: 5815,
            putSnapped: 5700,
          },
        })}
      />,
    );
    // callSnapped=5815, settlement=5818 > 5815 → all settledSafe=false
    expect(screen.getByText(/All settled beyond strikes/)).toBeInTheDocument();
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
    expect(screen.getByText(/All survived/)).toBeInTheDocument();
  });

  it('shows directional cushion values: negative on put side, positive on call side', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas()}
      />,
    );
    // 15Δ: callCushion = 5840 - 5830 = +10, putCushion = 5805 - 5760 = +45
    // Display: put side = −45, call side = +10
    expect(screen.getByText('+10')).toBeInTheDocument();
    const negatives = screen.getAllByText(/\u221245/);
    expect(negatives.length).toBeGreaterThanOrEqual(1);
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
    expect(screen.getByText(/Comfortable/)).toBeInTheDocument();
    expect(screen.getByText(/Close call/)).toBeInTheDocument();
  });

  it('shows green verdict when all survived with comfortable cushions', () => {
    // Need all strikes with min cushion >= 50 pts
    // From entry (index 2): high = 5830, low = 5805
    // So callSnapped >= 5880 and putSnapped <= 5755
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas({
          5: {
            callStrike: 5920,
            putStrike: 5680,
            callSnapped: 5920,
            putSnapped: 5680,
          },
          8: {
            callStrike: 5900,
            putStrike: 5700,
            callSnapped: 5900,
            putSnapped: 5700,
          },
          10: {
            callStrike: 5890,
            putStrike: 5710,
            callSnapped: 5890,
            putSnapped: 5710,
          },
          12: {
            callStrike: 5885,
            putStrike: 5720,
            callSnapped: 5885,
            putSnapped: 5720,
          },
          15: {
            callStrike: 5880,
            putStrike: 5730,
            callSnapped: 5880,
            putSnapped: 5730,
          },
        })}
      />,
    );
    // All survived with min cushion >= 50 → green verdict "✅ All Survived"
    expect(screen.getByText(/All Survived/)).toBeInTheDocument();
  });

  it('shows breached intraday all settled safe verdict', () => {
    // Some strikes breached intraday (high=5830 or low=5805) but settlement=5818 is between all strikes
    // All must settle safe but not all survive
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas({
          5: {
            callStrike: 5900,
            putStrike: 5700,
            callSnapped: 5900,
            putSnapped: 5700,
          },
          8: {
            callStrike: 5900,
            putStrike: 5700,
            callSnapped: 5900,
            putSnapped: 5700,
          },
          10: {
            callStrike: 5900,
            putStrike: 5700,
            callSnapped: 5900,
            putSnapped: 5700,
          },
          // 12Δ: callSnapped=5828, high=5830 → breached, but settlement=5818 < 5828 → settledSafe
          12: {
            callStrike: 5828,
            putStrike: 5700,
            callSnapped: 5828,
            putSnapped: 5700,
          },
          // 15Δ: callSnapped=5825, high=5830 → breached, but settlement=5818 < 5825 → settledSafe
          15: {
            callStrike: 5825,
            putStrike: 5700,
            callSnapped: 5825,
            putSnapped: 5700,
          },
        })}
      />,
    );
    expect(
      screen.getByText(/breached intraday, all settled safe/),
    ).toBeInTheDocument();
    // DeltaRow for breached-but-safe should show "Breached intraday, settled safe"
    expect(
      screen.getAllByText(/Breached intraday, settled safe/).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('shows tooltip on bar hover and hides on mouse leave', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas()}
      />,
    );
    // The bar buttons have no accessible name, find them by role
    const barButtons = screen.getAllByRole('button');
    const barButton = barButtons[0]!;

    // Tooltip not shown initially
    expect(screen.queryByText(/^Low:/)).not.toBeInTheDocument();

    // Show tooltip on mouse enter
    fireEvent.mouseEnter(barButton);
    expect(screen.getByText(/^Low:/)).toBeInTheDocument();
    expect(screen.getByText(/^High:/)).toBeInTheDocument();
    expect(screen.getByText(/^Range:/)).toBeInTheDocument();

    // Hide tooltip on mouse leave
    fireEvent.mouseLeave(barButton);
    expect(screen.queryByText(/^Low:/)).not.toBeInTheDocument();
  });

  it('shows tooltip on focus and hides on blur', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas()}
      />,
    );
    const barButtons = screen.getAllByRole('button');
    const barButton = barButtons[0]!;

    fireEvent.focus(barButton);
    expect(screen.getByText(/^Low:/)).toBeInTheDocument();

    fireEvent.blur(barButton);
    expect(screen.queryByText(/^Low:/)).not.toBeInTheDocument();
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
