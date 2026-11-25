import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExpectedMoveTile } from '../components/Gexbot/ExpectedMoveTile';
import { srHintText, titledGenericsWithoutHint } from './helpers/aria';
import { dealerClaims } from './helpers/dealer-claims';
import type { ExpectedMoveRow } from '../hooks/useGexbotData';

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

function makeRow(overrides: Partial<ExpectedMoveRow> = {}): ExpectedMoveRow {
  return {
    ticker: 'SPX',
    capturedAt: '2025-07-23T15:13:14.000Z',
    asOf: '2025-07-23T15:13:12.000Z',
    spot: 6326.27,
    minDte: 0,
    atmStrike: 6325,
    atmIv: 0.11,
    dteFraction: 0.19916666666666666,
    expectedMove: 16.25557378390728,
    lower: 6310.014426216093,
    upper: 6342.525573783908,
    unavailable: null,
    ...overrides,
  };
}

const UNAVAILABLE = {
  atmStrike: null,
  atmIv: null,
  expectedMove: null,
  lower: null,
  upper: null,
} as const;

function mockRows(rows: ExpectedMoveRow[]) {
  mockUseGexbotData.mockReturnValue({
    rows,
    loading: false,
    error: null,
    freshestAt: null,
  });
}

describe('<ExpectedMoveTile>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
  });

  it('reads the expected-move view and forwards marketOpen', () => {
    mockRows([]);
    render(<ExpectedMoveTile marketOpen={false} />);
    expect(mockUseGexbotData).toHaveBeenCalledWith(
      { view: 'expected-move' },
      false,
    );
  });

  it('shows the loading placeholder', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: true,
      error: null,
      freshestAt: null,
    });
    render(<ExpectedMoveTile marketOpen />);
    expect(
      screen.getByTestId('expected-move-tile-loading'),
    ).toBeInTheDocument();
  });

  it('shows the read error', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: 'Internal error (HTTP 500)',
      freshestAt: null,
    });
    render(<ExpectedMoveTile marketOpen />);
    expect(screen.getByTestId('expected-move-tile-error')).toHaveTextContent(
      'Internal error (HTTP 500)',
    );
  });

  it('shows the empty state when there is no fresh capture', () => {
    mockRows([]);
    render(<ExpectedMoveTile marketOpen />);
    expect(screen.getByTestId('expected-move-tile-empty')).toBeInTheDocument();
  });

  it('shows the move, the range around spot, the ATM IV and the expiry', () => {
    mockRows([makeRow()]);
    render(<ExpectedMoveTile marketOpen />);
    expect(screen.getByTestId('expected-move-value')).toHaveTextContent(
      'SPX ±1σ · ±16.3 pts',
    );
    expect(screen.getByTestId('expected-move-range')).toHaveTextContent(
      '6,310.0 – 6,342.5 · ATM IV 11.0% · 0DTE',
    );
  });

  it.each([
    ['no_atm_iv', 'no IV at the ATM strike in the latest capture'],
    ['no_spot', 'no spot in the latest capture'],
    ['no_dte', 'expiry not reported'],
    ['expired', 'session closed'],
  ] as const)('names why the move is missing: %s', (unavailable, text) => {
    mockRows([makeRow({ ...UNAVAILABLE, unavailable })]);
    render(<ExpectedMoveTile marketOpen />);
    expect(screen.getByTestId('expected-move-value')).toHaveTextContent(
      'SPX ±1σ · —',
    );
    expect(screen.getByTestId('expected-move-range')).toHaveTextContent(text);
  });

  it('never prints a number for a row that says it is unavailable', () => {
    // A row cannot be both; if one ever is, the reason wins.
    mockRows([makeRow({ unavailable: 'no_atm_iv' })]);
    render(<ExpectedMoveTile marketOpen />);
    expect(screen.getByTestId('expected-move-value')).toHaveTextContent(
      'SPX ±1σ · —',
    );
  });

  it('shows a dash for a malformed row with neither a move nor a reason', () => {
    mockRows([makeRow({ ...UNAVAILABLE, unavailable: null })]);
    render(<ExpectedMoveTile marketOpen />);
    expect(screen.getByTestId('expected-move-value')).toHaveTextContent(
      'SPX ±1σ · —',
    );
    expect(screen.getByTestId('expected-move-range')).toHaveTextContent('—');
  });

  it('labels an expiry that is not today', () => {
    mockRows([makeRow({ minDte: 2 })]);
    render(<ExpectedMoveTile marketOpen />);
    expect(screen.getByTestId('expected-move-range')).toHaveTextContent('2DTE');
  });

  it('stays neutral: the range is not a directional signal', () => {
    mockRows([makeRow()]);
    render(<ExpectedMoveTile marketOpen />);
    const tile = screen.getByTestId('expected-move-tile');
    expect(tile.className).not.toContain('emerald');
    expect(tile.className).not.toContain('rose');
  });

  it('gives a screen reader the meaning its hover title carries', () => {
    mockRows([makeRow()]);
    const { container } = render(<ExpectedMoveTile marketOpen />);
    const tile = screen.getByTestId('expected-move-tile');
    expect(tile).toHaveAttribute('title');
    expect(srHintText(tile)).toBe(
      'one standard deviation, from at-the-money implied volatility',
    );
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });

  it('credits GEXBot with the formula and the 50/25/25 smoothing, and nothing else', () => {
    mockRows([makeRow()]);
    render(<ExpectedMoveTile marketOpen />);
    const title =
      screen.getByTestId('expected-move-tile').getAttribute('title') ?? '';
    const [vendor = '', ours = ''] = title.split('Our choices');
    // GEXBot documents the formula and the weights ...
    expect(vendor).toContain("GEXBot's formula");
    expect(vendor).toContain('50%');
    expect(vendor).toContain('25%');
    // ... not the ATM pick or the call/put averaging, which are ours.
    expect(vendor).not.toMatch(/nearest|mean of|call and put/);
    expect(ours).toContain('not documented by GEXBot');
    expect(ours).toContain('the listed strike nearest spot');
    expect(ours).toContain('mean of its call and put IV');
  });

  it('makes no dealer claims', () => {
    mockRows([makeRow()]);
    render(<ExpectedMoveTile marketOpen />);
    const tile = screen.getByTestId('expected-move-tile');
    expect(dealerClaims(tile.textContent ?? '')).toEqual([]);
    expect(dealerClaims(tile.getAttribute('title') ?? '')).toEqual([]);
  });
});
