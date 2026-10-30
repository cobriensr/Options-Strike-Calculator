import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { DexoflowVelocityTape } from '../components/Gexbot/DexoflowVelocityTape';
import {
  isUnusual,
  orderVelocityRows,
} from '../components/Gexbot/velocity-tape';
import { GEXBOT_UNDERLYING_ORDER } from '../components/Gexbot/ticker-order';
import type { VelocityRow } from '../hooks/useGexbotData';
import { dealerClaims } from './helpers/dealer-claims';

const mockUseGexbotData = vi.fn();
vi.mock('../hooks/useGexbotData', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useGexbotData')>(
    '../hooks/useGexbotData',
  );
  return {
    ...actual,
    useGexbotData: (...args: unknown[]) => mockUseGexbotData(...args),
  };
});

function makeRow(overrides: Partial<VelocityRow>): VelocityRow {
  return {
    ticker: 'SPX',
    capturedAt: '2026-10-29T14:04:00Z',
    minDte: 0,
    dAggDex: null,
    dZgr: null,
    dZcvr: null,
    typicalAbsDAggDex: null,
    ...overrides,
  };
}

function mockRows(rows: VelocityRow[]) {
  mockUseGexbotData.mockReturnValue({
    rows,
    loading: false,
    error: null,
    freshestAt: '2026-10-29T14:04:00Z',
  });
}

describe('isUnusual', () => {
  it('flags a move at 3x the ticker own median', () => {
    expect(isUnusual(makeRow({ dAggDex: 3, typicalAbsDAggDex: 1 }))).toBe(true);
  });

  it('flags exactly 3x and not below it', () => {
    expect(isUnusual(makeRow({ dAggDex: -3, typicalAbsDAggDex: 1 }))).toBe(
      true,
    );
    expect(isUnusual(makeRow({ dAggDex: 2.9, typicalAbsDAggDex: 1 }))).toBe(
      false,
    );
  });

  it('flags a median above the floor at exactly 3x, not just under it', () => {
    // 3 * 0.4 is 1.2000000000000002 in floating point; a Δ of 1.20 is
    // exactly 3x the median and must still count.
    expect(
      isUnusual(
        makeRow({ ticker: 'SPX', dAggDex: 1.2, typicalAbsDAggDex: 0.4 }),
      ),
    ).toBe(true);
    expect(
      isUnusual(
        makeRow({ ticker: 'SPX', dAggDex: 1.1, typicalAbsDAggDex: 0.4 }),
      ),
    ).toBe(false);
  });

  it('does not flag a one-tick move on a ticker whose median is 0', () => {
    // HYG: agg_dex rounds to 0.01, median |change| is 0.
    expect(
      isUnusual(
        makeRow({ ticker: 'HYG', dAggDex: 0.01, typicalAbsDAggDex: 0 }),
      ),
    ).toBe(false);
  });

  it('does not flag 0.12 on a ticker whose median is 0 (threshold is 0.75)', () => {
    expect(
      isUnusual(
        makeRow({ ticker: 'HYG', dAggDex: 0.12, typicalAbsDAggDex: 0 }),
      ),
    ).toBe(false);
  });

  it('flags a real move on a ticker whose median is 0', () => {
    expect(
      isUnusual(makeRow({ ticker: 'HYG', dAggDex: 0.8, typicalAbsDAggDex: 0 })),
    ).toBe(true);
  });

  it('treats an unknown median like 0 (floor applies)', () => {
    expect(isUnusual(makeRow({ dAggDex: 0.4, typicalAbsDAggDex: null }))).toBe(
      false,
    );
    expect(isUnusual(makeRow({ dAggDex: 0.75, typicalAbsDAggDex: null }))).toBe(
      true,
    );
  });

  it('never flags a null or NaN change', () => {
    expect(isUnusual(makeRow({ dAggDex: null, typicalAbsDAggDex: 0 }))).toBe(
      false,
    );
    expect(isUnusual(makeRow({ dAggDex: Number.NaN }))).toBe(false);
  });
});

