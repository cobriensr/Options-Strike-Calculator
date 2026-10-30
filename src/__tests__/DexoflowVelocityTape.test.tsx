import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { DexoflowVelocityTape } from '../components/Gexbot/DexoflowVelocityTape';
import {
  sortVelocityRows,
  velocityScore,
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

describe('velocityScore / sortVelocityRows', () => {
  it('scores |change| relative to the ticker own typical minute change', () => {
    expect(
      velocityScore(makeRow({ dAggDex: -300, typicalAbsDAggDex: 100 })),
    ).toBe(3);
  });

  it('scores a missing change as null so it sorts last', () => {
    expect(
      velocityScore(makeRow({ dAggDex: null, typicalAbsDAggDex: 100 })),
    ).toBe(null);
  });

  it('treats a nonzero change against a zero or unknown baseline as infinitely unusual', () => {
    expect(velocityScore(makeRow({ dAggDex: 5, typicalAbsDAggDex: 0 }))).toBe(
      Infinity,
    );
    expect(
      velocityScore(makeRow({ dAggDex: 5, typicalAbsDAggDex: null })),
    ).toBe(Infinity);
  });

  it('scores a zero change as zero whatever the baseline', () => {
    expect(velocityScore(makeRow({ dAggDex: 0, typicalAbsDAggDex: 0 }))).toBe(
      0,
    );
    expect(
      velocityScore(makeRow({ dAggDex: 0, typicalAbsDAggDex: null })),
    ).toBe(0);
  });

  it('ranks by the relative score, not the raw dollar size', () => {
    // SPX moved 10x more dollars than HYG, but only 2x its own norm; HYG is
    // 8x its own norm. Summing raw units would put SPX first.
    const sorted = sortVelocityRows([
      makeRow({
        ticker: 'SPX',
        dAggDex: 20_000_000,
        typicalAbsDAggDex: 10_000_000,
      }),
      makeRow({
        ticker: 'HYG',
        dAggDex: 2_000_000,
        typicalAbsDAggDex: 250_000,
      }),
    ]);
    expect(sorted.map((r) => r.ticker)).toEqual(['HYG', 'SPX']);
  });

  it('sorts rows without a change last, then ties by ticker', () => {
    const sorted = sortVelocityRows([
      makeRow({ ticker: 'VIX', dAggDex: null }),
      makeRow({ ticker: 'QQQ', dAggDex: 10, typicalAbsDAggDex: 10 }),
      makeRow({ ticker: 'IWM', dAggDex: 10, typicalAbsDAggDex: 10 }),
      makeRow({ ticker: 'GLD', dAggDex: null }),
    ]);
    expect(sorted.map((r) => r.ticker)).toEqual(['IWM', 'QQQ', 'GLD', 'VIX']);
  });

  it('does not mutate its input', () => {
    const input = [
      makeRow({ ticker: 'B', dAggDex: 1, typicalAbsDAggDex: 10 }),
      makeRow({ ticker: 'A', dAggDex: 9, typicalAbsDAggDex: 10 }),
    ];
    sortVelocityRows(input);
    expect(input.map((r) => r.ticker)).toEqual(['B', 'A']);
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
    // 3-snapshot fixture, already differenced server-side: agg_dex
    // 100 -> 130 -> 1_630_000 gives the latest minute change below.
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

  it('orders rows by change relative to each ticker own norm', () => {
    mockRows([
      makeRow({
        ticker: 'SPX',
        dAggDex: 20_000_000,
        typicalAbsDAggDex: 10_000_000,
      }),
      makeRow({
        ticker: 'HYG',
        dAggDex: 2_000_000,
        typicalAbsDAggDex: 250_000,
      }),
      makeRow({ ticker: 'QQQ', dAggDex: null }),
    ]);
    render(<DexoflowVelocityTape marketOpen />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('HYG');
    expect(rows[1]).toHaveTextContent('SPX');
    expect(rows[2]).toHaveTextContent('QQQ');
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
