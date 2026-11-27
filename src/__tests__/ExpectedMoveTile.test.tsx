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
    strikeIvs: [],
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

  // The hook stops polling when `marketOpen` goes false (16:00 ET, 13:00 ET
  // on a half day), and the vendor's last stamp of a session is 15:59:59 ET,
  // so the server's `expired` never reaches an open tab. The tile closes
  // itself from the client's own gate.
  describe('when the market is closed', () => {
    it('replaces a live move with "session closed" when marketOpen goes false', () => {
      mockRows([makeRow()]);
      const { rerender } = render(<ExpectedMoveTile marketOpen />);
      expect(screen.getByTestId('expected-move-value')).toHaveTextContent(
        '±16.3 pts',
      );

      rerender(<ExpectedMoveTile marketOpen={false} />);

      expect(screen.getByTestId('expected-move-value')).toHaveTextContent(
        'SPX ±1σ · —',
      );
      expect(screen.getByTestId('expected-move-value')).not.toHaveTextContent(
        'pts',
      );
      expect(screen.getByTestId('expected-move-range')).toHaveTextContent(
        'session closed',
      );
      expect(screen.queryByText(/ATM IV/)).not.toBeInTheDocument();
    });

    it('shows "session closed" on mount for a live row', () => {
      mockRows([makeRow()]);
      render(<ExpectedMoveTile marketOpen={false} />);
      expect(screen.getByTestId('expected-move-value')).toHaveTextContent(
        'SPX ±1σ · —',
      );
      expect(screen.getByTestId('expected-move-range')).toHaveTextContent(
        'session closed',
      );
    });

    it('overrides whatever reason the row carries', () => {
      mockRows([makeRow({ ...UNAVAILABLE, unavailable: 'no_atm_iv' })]);
      render(<ExpectedMoveTile marketOpen={false} />);
      expect(screen.getByTestId('expected-move-range')).toHaveTextContent(
        'session closed',
      );
    });

    // A load after the close (reload, PWA update, a new device) gets an empty
    // body, since the view keeps its 5-minute window. A tab held through the
    // close reads "session closed"; a fresh load must read the same.
    it('reads "session closed" when there is no row at all', () => {
      mockRows([]);
      render(<ExpectedMoveTile marketOpen={false} />);
      expect(screen.getByTestId('expected-move-value')).toHaveTextContent(
        'SPX ±1σ · —',
      );
      expect(screen.getByTestId('expected-move-range')).toHaveTextContent(
        'session closed',
      );
      expect(
        screen.queryByTestId('expected-move-tile-empty'),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/awaiting first/)).not.toBeInTheDocument();
    });

    it('reads the same on a fresh load as on a tab held through the close', () => {
      mockRows([makeRow()]);
      const held = render(<ExpectedMoveTile marketOpen={false} />);
      const heldText = screen.getByTestId('expected-move-tile').textContent;
      held.unmount();

      mockRows([]);
      render(<ExpectedMoveTile marketOpen={false} />);
      expect(screen.getByTestId('expected-move-tile').textContent).toBe(
        heldText,
      );
    });

    it('still reads awaiting when the market is open and there is no row', () => {
      mockRows([]);
      render(<ExpectedMoveTile marketOpen />);
      expect(screen.getByTestId('expected-move-tile-empty')).toHaveTextContent(
        'awaiting first GEXBot tick',
      );
      expect(screen.queryByText(/session closed/)).not.toBeInTheDocument();
    });

    it('keeps the loading state as it is', () => {
      mockUseGexbotData.mockReturnValue({
        rows: [makeRow()],
        loading: true,
        error: null,
        freshestAt: null,
      });
      render(<ExpectedMoveTile marketOpen={false} />);
      expect(
        screen.getByTestId('expected-move-tile-loading'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/session closed/)).not.toBeInTheDocument();
    });

    it('keeps the error state as it is', () => {
      mockUseGexbotData.mockReturnValue({
        rows: [makeRow()],
        loading: false,
        error: 'Internal error (HTTP 500)',
        freshestAt: null,
      });
      render(<ExpectedMoveTile marketOpen={false} />);
      expect(screen.getByTestId('expected-move-tile-error')).toHaveTextContent(
        'Internal error (HTTP 500)',
      );
      expect(screen.queryByText(/session closed/)).not.toBeInTheDocument();
    });
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
