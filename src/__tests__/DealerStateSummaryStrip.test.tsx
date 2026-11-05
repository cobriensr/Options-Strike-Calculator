import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { DealerStateSummaryStrip } from '../components/Gexbot/DealerStateSummaryStrip';
import { dealerClaims } from './helpers/dealer-claims';
import type { SnapshotsLatestRow, VelocityRow } from '../hooks/useGexbotData';

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

function makeRow(
  ticker: string,
  overrides: Partial<SnapshotsLatestRow> = {},
): SnapshotsLatestRow {
  return {
    ticker,
    capturedAt: '2026-05-19T19:30:00Z',
    spot: null,
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
    minDte: 0,
    ...overrides,
  };
}

function makeVelocity(
  ticker: string,
  overrides: Partial<VelocityRow> = {},
): VelocityRow {
  return {
    ticker,
    capturedAt: '2026-10-29T14:04:00Z',
    minDte: 0,
    dAggDex: null,
    dZgr: null,
    dZcvr: null,
    typicalAbsDAggDex: null,
    ...overrides,
  };
}

interface HookState {
  rows: unknown[];
  loading: boolean;
  error: string | null;
  freshestAt: string | null;
}

const EMPTY_VELOCITY: HookState = {
  rows: [],
  loading: false,
  error: null,
  freshestAt: null,
};

/** The strip reads two views: snapshots-latest (tiles) and velocity (LOUDEST). */
function mockViews(snapshots: HookState, velocity: HookState = EMPTY_VELOCITY) {
  mockUseGexbotData.mockImplementation((spec: { view: string }) =>
    spec.view === 'velocity' ? velocity : snapshots,
  );
}

function velocityState(rows: VelocityRow[]): HookState {
  return { rows, loading: false, error: null, freshestAt: null };
}

