import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ExecutionQuality from '../components/PositionMonitor/ExecutionQuality';
import type {
  ExecutionQuality as ExecQualityT,
  RejectionReason,
  SlippageEntry,
} from '../components/PositionMonitor/types';

// ============================================================
// FACTORIES
// ============================================================

function makeSlippageEntry(
  overrides: Partial<SlippageEntry> = {},
): SlippageEntry {
  return {
    orderTime: '2026-03-29T09:35:00',
    fillTime: '2026-03-29T09:35:01',
    symbol: 'SPXW',
    strike: 5650,
    type: 'PUT',
    spread: 'VERTICAL',
    limitPrice: 0.9,
    fillPrice: 0.88,
    slippage: -0.02,
    contracts: 1,
    ...overrides,
  };
}

function makeRejectionReason(
  overrides: Partial<RejectionReason> = {},
): RejectionReason {
  return {
    reason: 'INSUFFICIENT_BUYING_POWER',
    count: 3,
    ...overrides,
  };
}

function makeExecution(
  overrides: Partial<ExecQualityT> = {},
): ExecQualityT {
  return {
    fills: [makeSlippageEntry()],
    averageSlippage: -0.02,
    totalSlippageDollars: -2,
    fillRate: 0.95,
    rejectedOrders: 1,
    canceledOrders: 2,
    replacementChains: 1,
    rejectionRate: 0.05,
    cancellationRate: 0.1,
    rejectionReasons: [],
    firstTradeTime: '2026-03-29T09:35:00',
    lastTradeTime: '2026-03-29T15:45:00',
    tradingSessionMinutes: 370,
    tradesPerHour: 3.2,
    ...overrides,
  };
}

function renderExec(overrides: Partial<ExecQualityT> = {}) {
  return render(
    <ExecutionQuality execution={makeExecution(overrides)} />,
  );
}

// ============================================================
// TESTS
// ============================================================

