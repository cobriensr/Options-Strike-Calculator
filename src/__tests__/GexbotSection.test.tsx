import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

import type { GexbotView, SnapshotsLatestRow } from '../hooks/useGexbotData';

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

import { GexbotSection } from '../components/Gexbot';
import { dealerClaims } from './helpers/dealer-claims';
import { makeWinner } from './helpers/makeWinner';

describe('<GexbotSection>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: null,
      freshestAt: null,
    });
  });

  it('renders without crashing with marketOpen=true', () => {
    const { container } = render(<GexbotSection marketOpen spxSpot={6750} />);
    expect(container.firstChild).not.toBeNull();
  });

  it('renders without crashing with marketOpen=false', () => {
    const { container } = render(
      <GexbotSection marketOpen={false} spxSpot={null} />,
    );
    expect(container.firstChild).not.toBeNull();
  });

  it('shows the source-honest section label', () => {
    render(<GexbotSection marketOpen spxSpot={6750} />);
    expect(screen.getAllByText(/GEXBot Taker Flow/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Dealer State/i)).toBeNull();
  });

  it('footer names the 14 underlyings and makes no dealer claims', () => {
    const { container } = render(<GexbotSection marketOpen spxSpot={6750} />);
    const footer = container.querySelector('p');
    expect(footer).toHaveTextContent('14 underlyings');
    expect(dealerClaims(footer?.textContent ?? '')).toEqual([]);
  });

  it('no longer renders the cross-asset skew dashboard', () => {
    // Built on delta_risk_reversal, which GEXBot lists as discontinued.
    const { container } = render(<GexbotSection marketOpen spxSpot={6750} />);
    expect(screen.queryByTestId('skew-dashboard-empty')).toBeNull();
    expect(screen.queryByTestId('skew-dashboard')).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/skew/i);
  });

  it('mounts the 8 child components (drives empty-state testids)', () => {
    render(<GexbotSection marketOpen spxSpot={6750} />);
    expect(
      screen.getByTestId('dealer-state-summary-strip-empty'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('expected-move-tile-empty')).toBeInTheDocument();
    expect(screen.getByTestId('net-vanna-tile-empty')).toBeInTheDocument();
    expect(screen.getByTestId('strike-mover-ladder-empty')).toBeInTheDocument();
    expect(screen.getByTestId('charm-clock-empty')).toBeInTheDocument();
    expect(screen.getByTestId('gamma-compass-empty')).toBeInTheDocument();
    expect(screen.getByTestId('dexoflow-tape-empty')).toBeInTheDocument();
    expect(screen.getByTestId('convexity-matrix-empty')).toBeInTheDocument();
  });

  it('forwards marketOpen=false to the data hook for each child', () => {
    render(<GexbotSection marketOpen={false} spxSpot={null} />);
    const calls = mockUseGexbotData.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[1]).toBe(false);
    }
  });

  it('renders the trial-context footnote', () => {
    render(<GexbotSection marketOpen spxSpot={6750} />);
    expect(screen.getByText(/GEXBot Orderflow-tier data/i)).toBeInTheDocument();
  });
});

