import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NetVannaTile } from '../components/Gexbot/NetVannaTile';
import { srHintText, titledGenericsWithoutHint } from './helpers/aria';
import { dealerClaims } from './helpers/dealer-claims';
import type { SnapshotsLatestRow } from '../hooks/useGexbotData';

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

function makeRow(overrides: Partial<SnapshotsLatestRow>): SnapshotsLatestRow {
  return {
    ticker: 'SPX',
    capturedAt: '2026-05-19T19:30:00Z',
    spot: 5985.2,
    zeroGamma: 5990,
    zMlgamma: null,
    zMsgamma: null,
    zcvr: null,
    zgr: null,
    zvanna: null,
    zcharm: null,
    oMlgamma: null,
    oMsgamma: null,
    ocvr: null,
    ogr: null,
    ovanna: null,
    ocharm: null,
    oneDexoflow: null,
    oneGexoflow: null,
    oneCvroflow: null,
    minDte: 0,
    ...overrides,
  };
}

function mockRows(rows: SnapshotsLatestRow[]) {
  mockUseGexbotData.mockReturnValue({
    rows,
    loading: false,
    error: null,
    freshestAt: null,
  });
}

/**
 * "$912 MM" is the vendor's unit (millions of dollars). The dealer-claim
 * check reads a bare "MM" as "market makers", so drop the unit before it.
 */
function withoutMmUnit(text: string): string {
  return text.replaceAll(/\$[\d,.]*\s?MM\b/g, '$');
}

/** Set the wall clock to `hours` before the 16:00 ET close on 2026-05-19. */
function setHoursToClose(hours: number) {
  const close = new Date('2026-05-19T20:00:00Z').getTime();
  vi.setSystemTime(new Date(close - hours * 3_600_000));
}

