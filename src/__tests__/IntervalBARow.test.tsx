/**
 * IntervalBARow unit tests — pragmatic smoke + key-interaction coverage.
 *
 * Hooks that fetch chart data (useContractTape, useNetFlowHistory,
 * useTickerCandles) are mocked so we can drive the expanded-panel
 * branches deterministically. The two chart components are stubbed for
 * the same reason — internal recharts/lightweight-charts layout isn't
 * what we're testing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { IntervalBAFeedAlert } from '../hooks/useIntervalBAFeed';
import {
  genericElementsWithAriaLabel,
  srHintText,
  titledGenericsWithoutHint,
} from './helpers/aria';

/**
 * The most a hint on an element that repeats in every row may say. A feed of
 * rows is read one row after another, so a long explanation stays on the
 * title.
 */
const MAX_ROW_HINT = 60;

// ── Mocks ─────────────────────────────────────────────────────────────

const { mockUseContractTape, mockUseNetFlowHistory, mockUseTickerCandles } =
  vi.hoisted(() => ({
    mockUseContractTape: vi.fn(),
    mockUseNetFlowHistory: vi.fn(),
    mockUseTickerCandles: vi.fn(),
  }));

vi.mock('../hooks/useContractTape', () => ({
  useContractTape: mockUseContractTape,
}));
vi.mock('../hooks/useNetFlowHistory', () => ({
  useNetFlowHistory: mockUseNetFlowHistory,
}));
vi.mock('../hooks/useTickerCandles', () => ({
  useTickerCandles: mockUseTickerCandles,
}));

vi.mock('../components/charts/ContractTapeChart', () => ({
  ContractTapeChart: ({ ariaLabel }: { ariaLabel: string }) => (
    <div data-testid="contract-tape-chart" aria-label={ariaLabel} />
  ),
}));
vi.mock('../components/charts/TickerNetFlowChart', () => ({
  TickerNetFlowChart: ({
    ariaLabel,
    symbol,
  }: {
    ariaLabel: string;
    symbol?: string;
  }) => (
    <div
      data-testid="ticker-netflow-chart"
      aria-label={ariaLabel}
      data-symbol={symbol}
    />
  ),
}));

// Static import AFTER mocks so the mocks are registered first.
import { IntervalBARow } from '../components/IntervalBAFeed/IntervalBARow';

// ── Fixture factory ───────────────────────────────────────────────────

function makeAlert(
  overrides: Partial<IntervalBAFeedAlert> = {},
): IntervalBAFeedAlert {
  return {
    id: 1,
    option_chain: 'SPXW260327C05800000',
    ticker: 'SPXW',
    option_type: 'C',
    strike: 5800,
    expiry: '2026-03-27',
    bucket_start: '2026-03-27T17:05:00.000Z',
    bucket_end: '2026-03-27T17:10:00.000Z',
    fired_at: '2026-03-27T17:06:24.000Z',
    ratio_pct: 85.5,
    ask_premium: 1_200_000,
    total_premium: 1_400_000,
    trade_count: 8,
    top_trade_premium: 600_000,
    top_trade_size: 1000,
    top_trade_executed_at: '2026-03-27T17:06:23.000Z',
    top_trade_is_sweep: false,
    top_trade_is_floor: false,
    underlying_price: 5795,
    confluence_tickers: [],
    severity: 'extreme',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseContractTape.mockReturnValue({
    data: { series: [] },
    loading: false,
    error: null,
    fetchedAt: null,
    refresh: vi.fn(),
  });
  mockUseNetFlowHistory.mockReturnValue({
    data: { series: [] },
    loading: false,
    error: null,
    fetchedAt: null,
    refresh: vi.fn(),
  });
  mockUseTickerCandles.mockReturnValue({
    data: null,
    loading: false,
    error: null,
    fetchedAt: null,
    refresh: vi.fn(),
  });
});