describe('ExecutionQuality', () => {
  // ── Region & Test ID ───────────────────────────────────

  it('renders the region with correct aria label', () => {
    renderExec();
    expect(
      screen.getByRole('region', {
        name: 'Execution quality',
      }),
    ).toBeInTheDocument();
  });

  it('renders the data-testid', () => {
    renderExec();
    expect(
      screen.getByTestId('execution-quality'),
    ).toBeInTheDocument();
  });

  // ── Fill Rate Card ─────────────────────────────────────

  it('displays fill rate as percentage', () => {
    renderExec({ fillRate: 0.95 });
    expect(screen.getByText('95.0%')).toBeInTheDocument();
  });

  it('shows fill count and total orders', () => {
    renderExec({
      fills: [makeSlippageEntry(), makeSlippageEntry()],
      fillRate: 0.8,
      rejectedOrders: 0,
      canceledOrders: 0,
      rejectionRate: 0,
    });
    // totalOrders = fills.length + rejected + canceled = 2+0+0 = 2
    expect(screen.getByText('2/2 orders')).toBeInTheDocument();
  });

  it('computes totalOrders from rejectionRate when > 0', () => {
    renderExec({
      fills: [makeSlippageEntry()],
      rejectedOrders: 2,
      rejectionRate: 0.2,
      canceledOrders: 0,
    });
    // totalOrders = Math.round(2 / 0.2) = 10
    expect(screen.getByText('1/10 orders')).toBeInTheDocument();
  });

  it('shows 100% fill rate with perfect fills', () => {
    renderExec({ fillRate: 1 });
    expect(screen.getByText('100.0%')).toBeInTheDocument();
  });

  // ── Rejected Orders Card ───────────────────────────────

  it('displays rejected order count', () => {
    renderExec({ rejectedOrders: 3 });
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows success color when no rejections', () => {
    renderExec({ rejectedOrders: 0 });
    // Find the "Rejected" card's value — 0 with text-success
    const rejectedLabel = screen.getByText('Rejected');
    const card = rejectedLabel.closest(
      '[class*="bg-surface-alt"]',
    );
    const successVal = card?.querySelector('.text-success');
    expect(successVal?.textContent).toBe('0');
  });

  it('shows danger color when rejections exist', () => {
    renderExec({ rejectedOrders: 5 });
    const rejectedLabel = screen.getByText('Rejected');
    const card = rejectedLabel.closest(
      '[class*="bg-surface-alt"]',
    );
    const dangerVal = card?.querySelector('.text-danger');
    expect(dangerVal?.textContent).toBe('5');
  });

  it('shows top rejection reason when present', () => {
    renderExec({
      rejectedOrders: 3,
      rejectionReasons: [
        makeRejectionReason({
          reason: 'BUYING_POWER',
          count: 3,
        }),
      ],
    });
    expect(
      screen.getByText('Top: BUYING_POWER'),
    ).toBeInTheDocument();
  });

  // ── Canceled Orders Card ───────────────────────────────

  it('displays canceled order count', () => {
    renderExec({ canceledOrders: 4 });
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('shows cancellation rate', () => {
    renderExec({ cancellationRate: 0.15 });
    expect(screen.getByText('15.0% rate')).toBeInTheDocument();
  });

  // ── Replacements Card ──────────────────────────────────

  it('displays replacement chains count', () => {
    renderExec({ replacementChains: 7 });
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('shows amendment chains label', () => {
    renderExec();
    expect(
      screen.getByText('amendment chains'),
    ).toBeInTheDocument();
  });

  // ── Rejection Reasons Section ──────────────────────────

  it('does not render rejection reasons section when empty', () => {
    renderExec({ rejectionReasons: [] });
    expect(
      screen.queryByText('Rejection Reasons'),
    ).not.toBeInTheDocument();
  });

  it('renders rejection reasons when present', () => {
    renderExec({
      rejectionReasons: [
        makeRejectionReason({
          reason: 'BUYING_POWER',
          count: 5,
        }),
        makeRejectionReason({
          reason: 'MARGIN_CALL',
          count: 2,
        }),
      ],
    });
    expect(
      screen.getByText('Rejection Reasons'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('BUYING_POWER'),
    ).toBeInTheDocument();
    expect(screen.getByText('MARGIN_CALL')).toBeInTheDocument();
  });

  it('sorts rejection reasons by count descending', () => {
    renderExec({
      rejectionReasons: [
        makeRejectionReason({ reason: 'LOW', count: 1 }),
        makeRejectionReason({ reason: 'HIGH', count: 10 }),
        makeRejectionReason({ reason: 'MID', count: 5 }),
      ],
    });
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items.at(0)?.textContent).toContain('10x');
    expect(items.at(0)?.textContent).toContain('HIGH');
    expect(items.at(1)?.textContent).toContain('5x');
    expect(items.at(1)?.textContent).toContain('MID');
    expect(items.at(2)?.textContent).toContain('1x');
    expect(items.at(2)?.textContent).toContain('LOW');
  });

  it('displays rejection count with x suffix', () => {
    renderExec({
      rejectionReasons: [
        makeRejectionReason({
          reason: 'TEST',
          count: 3,
        }),
      ],
    });
    expect(screen.getByText('3x')).toBeInTheDocument();
  });

  // ── Slippage Section ───────────────────────────────────

  it('shows slippage data when fills exist', () => {
    renderExec({
      fills: [makeSlippageEntry()],
      averageSlippage: -0.05,
      totalSlippageDollars: -5,
    });
    expect(screen.getByText('Avg Slippage')).toBeInTheDocument();
    expect(screen.getByText('Total Cost')).toBeInTheDocument();
  });

  it('shows favorable slippage message for negative avg', () => {
    renderExec({
      fills: [makeSlippageEntry()],
      averageSlippage: -0.03,
    });
    expect(
      screen.getByText('Favorable (you got better prices)'),
    ).toBeInTheDocument();
  });

  it('shows adverse slippage message for positive avg', () => {
    renderExec({
      fills: [makeSlippageEntry()],
      averageSlippage: 0.05,
    });
    expect(
      screen.getByText('Adverse (you got worse prices)'),
    ).toBeInTheDocument();
  });

  it('shows flat slippage message for zero avg', () => {
    renderExec({
      fills: [makeSlippageEntry()],
      averageSlippage: 0,
    });
    expect(
      screen.getByText('Flat (filled at limit)'),
    ).toBeInTheDocument();
  });

  it('formats avg slippage with c suffix', () => {
    renderExec({
      fills: [makeSlippageEntry()],
      averageSlippage: -0.03,
    });
    expect(screen.getByText('-0.03c')).toBeInTheDocument();
  });

  it('applies success color for favorable slippage', () => {
    renderExec({
      fills: [makeSlippageEntry()],
      averageSlippage: -0.05,
    });
    const slipEl = screen.getByText('-0.05c');
    expect(slipEl.className).toContain('text-success');
  });

  it('applies danger color for adverse slippage', () => {
    renderExec({
      fills: [makeSlippageEntry()],
      averageSlippage: 0.05,
    });
    const slipEl = screen.getByText('0.05c');
    expect(slipEl.className).toContain('text-danger');
  });

  it('formats total slippage dollars as currency', () => {
    renderExec({
      fills: [makeSlippageEntry()],
      totalSlippageDollars: -12.5,
    });
    expect(screen.getByText('($12.50)')).toBeInTheDocument();
  });

  it('shows no slippage message when fills are empty', () => {
    renderExec({ fills: [] });
    expect(
      screen.getByText('No slippage data available.'),
    ).toBeInTheDocument();
  });

  // ── Session Timing Section ─────────────────────────────

  it('formats first trade time (strips date, shows HH:MM)', () => {
    renderExec({
      firstTradeTime: '2026-03-29T09:35:00',
    });
    expect(screen.getByText('09:35')).toBeInTheDocument();
  });

  it('formats last trade time', () => {
    renderExec({
      lastTradeTime: '2026-03-29T15:45:00',
    });
    expect(screen.getByText('15:45')).toBeInTheDocument();
  });

  it('shows em dash for null first trade time', () => {
    renderExec({ firstTradeTime: null });
    const firstTrade = screen.getByText('First Trade');
    const statEl = firstTrade.closest('div')?.parentElement;
    expect(statEl?.textContent).toContain('\u2014');
  });

  it('shows em dash for null last trade time', () => {
    renderExec({ lastTradeTime: null });
    const lastTrade = screen.getByText('Last Trade');
    const statEl = lastTrade.closest('div')?.parentElement;
    expect(statEl?.textContent).toContain('\u2014');
  });

  it('shows session duration in minutes', () => {
    renderExec({ tradingSessionMinutes: 370 });
    expect(screen.getByText('370 min')).toBeInTheDocument();
  });

  it('shows em dash for null session duration', () => {
    renderExec({ tradingSessionMinutes: null });
    const sessionLabel = screen.getByText('Session');
    const statEl = sessionLabel.closest('div')?.parentElement;
    expect(statEl?.textContent).toContain('\u2014');
  });

  it('shows trades per hour', () => {
    renderExec({ tradesPerHour: 3.2 });
    expect(screen.getByText('3.2')).toBeInTheDocument();
  });

  it('shows em dash for null trades per hour', () => {
    renderExec({ tradesPerHour: null });
    const tphLabel = screen.getByText('Trades/Hour');
    const statEl = tphLabel.closest('div')?.parentElement;
    expect(statEl?.textContent).toContain('\u2014');
  });

  // ── Time formatting edge cases ─────────────────────────

  it('handles time string without T separator', () => {
    renderExec({ firstTradeTime: '09:35:22' });
    expect(screen.getByText('09:35')).toBeInTheDocument();
  });

  // ── All Card Labels ────────────────────────────────────

  it('renders all top-row card labels', () => {
    renderExec();
    expect(screen.getByText('Fill Rate')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText('Canceled')).toBeInTheDocument();
    expect(
      screen.getByText('Replacements'),
    ).toBeInTheDocument();
  });

  it('renders slippage and session timing labels', () => {
    renderExec();
    expect(screen.getByText('Slippage')).toBeInTheDocument();
    expect(
      screen.getByText('Session Timing'),
    ).toBeInTheDocument();
    expect(screen.getByText('First Trade')).toBeInTheDocument();
    expect(screen.getByText('Last Trade')).toBeInTheDocument();
    expect(screen.getByText('Session')).toBeInTheDocument();
    expect(
      screen.getByText('Trades/Hour'),
    ).toBeInTheDocument();
  });
});