describe('<NetVannaTile>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
    vi.useFakeTimers();
    setHoursToClose(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the snapshots-latest view and forwards marketOpen', () => {
    mockRows([]);
    render(<NetVannaTile marketOpen={false} />);
    expect(mockUseGexbotData).toHaveBeenCalledWith(
      { view: 'snapshots-latest' },
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
    render(<NetVannaTile marketOpen />);
    expect(screen.getByTestId('net-vanna-tile-loading')).toBeInTheDocument();
  });

  it('shows the read error', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: 'Internal error (HTTP 500)',
      freshestAt: null,
    });
    render(<NetVannaTile marketOpen />);
    expect(screen.getByTestId('net-vanna-tile-error')).toHaveTextContent(
      'Internal error (HTTP 500)',
    );
  });

  it('shows the empty state when SPX is absent or has no zvanna', () => {
    mockRows([makeRow({ ticker: 'NDX', zvanna: 2000 })]);
    const { unmount } = render(<NetVannaTile marketOpen />);
    expect(screen.getByTestId('net-vanna-tile-empty')).toBeInTheDocument();
    unmount();

    mockRows([makeRow({ zvanna: null })]);
    render(<NetVannaTile marketOpen />);
    expect(screen.getByTestId('net-vanna-tile-empty')).toBeInTheDocument();
  });

  it('colours a large positive reading in the last hour and says it adds bids', () => {
    mockRows([makeRow({ zvanna: 912.4 })]);
    render(<NetVannaTile marketOpen />);
    const tile = screen.getByTestId('net-vanna-tile');
    expect(screen.getByTestId('net-vanna-value')).toHaveTextContent('+$912 MM');
    expect(screen.getByTestId('net-vanna-read')).toHaveTextContent(
      'adds passive bids · in play, last hour',
    );
    expect(tile.className).toContain('emerald');
  });

  it('colours a large negative reading and says it adds offers', () => {
    setHoursToClose(1.75);
    mockRows([makeRow({ zvanna: -1204.6 })]);
    render(<NetVannaTile marketOpen />);
    expect(screen.getByTestId('net-vanna-value')).toHaveTextContent(
      '−$1,205 MM',
    );
    expect(screen.getByTestId('net-vanna-read')).toHaveTextContent(
      'adds passive offers · in play, last 2h',
    );
    expect(screen.getByTestId('net-vanna-tile').className).toContain('rose');
  });

  it('stays neutral and counts down while a large reading is outside its window', () => {
    setHoursToClose(2.25);
    mockRows([makeRow({ zvanna: 912.4 })]);
    render(<NetVannaTile marketOpen />);
    const tile = screen.getByTestId('net-vanna-tile');
    expect(screen.getByTestId('net-vanna-read')).toHaveTextContent(
      'adds passive bids · in play in 1h 15m (last hour)',
    );
    expect(tile.className).not.toContain('emerald');
    expect(tile.className).not.toContain('rose');
  });

  it('stays neutral below the vendor threshold', () => {
    mockRows([makeRow({ zvanna: 130.96 })]);
    render(<NetVannaTile marketOpen />);
    const tile = screen.getByTestId('net-vanna-tile');
    expect(screen.getByTestId('net-vanna-value')).toHaveTextContent('+$131 MM');
    expect(screen.getByTestId('net-vanna-read')).toHaveTextContent(
      '$800 MM or less · no late-day read',
    );
    expect(tile.className).not.toContain('emerald');
    expect(tile.className).not.toContain('rose');
  });

  it('treats exactly $800 MM as quiet: the vendor says "beyond"', () => {
    mockRows([makeRow({ zvanna: 800 })]);
    render(<NetVannaTile marketOpen />);
    expect(screen.getByTestId('net-vanna-read')).toHaveTextContent(
      '$800 MM or less · no late-day read',
    );
    expect(screen.getByTestId('net-vanna-tile').className).not.toContain(
      'emerald',
    );
  });

  it('says the session is closed after the close', () => {
    setHoursToClose(-0.1);
    mockRows([makeRow({ zvanna: 1500 })]);
    render(<NetVannaTile marketOpen={false} />);
    expect(screen.getByTestId('net-vanna-read')).toHaveTextContent(
      'session closed',
    );
    expect(screen.getByTestId('net-vanna-tile').className).not.toContain(
      'emerald',
    );
  });

  // The market gate stops the clock, which leaves `now` a minute before the
  // close. The tile must not stay "in play" for the rest of the evening.
  it('clears the in-play colour when the market closes during a live session', () => {
    setHoursToClose(30 / 3600); // 15:59:30 ET
    mockRows([makeRow({ zvanna: 912.4 })]);
    const { rerender } = render(<NetVannaTile marketOpen />);
    const tile = screen.getByTestId('net-vanna-tile');
    expect(screen.getByTestId('net-vanna-read')).toHaveTextContent(
      'adds passive bids · in play, last hour',
    );
    expect(tile.className).toContain('emerald');

    rerender(<NetVannaTile marketOpen={false} />);
    expect(screen.getByTestId('net-vanna-read')).toHaveTextContent(
      'session closed',
    );
    expect(screen.getByTestId('net-vanna-tile').className).not.toContain(
      'emerald',
    );
  });

  // 2026-11-27 is an early-close day (13:00 ET). At 12:15 ET there are 45
  // minutes left, inside the last two hours a $1,200 MM reading matters in.
  it('counts down to the 13:00 ET close on a half day', () => {
    vi.setSystemTime(new Date('2026-11-27T17:15:00Z')); // 12:15 EST
    mockRows([makeRow({ zvanna: -1200 })]);
    render(<NetVannaTile marketOpen />);
    expect(screen.getByTestId('net-vanna-read')).toHaveTextContent(
      'adds passive offers · in play, last 2h',
    );
    expect(screen.getByTestId('net-vanna-read')).not.toHaveTextContent(
      'in play in',
    );
    expect(screen.getByTestId('net-vanna-tile').className).toContain('rose');
  });

  it('gives a screen reader the meaning its hover title carries', () => {
    mockRows([makeRow({ zvanna: 912 })]);
    const { container } = render(<NetVannaTile marketOpen />);
    const tile = screen.getByTestId('net-vanna-tile');
    expect(tile).toHaveAttribute('title');
    const hint = srHintText(tile);
    expect(hint).toBe(
      'GEXBot guidance: matters only above a size threshold late in the session',
    );
    expect(dealerClaims(hint!)).toEqual([]);
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });

  it('uses SPX only, not the ES_SPX futures view', () => {
    mockRows([
      makeRow({ ticker: 'ES_SPX', zvanna: -5000 }),
      makeRow({ ticker: 'SPX', zvanna: 912.4 }),
    ]);
    render(<NetVannaTile marketOpen />);
    expect(screen.getByTestId('net-vanna-value')).toHaveTextContent('+$912 MM');
  });

  it.each([912.4, -1204.6, 130.96])(
    'makes no dealer claims for %f',
    (zvanna) => {
      mockRows([makeRow({ zvanna })]);
      render(<NetVannaTile marketOpen />);
      const tile = screen.getByTestId('net-vanna-tile');
      expect(dealerClaims(withoutMmUnit(tile.textContent ?? ''))).toEqual([]);
      expect(
        dealerClaims(withoutMmUnit(tile.getAttribute('title') ?? '')),
      ).toEqual([]);
    },
  );
});