describe('orderVelocityRows', () => {
  it('returns the underlyings in the fixed order whatever the input order or values', () => {
    const shuffled = [...GEXBOT_UNDERLYING_ORDER]
      .reverse()
      .map((ticker, i) => makeRow({ ticker, dAggDex: i * 1000 }));
    expect(orderVelocityRows(shuffled).map((r) => r.ticker)).toEqual([
      ...GEXBOT_UNDERLYING_ORDER,
    ]);
  });

  it('drops the futures views and unknown tickers, and skips missing ones', () => {
    const rows = ['ES_SPX', 'QQQ', 'NQ_NDX', 'ZZZ', 'SPX'].map((ticker) =>
      makeRow({ ticker }),
    );
    expect(orderVelocityRows(rows).map((r) => r.ticker)).toEqual([
      'SPX',
      'QQQ',
    ]);
  });

  it('does not mutate its input', () => {
    const input = [makeRow({ ticker: 'QQQ' }), makeRow({ ticker: 'SPX' })];
    orderVelocityRows(input);
    expect(input.map((r) => r.ticker)).toEqual(['QQQ', 'SPX']);
  });
});

describe('<DexoflowVelocityTape>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
  });

  it('asks the server for the velocity view', () => {
    mockRows([]);
    render(<DexoflowVelocityTape marketOpen />);
    expect(mockUseGexbotData).toHaveBeenCalledWith({ view: 'velocity' }, true);
  });

  it('shows empty-state when the server returns no rows', () => {
    mockRows([]);
    render(<DexoflowVelocityTape marketOpen />);
    expect(screen.getByTestId('dexoflow-tape-empty')).toBeInTheDocument();
  });

  it('shows loading placeholder', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: true,
      error: null,
      freshestAt: null,
    });
    render(<DexoflowVelocityTape marketOpen />);
    expect(screen.getByTestId('dexoflow-tape-loading')).toBeInTheDocument();
  });

  it('shows error when hook reports an error', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: 'HTTP 500',
      freshestAt: null,
    });
    render(<DexoflowVelocityTape marketOpen />);
    expect(screen.getByTestId('dexoflow-tape-error')).toBeInTheDocument();
  });

  it('renders the server-computed minute changes with K/M suffixes and signs', () => {
    // Already differenced server-side: agg_dex 130 -> 1_500_130 gives the
    // latest minute change below.
    mockRows([
      makeRow({
        ticker: 'SPX',
        dAggDex: 1_500_000,
        dZgr: -2_500,
        dZcvr: 0.04,
        typicalAbsDAggDex: 500_000,
      }),
    ]);
    const { container } = render(<DexoflowVelocityTape marketOpen />);
    const tape = container.querySelector('[data-testid="dexoflow-tape"]')!;
    expect(tape).toHaveTextContent(/\+1\.50M/);
    expect(tape).toHaveTextContent(/−2\.50K/);
    expect(tape).toHaveTextContent(/\+0\.04/);
  });

  it('shows an em dash, not zero, when the first-minute or gap case gave no change', () => {
    mockRows([makeRow({ ticker: 'SPX' })]);
    render(<DexoflowVelocityTape marketOpen />);
    const row = screen.getByTestId('dexoflow-tape').querySelector('tbody tr')!;
    const cells = Array.from(row.querySelectorAll('td')).slice(1);
    expect(cells).toHaveLength(3);
    for (const cell of cells) {
      expect(cell.textContent).toContain('—');
      expect(cell.textContent).not.toMatch(/\+0|0\.00/);
    }
  });

  it('keeps a genuine zero change visible as flat, distinct from a dash', () => {
    mockRows([makeRow({ ticker: 'SPX', dAggDex: 0, dZgr: 0, dZcvr: 0 })]);
    const { container } = render(<DexoflowVelocityTape marketOpen />);
    const labels = Array.from(
      container.querySelectorAll('td span[aria-label]'),
    ).map((el) => el.getAttribute('aria-label'));
    expect(labels).toHaveLength(3);
    for (const label of labels) expect(label).toMatch(/^flat /);
  });

  it('uses emerald for positive, rose for negative', () => {
    mockRows([
      makeRow({ ticker: 'SPX', dAggDex: 100, dZgr: -100, dZcvr: null }),
    ]);
    const { container } = render(<DexoflowVelocityTape marketOpen />);
    expect(container.querySelector('.text-emerald-300')).not.toBeNull();
    expect(container.querySelector('.text-rose-300')).not.toBeNull();
  });

  it('keeps a fixed row order regardless of the values', () => {
    mockRows([
      makeRow({ ticker: 'HYG', dAggDex: 9_000_000, typicalAbsDAggDex: 10 }),
      makeRow({ ticker: 'QQQ', dAggDex: null }),
      makeRow({ ticker: 'SPX', dAggDex: 1 }),
    ]);
    render(<DexoflowVelocityTape marketOpen />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('SPX');
    expect(rows[1]).toHaveTextContent('QQQ');
    expect(rows[2]).toHaveTextContent('HYG');
  });

  it('highlights an unusually large minute and only that row', () => {
    mockRows([
      makeRow({ ticker: 'SPX', dAggDex: 300, typicalAbsDAggDex: 100 }),
      makeRow({ ticker: 'QQQ', dAggDex: 100, typicalAbsDAggDex: 100 }),
      makeRow({ ticker: 'HYG', dAggDex: 0.01, typicalAbsDAggDex: 0 }),
      makeRow({ ticker: 'IWM', dAggDex: null }),
    ]);
    render(<DexoflowVelocityTape marketOpen />);
    const flagged = (t: string) =>
      screen
        .getAllByRole('row')
        .find((r) => r.textContent?.startsWith(t))
        ?.getAttribute('data-unusual');
    expect(flagged('SPX')).toBe('true');
    expect(flagged('QQQ')).toBe('false');
    expect(flagged('HYG')).toBe('false');
    expect(flagged('IWM')).toBe('false');
    expect(screen.getByText(/unusual/i, { selector: 'td *' })).toBeTruthy();
  });

  it('states the threshold as three times the ticker typical minute', () => {
    mockRows([makeRow({ ticker: 'SPX', dAggDex: 1 })]);
    render(<DexoflowVelocityTape marketOpen />);
    expect(screen.getByText(/at least three times that/)).toBeTruthy();
  });

  it('shows sub-unit values to 2 decimals and a zero as 0', () => {
    mockRows([makeRow({ ticker: 'SPX', dAggDex: 0.07, dZgr: -0.5, dZcvr: 0 })]);
    const { container } = render(<DexoflowVelocityTape marketOpen />);
    const text = container.querySelector('tbody')?.textContent ?? '';
    expect(text).toContain('+0.07');
    expect(text).toContain('−0.50');
    expect(text).not.toMatch(/\d\.\d{3,}/);
    const labels = Array.from(
      container.querySelectorAll('td span[aria-label]'),
    ).map((el) => el.getAttribute('aria-label'));
    expect(labels).toContain('flat 0');
  });

  it('shows only the 14 underlyings, never the futures views', () => {
    const all = [...GEXBOT_UNDERLYING_ORDER, 'ES_SPX', 'NQ_NDX'];
    mockRows(all.map((ticker) => makeRow({ ticker, dAggDex: 1 })));
    render(<DexoflowVelocityTape marketOpen />);
    const shown = screen
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.querySelector('td')?.textContent ?? '');
    expect(shown).toHaveLength(14);
    expect(shown.some((t) => t.startsWith('ES_SPX'))).toBe(false);
    expect(shown.some((t) => t.startsWith('NQ_NDX'))).toBe(false);
  });

  it('shows the DTE per ticker from min_dte instead of a hard-coded 0DTE', () => {
    mockRows([
      makeRow({ ticker: 'SPX', dAggDex: 1_000_000, minDte: 2 }),
      makeRow({ ticker: 'QQQ', dAggDex: 500_000, minDte: null }),
    ]);
    const { container } = render(<DexoflowVelocityTape marketOpen />);
    const byTicker = (t: string) =>
      Array.from(container.querySelectorAll('tbody tr')).find((r) =>
        r.textContent?.startsWith(t),
      );
    expect(byTicker('SPX')).toHaveTextContent('2DTE');
    expect(byTicker('QQQ')).toHaveTextContent('DTE n/a');
    expect(container.textContent ?? '').not.toContain('0DTE');
  });

  it('explains the minute-over-minute basis, uses taker wording, makes no dealer claims', () => {
    mockRows([makeRow({ ticker: 'SPX', dAggDex: 1_000_000, minDte: 2 })]);
    const { container } = render(<DexoflowVelocityTape marketOpen />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/taker/i);
    expect(text).toMatch(/minute/i);
    expect(dealerClaims(text)).toEqual([]);
  });
});
