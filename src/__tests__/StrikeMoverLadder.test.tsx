import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { StrikeMoverLadder } from '../components/Gexbot/StrikeMoverLadder';
import { GAMMA_SIGN_CLASSES } from '../components/GexLandscape/constants';
import { dealerClaims } from './helpers/dealer-claims';
import { makeWinner } from './helpers/makeWinner';

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

const CAT = 'gex_zero/maxchange';

function withRows(rows: unknown[]) {
  mockUseGexbotData.mockReturnValue({
    rows,
    loading: false,
    error: null,
    freshestAt: '2026-05-19T17:00:00Z',
  });
}

describe('<StrikeMoverLadder>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
  });

  it('renders loading placeholder when hook is loading', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: true,
      error: null,
      freshestAt: null,
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    expect(
      screen.getByTestId('strike-mover-ladder-loading'),
    ).toBeInTheDocument();
  });

  it('renders error tile when hook reports an error', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: 'HTTP 500',
      freshestAt: null,
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    expect(screen.getByTestId('strike-mover-ladder-error')).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  });

  it('renders the empty state when there are no winners', () => {
    withRows([]);
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    expect(screen.getByTestId('strike-mover-ladder-empty')).toBeInTheDocument();
  });

  it('shows the spot in the header when available', () => {
    withRows([]);
    render(<StrikeMoverLadder marketOpen spxSpot={6750.5} />);
    expect(screen.getByText(/spot 6750\.5/)).toBeInTheDocument();
  });

  it('renders exactly two model tabs', () => {
    withRows([]);
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    const tabs = screen.getAllByRole('button');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Classic GEX',
      'State (taker)',
    ]);
  });

  it('shows only Classic winners on the Classic tab and only State on the State tab', () => {
    withRows([
      makeWinner('SPX', CAT, 6750, 2_100, 'classic'),
      makeWinner('SPX', CAT, 6700, -900, 'state'),
    ]);
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    expect(
      screen.getByTestId('strike-mover-ladder-row-6750'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('strike-mover-ladder-row-6700'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'State (taker)' }));
    expect(
      screen.getByTestId('strike-mover-ladder-row-6700'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('strike-mover-ladder-row-6750'),
    ).not.toBeInTheDocument();
  });

  it('carries a one-line legend per tab', () => {
    withRows([]);
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    expect(
      screen.getByText(
        'Classic GEX by volume — calls +, puts −; biggest change by strike',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'State (taker)' }));
    expect(
      screen.getByText(
        'GEXBot State — taker-flow GEX imbalance; biggest change by strike',
      ),
    ).toBeInTheDocument();
  });

  it('keeps the visible text free of dealer claims', () => {
    withRows([makeWinner('SPX', CAT, 6800, -820)]);
    const { container } = render(
      <StrikeMoverLadder marketOpen spxSpot={6750} />,
    );
    expect(dealerClaims(container.textContent ?? '')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'State (taker)' }));
    expect(dealerClaims(container.textContent ?? '')).toEqual([]);
  });

  it('renders no ES_SPX row and counts only distinct underlyings', () => {
    withRows([
      makeWinner('SPX', CAT, 6750, 2_100),
      makeWinner('ES_SPX', CAT, 6785, 2_050),
      makeWinner('SPY', CAT, 675, 1_500),
    ]);
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    expect(
      screen.queryByTestId('strike-mover-ladder-row-6785'),
    ).not.toBeInTheDocument();
    const row = screen.getByTestId('strike-mover-ladder-row-6750');
    expect(row).toHaveTextContent('2✓');
    expect(row).not.toHaveTextContent('3✓');
    expect(row).not.toHaveTextContent('ES');
  });

  it('explains the N✓ badge as weak, non-independent confirmation', () => {
    withRows([
      makeWinner('SPX', CAT, 6750, 2_100),
      makeWinner('SPY', CAT, 675, 1_500),
    ]);
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    const badge = screen.getByTitle(/SPX and SPY agree on sign/);
    expect(badge).toHaveTextContent('2✓');
    expect(badge.getAttribute('title')).toMatch(
      /weak, non-independent confirmation/,
    );
    // A bare span's aria-label is ignored, so the badge is an image role.
    expect(badge).toHaveAttribute('role', 'img');
    expect(badge).toHaveAttribute(
      'aria-label',
      `2 confirmations. ${badge.getAttribute('title')}`,
    );
  });

  it('colours a row by its sign alone, the same above and below spot', () => {
    withRows([
      makeWinner('SPX', CAT, 6800, 1_000),
      makeWinner('SPX', CAT, 6700, 1_000),
      makeWinner('SPX', CAT, 6850, -1_000),
      makeWinner('SPX', CAT, 6650, -1_000),
    ]);
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    const longClass = GAMMA_SIGN_CLASSES.long.color;
    const shortClass = GAMMA_SIGN_CLASSES.short.color;
    for (const k of [6800, 6700]) {
      expect(screen.getByTestId(`strike-mover-ladder-row-${k}`)).toHaveClass(
        longClass,
      );
    }
    for (const k of [6850, 6650]) {
      expect(screen.getByTestId(`strike-mover-ladder-row-${k}`)).toHaveClass(
        shortClass,
      );
    }
  });

  it('puts the spot divider before floor rows', () => {
    withRows([makeWinner('SPX', CAT, 6700, 1_600)]);
    const { container } = render(
      <StrikeMoverLadder marketOpen spxSpot={6750} />,
    );
    const divider = container.querySelector(
      '[data-testid="strike-mover-ladder-spot-divider"]',
    );
    const row = container.querySelector(
      '[data-testid="strike-mover-ladder-row-6700"]',
    );
    expect(divider).not.toBeNull();
    expect(row).not.toBeNull();
    expect(divider!.compareDocumentPosition(row!) & 4).toBeTruthy();
  });

  it('falls back to the empty state when spxSpot is null but winners exist', () => {
    withRows([makeWinner('SPX', CAT, 6750, 2_100)]);
    render(<StrikeMoverLadder marketOpen spxSpot={null} />);
    expect(screen.getByTestId('strike-mover-ladder-empty')).toBeInTheDocument();
    expect(
      screen.queryByTestId('strike-mover-ladder-row-6750'),
    ).not.toBeInTheDocument();
  });
});