describe('<DealerStateSummaryStrip>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
  });

  it('shows a loading chip while loading', () => {
    mockViews({
      rows: [],
      loading: true,
      error: null,
      freshestAt: null,
    });
    render(<DealerStateSummaryStrip marketOpen />);
    expect(
      screen.getByTestId('dealer-state-summary-strip-loading'),
    ).toBeInTheDocument();
  });

  it('shows an error chip when the hook surfaces an error', () => {
    mockViews({
      rows: [],
      loading: false,
      error: 'HTTP 500',
      freshestAt: null,
    });
    render(<DealerStateSummaryStrip marketOpen />);
    expect(
      screen.getByTestId('dealer-state-summary-strip-error'),
    ).toHaveTextContent(/HTTP 500/);
  });

  it('shows an empty chip when there are no rows', () => {
    mockViews({
      rows: [],
      loading: false,
      error: null,
      freshestAt: null,
    });
    render(<DealerStateSummaryStrip marketOpen />);
    expect(
      screen.getByTestId('dealer-state-summary-strip-empty'),
    ).toBeInTheDocument();
  });

  it('renders all four tiles on a full payload', () => {
    mockViews(
      {
        rows: [
          makeRow('SPX', { spot: 5847, zeroGamma: 5820 }),
          makeRow('VIX', { spot: 14.3, zeroGamma: 15.8 }),
          makeRow('NDX', { spot: 19_200, zeroGamma: 19_100 }),
          makeRow('NQ_NDX', { spot: 19_210, zeroGamma: 19_080 }),
          makeRow('SPY', { spot: 584, zeroGamma: 582 }),
        ],
        loading: false,
        error: null,
        freshestAt: '2026-05-19T19:32:11Z',
      },
      velocityState([makeVelocity('NDX', { dAggDex: 2.5 })]),
    );
    render(<DealerStateSummaryStrip marketOpen />);
    expect(
      screen.getByTestId('dealer-state-summary-strip'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('dealer-state-strip-spx')).toBeInTheDocument();
    expect(screen.getByTestId('dealer-state-strip-vix')).toBeInTheDocument();
    expect(
      screen.getByTestId('dealer-state-strip-breadth'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('dealer-state-strip-loudest'),
    ).toBeInTheDocument();
  });

  it('renders SPX LONG γ when spot > zeroGamma', () => {
    mockViews({
      rows: [makeRow('SPX', { spot: 5847, zeroGamma: 5820 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T19:32:11Z',
    });
    render(<DealerStateSummaryStrip marketOpen />);
    const tile = screen.getByTestId('dealer-state-strip-spx');
    expect(tile).toHaveTextContent(/LONG γ/i);
    expect(tile.className).toMatch(/emerald/);
  });

  it('renders SPX SHORT γ when spot < zeroGamma', () => {
    mockViews({
      rows: [makeRow('SPX', { spot: 5800, zeroGamma: 5820 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T19:32:11Z',
    });
    render(<DealerStateSummaryStrip marketOpen />);
    const tile = screen.getByTestId('dealer-state-strip-spx');
    expect(tile).toHaveTextContent(/SHORT γ/i);
    expect(tile.className).toMatch(/rose/);
  });

  it('renders VIX SHORT γ when VIX spot < zeroGamma (vol expansion regime)', () => {
    mockViews({
      rows: [makeRow('VIX', { spot: 14.3, zeroGamma: 15.8 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T19:32:11Z',
    });
    render(<DealerStateSummaryStrip marketOpen />);
    const tile = screen.getByTestId('dealer-state-strip-vix');
    expect(tile).toHaveTextContent(/SHORT γ/i);
  });

  it('shows "—" in SPX tile when the SPX row is missing but VIX is present', () => {
    mockViews({
      rows: [makeRow('VIX', { spot: 14.3, zeroGamma: 15.8 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T19:32:11Z',
    });
    render(<DealerStateSummaryStrip marketOpen />);
    const tile = screen.getByTestId('dealer-state-strip-spx');
    expect(within(tile).getByText('—')).toBeInTheDocument();
  });

  it('counts cross-asset breadth as long vs short majorities', () => {
    mockViews({
      rows: [
        makeRow('SPX', { spot: 5847, zeroGamma: 5820 }), // long
        makeRow('NDX', { spot: 19_200, zeroGamma: 19_100 }), // long
        makeRow('SPY', { spot: 584, zeroGamma: 582 }), // long
        makeRow('VIX', { spot: 14, zeroGamma: 15 }), // short
        makeRow('IWM', { spot: 210, zeroGamma: 212 }), // short
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T19:32:11Z',
    });
    render(<DealerStateSummaryStrip marketOpen />);
    const tile = screen.getByTestId('dealer-state-strip-breadth');
    // 3 long, 2 short, 9 unknown across the 14 distinct underlyings.
    expect(tile).toHaveTextContent(/3 \/ 14/);
    expect(tile).toHaveTextContent(/LONG γ/i);
  });

  describe('LOUDEST tile (velocity view)', () => {
    const SNAP: HookState = {
      rows: [makeRow('SPX', { spot: 5847, zeroGamma: 5820 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T19:32:11Z',
    };
    const tile = () => screen.getByTestId('dealer-state-strip-loudest');

    it('reads the velocity view as well as snapshots-latest', () => {
      mockViews(SNAP);
      render(<DealerStateSummaryStrip marketOpen />);
      expect(mockUseGexbotData).toHaveBeenCalledWith(
        { view: 'snapshots-latest' },
        true,
      );
      expect(mockUseGexbotData).toHaveBeenCalledWith(
        { view: 'velocity' },
        true,
      );
    });

    it('picks the highest ratio to its own typical minute, not the highest raw change', () => {
      // SPX 1.0 / 0.5 = 2x. HYG 0.9 / max(0, 0.25) = 3.6x. HYG wins.
      mockViews(
        SNAP,
        velocityState([
          makeVelocity('SPX', { dAggDex: 1.0, typicalAbsDAggDex: 0.5 }),
          makeVelocity('HYG', { dAggDex: 0.9, typicalAbsDAggDex: 0 }),
        ]),
      );
      render(<DealerStateSummaryStrip marketOpen />);
      expect(tile()).toHaveTextContent(/HYG/);
      expect(tile()).not.toHaveTextContent(/SPX/);
      expect(tile()).toHaveTextContent(/3\.6× typical/);
    });

    it('skips rows with a null change', () => {
      mockViews(
        SNAP,
        velocityState([
          makeVelocity('SPX', { dAggDex: null, typicalAbsDAggDex: 0.1 }),
          makeVelocity('QQQ', { dAggDex: 0.5, typicalAbsDAggDex: 0.5 }),
        ]),
      );
      render(<DealerStateSummaryStrip marketOpen />);
      expect(tile()).toHaveTextContent(/QQQ/);
      expect(tile()).not.toHaveTextContent(/SPX/);
    });

    it('ignores the futures views however large their change', () => {
      mockViews(
        SNAP,
        velocityState([
          makeVelocity('ES_SPX', { dAggDex: 900, typicalAbsDAggDex: 0 }),
          makeVelocity('NQ_NDX', { dAggDex: -900, typicalAbsDAggDex: 0 }),
          makeVelocity('NDX', { dAggDex: 1, typicalAbsDAggDex: 1 }),
        ]),
      );
      render(<DealerStateSummaryStrip marketOpen />);
      expect(tile()).toHaveTextContent(/NDX/);
      expect(tile()).not.toHaveTextContent(/NQ_NDX|ES_SPX/);
    });

    it.each([
      ['no rows', []],
      [
        'only null changes (first minute of the session)',
        [makeVelocity('SPX'), makeVelocity('QQQ')],
      ],
      ['only zero changes', [makeVelocity('SPX', { dAggDex: 0 })]],
    ])('shows the empty state for %s', (_name, rows) => {
      mockViews(SNAP, velocityState(rows));
      render(<DealerStateSummaryStrip marketOpen />);
      expect(tile()).toHaveTextContent(/LOUDEST · —/);
      expect(within(tile()).getByText('—')).toBeInTheDocument();
    });

    it('shows the empty state while the velocity read is loading or failed', () => {
      for (const velocity of [
        { rows: [], loading: true, error: null, freshestAt: null },
        { rows: [], loading: false, error: 'HTTP 500', freshestAt: null },
      ]) {
        mockViews(SNAP, velocity);
        const { unmount } = render(<DealerStateSummaryStrip marketOpen />);
        expect(tile()).toHaveTextContent(/LOUDEST · —/);
        unmount();
      }
    });

    it('does not use the vendor one-step dexoflow in snapshots', () => {
      mockViews(
        {
          ...SNAP,
          rows: [{ ...makeRow('SPX'), dexoflow: 9_000_000 }],
        },
        velocityState([]),
      );
      render(<DealerStateSummaryStrip marketOpen />);
      expect(tile()).toHaveTextContent(/LOUDEST · —/);
    });

    it('is labelled as the most unusual taker Δ per minute, not a raw size', () => {
      mockViews(
        SNAP,
        velocityState([
          makeVelocity('SPX', { dAggDex: 1.2, typicalAbsDAggDex: 0.4 }),
        ]),
      );
      render(<DealerStateSummaryStrip marketOpen />);
      expect(tile()).toHaveTextContent(/most unusual taker Δ \/ min/);
      expect(tile()).toHaveTextContent(/taker \+Δ flow \+1\.20/);
      expect(tile()).toHaveTextContent(/3\.0× typical/);
      expect(tile()).not.toHaveTextContent(/raw|cross-ticker/i);
    });

    it('shows a falling change as taker −Δ flow', () => {
      mockViews(
        SNAP,
        velocityState([
          makeVelocity('SPY', { dAggDex: -0.6, typicalAbsDAggDex: 0.3 }),
        ]),
      );
      render(<DealerStateSummaryStrip marketOpen />);
      expect(tile()).toHaveTextContent(/taker −Δ flow −0\.60/);
      expect(tile().className).toMatch(/rose/);
    });
  });

  it('does not double-count the ES_SPX / NQ_NDX futures views in breadth', () => {
    mockViews({
      rows: [
        makeRow('SPX', { spot: 5847, zeroGamma: 5820 }), // long
        makeRow('ES_SPX', { spot: 5847, zeroGamma: 5820 }), // same data
        makeRow('NDX', { spot: 19_200, zeroGamma: 19_100 }), // long
        makeRow('NQ_NDX', { spot: 19_200, zeroGamma: 19_100 }), // same data
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T19:32:11Z',
    });
    render(<DealerStateSummaryStrip marketOpen />);
    const tile = screen.getByTestId('dealer-state-strip-breadth');
    expect(tile).toHaveTextContent(/2 \/ 14/);
    expect(tile).not.toHaveTextContent(/4 \/ /);
  });

  it('makes no dealer / market-maker claims in any state', () => {
    const velocity = velocityState([
      makeVelocity('SPX', { dAggDex: -3, typicalAbsDAggDex: 1 }),
    ]);
    mockViews(
      {
        rows: [
          makeRow('SPX', { spot: 5847, zeroGamma: 5820 }),
          makeRow('VIX', { spot: 14, zeroGamma: 15 }),
        ],
        loading: false,
        error: null,
        freshestAt: '2026-05-19T19:32:11Z',
      },
      velocity,
    );
    const { container, rerender } = render(
      <DealerStateSummaryStrip marketOpen />,
    );
    expect(container.textContent).toContain('most unusual');
    expect(dealerClaims(container.textContent ?? '')).toEqual([]);
    for (const state of [
      { rows: [], loading: true, error: null, freshestAt: null },
      { rows: [], loading: false, error: 'HTTP 500', freshestAt: null },
      { rows: [], loading: false, error: null, freshestAt: null },
    ]) {
      mockViews(state, velocity);
      rerender(<DealerStateSummaryStrip marketOpen />);
      expect(dealerClaims(container.textContent ?? '')).toEqual([]);
    }
  });
});