describe('<GexbotSection> after the close', () => {
  /** Fri 2026-11-20 15:00:49 CT: the last capture of the session. */
  const FRIDAY_CLOSE = '2026-11-20T21:00:49.000Z';
  const SATURDAY = new Date('2026-11-21T15:00:00Z');

  function snapshotRow(ticker: string, spot: number): SnapshotsLatestRow {
    return {
      ticker,
      capturedAt: FRIDAY_CLOSE,
      spot,
      zeroGamma: null,
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
      zeroMcall: null,
      zeroMput: null,
      majorPosVol: null,
      majorPosOi: null,
      majorNegVol: null,
      majorNegOi: null,
      minDte: 0,
    };
  }

  /** Answers each view with its own body; any view not named reads empty. */
  function answerViews(
    bodies: Partial<
      Record<GexbotView['view'], { rows?: unknown[]; asOf?: string | null }>
    >,
  ) {
    mockUseGexbotData.mockImplementation((spec: GexbotView) => ({
      rows: [],
      loading: false,
      error: null,
      freshestAt: null,
      asOf: null,
      ...bodies[spec.view],
    }));
  }

  beforeEach(() => {
    mockUseGexbotData.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(SATURDAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('labels the section CLOSED with the capture time', () => {
    answerViews({
      'snapshots-latest': {
        rows: [snapshotRow('SPX', 6600)],
        asOf: FRIDAY_CLOSE,
      },
    });
    render(<GexbotSection marketOpen={false} spxSpot={null} />);
    expect(screen.getByTestId('gexbot-closed-label')).toHaveTextContent(
      'CLOSED · as of Fri 3:00 PM CT',
    );
    expect(mockUseGexbotData).toHaveBeenCalledWith(
      { view: 'snapshots-latest' },
      false,
    );
  });

  // The label is "CLOSED · as of <time>"; with no time to show, a bare
  // "CLOSED · as of" would dangle, so the header stays plain.
  it.each([
    ['a capture time that does not parse', 'not a time'],
    ['an empty capture time', ''],
  ])('shows no label for %s', (_label, asOf) => {
    answerViews({
      'snapshots-latest': { rows: [snapshotRow('SPX', 6600)], asOf },
    });
    render(<GexbotSection marketOpen={false} spxSpot={null} />);
    expect(screen.queryByTestId('gexbot-closed-label')).toBeNull();
    expect(screen.queryByText(/CLOSED · as of/)).toBeNull();
  });

  it('adds the date once the capture is more than 6 days old', () => {
    vi.setSystemTime(new Date('2026-11-30T15:00:00Z'));
    answerViews({
      'snapshots-latest': {
        rows: [snapshotRow('SPX', 6600)],
        asOf: FRIDAY_CLOSE,
      },
    });
    render(<GexbotSection marketOpen={false} spxSpot={null} />);
    expect(screen.getByTestId('gexbot-closed-label')).toHaveTextContent(
      'CLOSED · as of Fri Nov 20 3:00 PM CT',
    );
  });

  it('shows no label while the market is open', () => {
    answerViews({
      'snapshots-latest': {
        rows: [snapshotRow('SPX', 6600)],
        asOf: FRIDAY_CLOSE,
      },
    });
    render(<GexbotSection marketOpen spxSpot={6600} />);
    expect(screen.queryByTestId('gexbot-closed-label')).toBeNull();
  });

  it('shows no label after the close when the table has no capture time', () => {
    answerViews({});
    render(<GexbotSection marketOpen={false} spxSpot={null} />);
    expect(screen.queryByTestId('gexbot-closed-label')).toBeNull();
  });

  it('hands the ladder the SPX spot of the snapshots, not another ticker', () => {
    answerViews({
      'snapshots-latest': {
        rows: [snapshotRow('SPY', 660), snapshotRow('SPX', 6600)],
        asOf: FRIDAY_CLOSE,
      },
      'maxchange-winners': {
        rows: [makeWinner('SPX', 'gex_zero/maxchange', 6600, 2_100)],
        asOf: FRIDAY_CLOSE,
      },
    });
    render(<GexbotSection marketOpen={false} spxSpot={null} />);
    expect(
      screen.getByTestId('strike-mover-ladder-spot-divider'),
    ).toHaveTextContent('SPX spot 6600');
    expect(
      screen.getByTestId('strike-mover-ladder-row-6600'),
    ).toBeInTheDocument();
  });

  it("keeps the ladder's rows off another session than the header's", () => {
    answerViews({
      'snapshots-latest': {
        rows: [snapshotRow('SPX', 6600)],
        asOf: FRIDAY_CLOSE,
      },
      'maxchange-winners': {
        rows: [makeWinner('SPX', 'gex_zero/maxchange', 6600, 2_100)],
        asOf: '2026-11-19T21:00:00.000Z',
      },
    });
    render(<GexbotSection marketOpen={false} spxSpot={null} />);
    expect(screen.getByTestId('gexbot-closed-label')).toBeInTheDocument();
    expect(screen.getByTestId('strike-mover-ladder-empty')).toHaveTextContent(
      "No Classic GEX winners in the session's last 5 min (0DTE)",
    );
    expect(
      screen.queryByTestId('strike-mover-ladder-row-6600'),
    ).not.toBeInTheDocument();
  });

  it('reads "session closed" on the expected-move tile when the load finds no row', () => {
    // A reload after the close: the expected-move view keeps its 5-minute
    // window, so it answers empty while the snapshots still carry the capture.
    answerViews({
      'snapshots-latest': {
        rows: [snapshotRow('SPX', 6600)],
        asOf: FRIDAY_CLOSE,
      },
      'expected-move': { rows: [], asOf: null },
    });
    render(<GexbotSection marketOpen={false} spxSpot={null} />);
    expect(screen.getByTestId('gexbot-closed-label')).toBeInTheDocument();
    expect(screen.getByTestId('expected-move-range')).toHaveTextContent(
      'session closed',
    );
    expect(
      screen.queryByTestId('expected-move-tile-empty'),
    ).not.toBeInTheDocument();
  });

  it('shows the closed line of the Charm Clock under the label', () => {
    answerViews({
      'snapshots-latest': {
        rows: [snapshotRow('SPX', 6600)],
        asOf: FRIDAY_CLOSE,
      },
    });
    render(<GexbotSection marketOpen={false} spxSpot={null} />);
    expect(screen.getByTestId('charm-clock-closed')).toBeInTheDocument();
  });
});
