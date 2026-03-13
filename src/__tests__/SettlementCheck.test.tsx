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

/** A small day of candles: entry candle + a few after */
function makeCandles(): HistoryCandle[] {
  return [
    makeCandle('09:30', 5800, 5810, 5795, 5805), // 0 — before entry
    makeCandle('09:35', 5805, 5815, 5800, 5810), // 1 — before entry
    makeCandle('10:00', 5810, 5820, 5805, 5815), // 2 — entry candle
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
    candleIndex: 2, // entry at index 2
    totalCandles: 6,
    ...overrides,
  };
}

/** Creates allDeltas with valid entries for the target deltas */
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

/** Extract delta numbers from delta-label spans (e.g. "5\u0394" → "5") */
function getDeltaLabels(container: HTMLElement): string[] {
  const spans = container.querySelectorAll('span');
  return Array.from(spans)
    .map((el) => el.textContent?.trim() ?? '')
    .filter((t) => t.endsWith(String.raw`\u0394`))
    .map((t) => t.replace(String.raw`\u0394`, ''));
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

  it('shows survived count in summary bar', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas()}
      />,
    );
    // All strikes are wide enough (5900C/5700P etc.) that the day high/low
    // (5830/5805 from entry onward) won't breach them → all survive
    expect(screen.getByText(/5\/5 SURVIVED/)).toBeInTheDocument();
  });

  it('shows entry time and settlement price in summary', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas()}
      />,
    );
    // Entry time is 10:00, settlement is last candle close = 5818
    expect(screen.getByText(/Entry 10:00/)).toBeInTheDocument();
    expect(screen.getByText(/Settlement 5818/)).toBeInTheDocument();
  });

  it('shows remaining high and low', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas()}
      />,
    );
    // From index 2 onward: high = 5830 (candle 4), low = 5805 (candle 2)
    expect(screen.getByText(/H 5830/)).toBeInTheDocument();
    expect(screen.getByText(/L 5805/)).toBeInTheDocument();
  });

  it('renders a row for each matched delta', () => {
    const { container } = render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas()}
      />,
    );
    const labels = getDeltaLabels(container);
    expect(labels).toEqual(['5', '8', '10', '12', '15']);
  });

  it('shows strike labels on each row', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas()}
      />,
    );
    // 5-delta strikes: 5700P / 5900C
    expect(screen.getByText('5700P')).toBeInTheDocument();
    expect(screen.getByText('5900C')).toBeInTheDocument();
  });

  it('shows positive cushion for survived strikes', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas()}
      />,
    );
    // 15-delta: call 5840, put 5760
    // callCushion = 5840 - 5830 = 10, putCushion = 5805 - 5760 = 45
    // min cushion = 10 → "+10 pts"
    expect(screen.getByText('+10 pts')).toBeInTheDocument();
  });

  it('detects call breach correctly', () => {
    // Tight call strike that gets breached
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
    // 5830 high >= 5825 call → breached by 5 pts
    expect(screen.getByText('C −5')).toBeInTheDocument();
  });

  it('detects put breach correctly', () => {
    // Tight put strike that gets breached
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
    // 5805 low <= 5810 put → breached by 5 pts
    expect(screen.getByText('P −5')).toBeInTheDocument();
  });

  it('shows partial survival count when some breached', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas({
          // Breach the 5-delta and 8-delta call strikes
          5: { callStrike: 5825, putStrike: 5700 },
          8: { callStrike: 5828, putStrike: 5720 },
        })}
      />,
    );
    expect(screen.getByText(/3\/5 SURVIVED/)).toBeInTheDocument();
  });

  it('only renders rows for deltas in the target list', () => {
    // Provide a delta=20 which is not in targetDeltas [5,8,10,12,15]
    const { container } = render(
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
    const labels = getDeltaLabels(container);
    expect(labels).toEqual(['10']);
  });

  it('filters out error entries from allDeltas', () => {
    const { container } = render(
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
    const labels = getDeltaLabels(container);
    expect(labels).toEqual(['10']);
    expect(screen.getByText(/1\/1 SURVIVED/)).toBeInTheDocument();
  });

  it('shows the footnote with entry time', () => {
    render(
      <SettlementCheck
        th={lightTheme}
        snapshot={makeSnapshot()}
        allCandles={makeCandles()}
        allDeltas={makeAllDeltas()}
      />,
    );
    expect(
      screen.getByText(/from 10:00 through settlement/),
    ).toBeInTheDocument();
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