function renderRow(alert: IntervalBAFeedAlert) {
  return render(
    <IntervalBARow alert={alert} date="2026-03-27" marketOpen={false} />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('IntervalBARow — summary line', () => {
  it('renders ticker, strike, CALL pill, severity, ratio + premium', () => {
    renderRow(makeAlert());
    expect(screen.getByText('SPXW')).toBeInTheDocument();
    expect(screen.getByText('5800')).toBeInTheDocument();
    expect(screen.getByText('CALL')).toBeInTheDocument();
    expect(screen.getByText('EXTREME')).toBeInTheDocument();
    expect(screen.getByText(/86%/)).toBeInTheDocument(); // ratio.toFixed(0)
    expect(screen.getByText('$1.40M')).toBeInTheDocument(); // total premium
  });

  it('renders the PUT pill when option_type is P', () => {
    renderRow(makeAlert({ option_type: 'P', strike: 5790 }));
    expect(screen.getByText('PUT')).toBeInTheDocument();
  });

  it.each([
    ['critical' as const, 'CRITICAL'],
    ['warning' as const, 'WARNING'],
  ])('renders %s severity label', (severity, label) => {
    renderRow(makeAlert({ severity }));
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('shows ATM pill when spot is within ±0.05% of strike', () => {
    renderRow(makeAlert({ strike: 5800, underlying_price: 5800 }));
    expect(screen.getByText('ATM')).toBeInTheDocument();
  });

  it('shows ITM pill when call strike is below spot', () => {
    renderRow(makeAlert({ strike: 5700, underlying_price: 5800 }));
    expect(screen.getByText(/^ITM/)).toBeInTheDocument();
  });

  it('shows ITM pill for a put with strike above spot', () => {
    renderRow(
      makeAlert({ option_type: 'P', strike: 5900, underlying_price: 5800 }),
    );
    expect(screen.getByText(/^ITM/)).toBeInTheDocument();
  });

  // The title is the whole sentence and has not changed. The hint is only the
  // part the pill does not already show: the pill reads "ITM 1.7%", so the
  // hint leaves out "Call is ITM by 1.7% —" and adds the spot / strike
  // relation (and, for an OTM pill, how far it is from ITM).
  it.each([
    [
      'ATM',
      { strike: 5800, underlying_price: 5800 },
      /^ATM$/,
      'ATM — spot 5800.00 is within ±0.05% of strike 5800.',
      'spot 5800.00 is within ±0.05% of strike 5800.',
    ],
    [
      'ITM call',
      { strike: 5700, underlying_price: 5800 },
      /^ITM 1\.7%$/,
      'Call is ITM by 1.7% — spot 5800.00 > strike 5700.',
      'spot 5800.00 > strike 5700.',
    ],
    [
      'OTM call',
      { strike: 5900, underlying_price: 5800 },
      /^OTM 1\.7%$/,
      'Call is OTM by 1.7% — spot 5800.00 < strike 5900. Needs 100.00 pts of upside to go ITM.',
      'spot 5800.00 < strike 5900. Needs 100.00 pts of upside to go ITM.',
    ],
    [
      'ITM put',
      { option_type: 'P' as const, strike: 5900, underlying_price: 5800 },
      /^ITM 1\.7%$/,
      'Put is ITM by 1.7% — spot 5800.00 < strike 5900.',
      'spot 5800.00 < strike 5900.',
    ],
    [
      'OTM put',
      { option_type: 'P' as const, strike: 5700, underlying_price: 5800 },
      /^OTM 1\.7%$/,
      'Put is OTM by 1.7% — spot 5800.00 > strike 5700. Needs 100.00 pts of downside to go ITM.',
      'spot 5800.00 > strike 5700. Needs 100.00 pts of downside to go ITM.',
    ],
  ])(
    'explains the %s pill in a hidden hint that does not repeat the pill, not an aria-label, and keeps the title',
    (_name, overrides, pillText, title, hint) => {
      const { container } = renderRow(makeAlert(overrides));
      // The pill is a bare span: ARIA 1.2 prohibits naming it, so its
      // explanation sits inside it as a SrHint.
      const pill = screen.getByText(pillText);
      expect(srHintText(pill)).toBe(hint);
      expect(pill).not.toHaveAttribute('aria-label');
      expect(pill).toHaveAttribute('title', title);
      expect(genericElementsWithAriaLabel(container)).toEqual([]);
    },
  );

  it('hides the moneyness pill when underlying_price is missing', () => {
    renderRow(makeAlert({ underlying_price: null }));
    expect(screen.queryByText(/ATM|ITM|OTM/)).not.toBeInTheDocument();
  });

  // The pill reads "EXTREME", and the title keeps its whole sentence. The hint
  // is the premium band and its place in the tiers, which the label does not
  // say. None of the hints says "floor": the flag test below queries /floor/.
  it.each([
    [
      'extreme' as const,
      'EXTREME',
      'EXTREME — bucket total premium ≥ $1M. The highest tier; an aggregate this large in a 5-min ask-side bucket is structurally rare for SPX/SPXW/SPY/QQQ.',
      'bucket total premium at least $1M, the highest tier',
    ],
    [
      'critical' as const,
      'CRITICAL',
      'CRITICAL — bucket total premium $500K–$1M. Above the noise floor; meaningful concentration of ask-side buying.',
      'bucket total premium $500K to $1M, the middle tier',
    ],
    [
      'warning' as const,
      'WARNING',
      'WARNING — bucket total premium $250K–$500K. Cleared the $250K floor + ≥75% ask ratio, but smaller-tier conviction than CRITICAL/EXTREME.',
      'bucket total premium $250K to $500K, the lowest tier',
    ],
  ])(
    'explains the %s severity pill in a short hidden hint, not an aria-label, and keeps the title',
    (severity, label, title, hint) => {
      const { container } = renderRow(makeAlert({ severity }));
      const pill = screen.getByText(label);
      expect(srHintText(pill)).toBe(hint);
      expect(srHintText(pill)!.length).toBeLessThanOrEqual(MAX_ROW_HINT);
      expect(pill).toHaveAttribute('title', title);
      expect(pill).not.toHaveAttribute('aria-label');
      expect(genericElementsWithAriaLabel(container)).toEqual([]);
    },
  );

  it.each([
    [
      'C' as const,
      'CALL',
      'CALL — ask-side buyers paid up for upside calls. Bullish directional bet.',
      'buyers paid the ask for upside, bullish',
    ],
    [
      'P' as const,
      'PUT',
      'PUT — ask-side buyers paid up for downside puts. Bearish directional bet.',
      'buyers paid the ask for downside, bearish',
    ],
  ])(
    'explains the %s side pill in a short hidden hint, not an aria-label, and keeps the title',
    (optionType, label, title, hint) => {
      const { container } = renderRow(makeAlert({ option_type: optionType }));
      const pill = screen.getByText(label);
      expect(srHintText(pill)).toBe(hint);
      // The pill already says CALL or PUT, so the hint does not
      expect(srHintText(pill)).not.toMatch(new RegExp(label, 'i'));
      expect(srHintText(pill)!.length).toBeLessThanOrEqual(MAX_ROW_HINT);
      expect(pill).toHaveAttribute('title', title);
      expect(pill).not.toHaveAttribute('aria-label');
      expect(genericElementsWithAriaLabel(container)).toEqual([]);
    },
  );

  it('renders the +PARTNER pill (alphabetically sorted) when confluence_tickers is populated', () => {
    renderRow(makeAlert({ confluence_tickers: ['SPY', 'QQQ'] }));
    expect(screen.getByText('+QQQ +SPY')).toBeInTheDocument();
  });

  // The title is the definition only. It used to add a CALL hit-rate lift
  // (53% solo to 61% with a partner) measured on SPXW calls in one backfill:
  // the pill also shows on puts, SPY and QQQ, and the live alerts did not
  // show the lift.
  it('explains the confluence pill in a short hidden hint and a title that is only the definition', () => {
    const { container } = renderRow(
      makeAlert({ confluence_tickers: ['SPY', 'QQQ'] }),
    );
    const pill = screen.getByText('+QQQ +SPY');
    expect(srHintText(pill)).toBe(
      'cross-symbol confluence within about 90 seconds',
    );
    expect(srHintText(pill)!.length).toBeLessThanOrEqual(MAX_ROW_HINT);
    expect(pill).toHaveAttribute(
      'title',
      'Cross-symbol confluence — SPY + QQQ fired same-direction within ~90s of this alert.',
    );
    expect(pill.getAttribute('title')).not.toMatch(/hit-rate|backfill|%/);
    expect(pill).not.toHaveAttribute('aria-label');
    expect(genericElementsWithAriaLabel(container)).toEqual([]);
  });

  // The block shows "86%" over "ratio"; the title's whole sentence stays. The
  // hint is the definition and the bar, without the word "ratio" again.
  it('explains the ratio block in a short hidden hint, the last child of the block that holds the title', () => {
    const { container } = renderRow(makeAlert({ ratio_pct: 85.5 }));
    const block = screen.getByText('ratio').parentElement!;
    expect(block).toHaveAttribute(
      'title',
      'Ask-side premium ÷ total bucket premium. ≥75% is the structural-anomaly threshold for SPX/SPY/QQQ — informed-flow conviction signature.',
    );
    expect(srHintText(block)).toBe(
      'ask-side share of bucket premium; 75% is the anomaly bar',
    );
    expect(srHintText(block)!.length).toBeLessThanOrEqual(MAX_ROW_HINT);
    expect(block).not.toHaveAttribute('aria-label');
    expect(genericElementsWithAriaLabel(container)).toEqual([]);
  });

  // Every titled span in a row, in both states, reaches a screen reader.
  it.each([
    ['collapsed', false],
    ['expanded', true],
  ])('leaves no titled generic without a hint when %s', (_state, expand) => {
    const { container } = renderRow(
      makeAlert({
        confluence_tickers: ['SPY', 'QQQ'],
        strike: 5900,
        underlying_price: 5800,
      }),
    );
    if (expand) {
      fireEvent.click(
        screen.getByRole('button', { name: /Expand charts for SPXW/i }),
      );
    }
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });

  it('omits the confluence pill when the array is empty', () => {
    renderRow(makeAlert({ confluence_tickers: [] }));
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });

  it('renders sweep + floor flag tail when both top_trade flags are true', () => {
    renderRow(
      makeAlert({ top_trade_is_sweep: true, top_trade_is_floor: true }),
    );
    expect(screen.getByText(/sweep/)).toBeInTheDocument();
    expect(screen.getByText(/floor/)).toBeInTheDocument();
  });

  it('renders only "top" when no flags are set', () => {
    const { container } = renderRow(
      makeAlert({ top_trade_is_sweep: false, top_trade_is_floor: false }),
    );
    expect(container.textContent).toContain('top');
    expect(container.textContent).not.toContain('sweep');
    expect(container.textContent).not.toContain('floor');
  });

  it('renders the underlying spot block', () => {
    renderRow(makeAlert({ underlying_price: 5795 }));
    expect(screen.getByText('5795')).toBeInTheDocument();
    expect(screen.getByText('spx')).toBeInTheDocument();
  });

  // The spot is the row's own underlying: the index for SPXW, the ETF price for
  // SPY and QQQ. A "spx" caption under an ETF price read as an index level.
  it.each([
    {
      ticker: 'SPXW',
      chain: 'SPXW260327C05800000',
      price: 5795,
      caption: 'spx',
    },
    { ticker: 'SPY', chain: 'SPY260327C00580000', price: 579, caption: 'spy' },
    { ticker: 'QQQ', chain: 'QQQ260327C00480000', price: 481, caption: 'qqq' },
  ])(
    'captions the $ticker row spot as "$caption"',
    ({ ticker, chain, price, caption }) => {
      renderRow(
        makeAlert({
          ticker,
          option_chain: chain,
          underlying_price: price,
        }),
      );
      expect(screen.getByText(caption)).toBeInTheDocument();
      for (const other of ['spx', 'spy', 'qqq'].filter((c) => c !== caption)) {
        expect(screen.queryByText(other)).not.toBeInTheDocument();
      }
    },
  );

  // An ETF trades in cents, so SPY and QQQ show the spot to the cent; the index
  // shows whole points. The caption test above does not look at the number.
  it.each([
    {
      ticker: 'SPY',
      chain: 'SPY260327C00580000',
      price: 579.43,
      shown: '579.43',
    },
    {
      ticker: 'QQQ',
      chain: 'QQQ260327C00512000',
      price: 512.1,
      shown: '512.10',
    },
    {
      ticker: 'SPXW',
      chain: 'SPXW260327C06850000',
      price: 6850.37,
      shown: '6850',
    },
  ])(
    'shows the $ticker row spot $price as "$shown"',
    ({ ticker, chain, price, shown }) => {
      renderRow(
        makeAlert({
          ticker,
          option_chain: chain,
          underlying_price: price,
        }),
      );
      expect(screen.getByText(shown)).toBeInTheDocument();
    },
  );

  it('omits the underlying spot block when missing', () => {
    renderRow(makeAlert({ underlying_price: null }));
    expect(screen.queryByText('spx')).not.toBeInTheDocument();
  });

  it('omits the underlying spot caption on an ETF row when the spot is missing', () => {
    renderRow(
      makeAlert({
        ticker: 'SPY',
        option_chain: 'SPY260327C00580000',
        underlying_price: null,
      }),
    );
    expect(screen.queryByText('spy')).not.toBeInTheDocument();
  });

  it('omits the top trade block when top_trade_premium is null', () => {
    renderRow(makeAlert({ top_trade_premium: null }));
    expect(screen.queryByText('top')).not.toBeInTheDocument();
  });

  it('renders 1 trade as singular not plural', () => {
    renderRow(makeAlert({ trade_count: 1 }));
    expect(screen.getByText(/1 trade$/)).toBeInTheDocument();
  });
});

describe('IntervalBARow — UW deep link', () => {
  it('renders an external link to the per-contract Unusual Whales page', () => {
    renderRow(makeAlert({ option_chain: 'SPXW260327C05800000' }));
    const link = screen.getByLabelText(
      /Open SPXW260327C05800000 on Unusual Whales/i,
    );
    expect(link.getAttribute('href')).toContain(
      'unusualwhales.com/flow/option_chains?chain=SPXW260327C05800000',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('IntervalBARow — expand toggle', () => {
  it('starts collapsed and exposes an expand button', () => {
    renderRow(makeAlert());
    expect(
      screen.getByRole('button', { name: /Expand charts for SPXW/i }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('contract-tape-chart')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('ticker-netflow-chart'),
    ).not.toBeInTheDocument();
  });

  it('renders both chart panels when expanded', async () => {
    renderRow(makeAlert());
    fireEvent.click(
      screen.getByRole('button', { name: /Expand charts for SPXW/i }),
    );
    expect(screen.getByTestId('contract-tape-chart')).toBeInTheDocument();
    // The net-flow chart is lazy (see IntervalBARow.lazy-chart.test.tsx).
    expect(
      await screen.findByTestId('ticker-netflow-chart'),
    ).toBeInTheDocument();
  });

  it('shows a loading hint in the tape panel while the tape series is empty + loading', () => {
    mockUseContractTape.mockReturnValue({
      data: { series: [] },
      loading: true,
      error: null,
      fetchedAt: null,
      refresh: vi.fn(),
    });
    renderRow(makeAlert());
    fireEvent.click(
      screen.getByRole('button', { name: /Expand charts for SPXW/i }),
    );
    expect(screen.getByText(/Loading tape/i)).toBeInTheDocument();
  });

  it('surfaces a tape error message in the expanded tape panel', () => {
    mockUseContractTape.mockReturnValue({
      data: { series: [] },
      loading: false,
      error: 'feed unavailable',
      fetchedAt: null,
      refresh: vi.fn(),
    });
    renderRow(makeAlert());
    fireEvent.click(
      screen.getByRole('button', { name: /Expand charts for SPXW/i }),
    );
    expect(
      screen.getByText(/tape error: feed unavailable/i),
    ).toBeInTheDocument();
  });

  it('surfaces a net-flow error message in the expanded flow panel', () => {
    mockUseNetFlowHistory.mockReturnValue({
      data: { series: [] },
      loading: false,
      error: 'pg down',
      fetchedAt: null,
      refresh: vi.fn(),
    });
    renderRow(makeAlert());
    fireEvent.click(
      screen.getByRole('button', { name: /Expand charts for SPXW/i }),
    );
    expect(screen.getByText(/net flow error: pg down/i)).toBeInTheDocument();
  });

  it('renders aggregated tape stats (bid, mid, ask, avg fill) when tape series has data', () => {
    mockUseContractTape.mockReturnValue({
      data: {
        series: [
          {
            ts: '2026-03-27T17:00:00Z',
            bidVol: 100,
            midVol: 50,
            askVol: 800,
            noSideVol: 0,
            totalVol: 950,
            avgPrice: 2.5,
          },
          {
            ts: '2026-03-27T17:01:00Z',
            bidVol: 200,
            midVol: 100,
            askVol: 1700,
            noSideVol: 50,
            totalVol: 2050,
            avgPrice: 3.5,
          },
        ],
      },
      loading: false,
      error: null,
      fetchedAt: null,
      refresh: vi.fn(),
    });
    renderRow(makeAlert());
    fireEvent.click(
      screen.getByRole('button', { name: /Expand charts for SPXW/i }),
    );
    expect(screen.getByText('Bid')).toBeInTheDocument();
    expect(screen.getByText('Ask')).toBeInTheDocument();
    expect(screen.getByText('Mid')).toBeInTheDocument();
    expect(screen.getByText(/Avg fill/i)).toBeInTheDocument();
  });

  it('renders the net-flow chart wired with the ticker symbol when series has data', async () => {
    // The cumulative NCP/NPP/Δ header now lives inside TickerNetFlowChart
    // (covered by its own unit tests). Here we verify the row wires the
    // chart up with the ticker symbol so that header can render.
    mockUseNetFlowHistory.mockReturnValue({
      data: {
        series: [
          { ts: '2026-03-27T17:00:00Z', cumNcp: 1_000_000, cumNpp: 400_000 },
        ],
      },
      loading: false,
      error: null,
      fetchedAt: null,
      refresh: vi.fn(),
    });
    renderRow(makeAlert());
    fireEvent.click(
      screen.getByRole('button', { name: /Expand charts for SPXW/i }),
    );
    const chart = await screen.findByTestId('ticker-netflow-chart');
    expect(chart).toBeInTheDocument();
    expect(chart).toHaveAttribute('data-symbol', 'SPXW');
  });
});

// The expanded panel repeats the contract in its header: the side as one
// letter and the moneyness pill. Each keeps its title, and a hidden hint
// carries it to a screen reader.
describe('IntervalBARow — detail panel hints', () => {
  // This file's two stub charts are each a `<div aria-label>`, a bare generic
  // the scan would report. They are test scaffolding, not the row's own
  // markup. The net-flow stub is lazy: it renders at once once an earlier test
  // in the file has loaded it, so both are excluded, not only the tape stub.
  // A snippet is the element's own opening tag (and what follows, cut at 160
  // characters), so `startsWith` drops only a stub's own snippet. A snippet
  // that merely contains a stub, an ancestor of it with an aria-label, stays.
  const STUB_CHARTS = ['contract-tape-chart', 'ticker-netflow-chart'];
  const withoutStubChart = (snippets: string[]) =>
    snippets.filter(
      (s) =>
        !STUB_CHARTS.some((id) => s.startsWith(`<div data-testid="${id}"`)),
    );

  /** The contract tape panel, which holds the header's letter and pill. */
  function openTapePanel(alert: IntervalBAFeedAlert) {
    const view = renderRow(alert);
    fireEvent.click(
      screen.getByRole('button', { name: /Expand charts for SPXW/i }),
    );
    return {
      ...view,
      panel: screen.getByTestId('contract-tape-chart').parentElement!,
    };
  }

  it.each([
    ['C' as const, 'C', 'Call', 'call'],
    ['P' as const, 'P', 'Put', 'put'],
  ])(
    'explains the %s side letter in a hidden hint, not an aria-label, and keeps the title',
    (optionType, letter, title, hint) => {
      const { container, panel } = openTapePanel(
        makeAlert({ option_type: optionType }),
      );
      const el = within(panel).getByText(letter);
      expect(srHintText(el)).toBe(hint);
      expect(srHintText(el)!.length).toBeLessThanOrEqual(MAX_ROW_HINT);
      expect(el).toHaveAttribute('title', title);
      expect(el).not.toHaveAttribute('aria-label');
      expect(withoutStubChart(genericElementsWithAriaLabel(container))).toEqual(
        [],
      );
      expect(titledGenericsWithoutHint(container)).toEqual([]);
    },
  );

  // The same pill as the summary line's: the same title, and the same hint
  // (moneyness.srText), which leaves out the pill's own words.
  it.each([
    [
      'ATM',
      { strike: 5800, underlying_price: 5800 },
      /^ATM$/,
      'ATM — spot 5800.00 is within ±0.05% of strike 5800.',
      'spot 5800.00 is within ±0.05% of strike 5800.',
    ],
    [
      'ITM call',
      { strike: 5700, underlying_price: 5800 },
      /^ITM 1\.7%$/,
      'Call is ITM by 1.7% — spot 5800.00 > strike 5700.',
      'spot 5800.00 > strike 5700.',
    ],
    [
      'OTM put',
      { option_type: 'P' as const, strike: 5700, underlying_price: 5800 },
      /^OTM 1\.7%$/,
      'Put is OTM by 1.7% — spot 5800.00 > strike 5700. Needs 100.00 pts of downside to go ITM.',
      'spot 5800.00 > strike 5700. Needs 100.00 pts of downside to go ITM.',
    ],
  ])(
    'explains the %s moneyness pill in a hidden hint that does not repeat the pill, and keeps the title',
    (_name, overrides, pillText, title, hint) => {
      const { container, panel } = openTapePanel(makeAlert(overrides));
      const pill = within(panel).getByText(pillText);
      expect(srHintText(pill)).toBe(hint);
      expect(pill).toHaveAttribute('title', title);
      expect(pill).not.toHaveAttribute('aria-label');
      expect(withoutStubChart(genericElementsWithAriaLabel(container))).toEqual(
        [],
      );
      expect(titledGenericsWithoutHint(container)).toEqual([]);
    },
  );

  it('shows no moneyness pill in the panel when underlying_price is missing', () => {
    const { panel } = openTapePanel(makeAlert({ underlying_price: null }));
    expect(within(panel).queryByText(/ATM|ITM|OTM/)).not.toBeInTheDocument();
  });
});
