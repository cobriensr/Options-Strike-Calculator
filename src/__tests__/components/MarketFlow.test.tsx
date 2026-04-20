import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import type {
  RankedStrike,
  DirectionalRollup,
  WhaleAlert,
  WhalePositioningData,
} from '../../types/flow';
import type {
  OptionsFlowData,
  UseOptionsFlowResult,
} from '../../hooks/useOptionsFlow';
import type { UseWhalePositioningResult } from '../../hooks/useWhalePositioning';

// ── Hoisted mocks ──────────────────────────────────────────

const { mockUseOptionsFlow, mockUseWhalePositioning } = vi.hoisted(() => ({
  mockUseOptionsFlow: vi.fn(),
  mockUseWhalePositioning: vi.fn(),
}));

vi.mock('../../hooks/useOptionsFlow', () => ({
  useOptionsFlow: mockUseOptionsFlow,
}));

vi.mock('../../hooks/useWhalePositioning', () => ({
  useWhalePositioning: mockUseWhalePositioning,
}));

// The four sub-section children render their own DOM; we only care
// about MarketFlow's orchestration so stub them to text sentinels.
vi.mock('../../components/OptionsFlow/FlowDirectionalRollup', () => ({
  FlowDirectionalRollup: (props: { alertCount: number }) => (
    <div data-testid="flow-rollup">rollup:{props.alertCount}</div>
  ),
}));

vi.mock('../../components/OptionsFlow/FlowConfluencePanel', () => ({
  FlowConfluencePanel: (props: {
    intradayStrikes: RankedStrike[];
    whaleAlerts: WhaleAlert[];
  }) => (
    <div data-testid="flow-confluence">
      confluence:{props.intradayStrikes.length}/{props.whaleAlerts.length}
    </div>
  ),
}));

vi.mock('../../components/OptionsFlow/OptionsFlowTable', () => ({
  OptionsFlowTable: (props: { strikes: RankedStrike[] }) => (
    <div data-testid="flow-table">table:{props.strikes.length}</div>
  ),
}));

vi.mock('../../components/OptionsFlow/WhalePositioningTable', () => ({
  WhalePositioningTable: (props: {
    alerts: WhaleAlert[];
    totalPremium: number;
  }) => (
    <div data-testid="whale-table">
      whales:{props.alerts.length}/{props.totalPremium}
    </div>
  ),
}));

import MarketFlow from '../../components/MarketFlow';

// ── Fixtures ───────────────────────────────────────────────

const EMPTY_ROLLUP: DirectionalRollup = {
  bullish_count: 0,
  bearish_count: 0,
  bullish_premium: 0,
  bearish_premium: 0,
  lean: 'neutral',
  confidence: 0,
  top_bullish_strike: null,
  top_bearish_strike: null,
};

function makeStrike(overrides: Partial<RankedStrike> = {}): RankedStrike {
  return {
    strike: 6900,
    type: 'call',
    distance_from_spot: 50,
    distance_pct: 0.0073,
    total_premium: 500_000,
    ask_side_ratio: 0.95,
    volume_oi_ratio: 0.31,
    hit_count: 4,
    has_ascending_fill: false,
    has_descending_fill: false,
    has_multileg: false,
    is_itm: false,
    score: 72.4,
    first_seen_at: '2026-04-15T14:30:00.000Z',
    last_seen_at: '2026-04-15T14:45:00.000Z',
    ...overrides,
  };
}

function makeWhale(overrides: Partial<WhaleAlert> = {}): WhaleAlert {
  return {
    option_chain: 'SPXW260420P06500000',
    strike: 6500,
    type: 'put',
    expiry: '2026-04-20',
    dte_at_alert: 5,
    created_at: '2026-04-15T14:40:00.000Z',
    age_minutes: 5,
    total_premium: 2_000_000,
    total_ask_side_prem: 1_800_000,
    total_bid_side_prem: 200_000,
    ask_side_ratio: 0.9,
    total_size: 500,
    volume: 1000,
    open_interest: 200,
    volume_oi_ratio: 5.0,
    has_sweep: true,
    has_floor: false,
    has_multileg: false,
    alert_rule: 'RepeatedHits',
    underlying_price: 7001,
    distance_from_spot: -501,
    distance_pct: -0.0716,
    is_itm: false,
    ...overrides,
  };
}

function makeOptionsFlow(
  overrides: Partial<OptionsFlowData> = {},
): UseOptionsFlowResult {
  const data: OptionsFlowData = {
    strikes: [],
    rollup: EMPTY_ROLLUP,
    spot: null,
    windowMinutes: 15,
    lastUpdated: null,
    alertCount: 0,
    timestamps: [],
    ...overrides,
  };
  return {
    data,
    isLoading: false,
    error: null,
    lastFetchedAt: new Date('2026-04-15T14:45:00.000Z'),
    refresh: vi.fn(),
  };
}

function makeWhaleResult(
  overrides: Partial<WhalePositioningData> = {},
): UseWhalePositioningResult {
  const data: WhalePositioningData = {
    strikes: [],
    totalPremium: 0,
    alertCount: 0,
    lastUpdated: null,
    spot: null,
    windowMinutes: 0,
    minPremium: 1_000_000,
    maxDte: 7,
    timestamps: [],
    ...overrides,
  };
  return {
    data,
    isLoading: false,
    error: null,
    lastFetchedAt: new Date('2026-04-15T14:45:00.000Z'),
    refresh: vi.fn(),
  };
}

// A non-April-fool's-DST day inside CDT so today-ET resolves stably.
const TODAY_ET = '2026-04-15';
const TODAY_NOON_UTC = new Date('2026-04-15T16:00:00.000Z');

function renderDefault(
  overrideProps: {
    marketOpen?: boolean;
    gexByStrike?: Map<number, number>;
  } = {},
) {
  return render(
    <MarketFlow
      marketOpen={overrideProps.marketOpen ?? true}
      gexByStrike={overrideProps.gexByStrike ?? new Map()}
    />,
  );
}

describe('MarketFlow', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(TODAY_NOON_UTC);
    mockUseOptionsFlow.mockReturnValue(makeOptionsFlow());
    mockUseWhalePositioning.mockReturnValue(makeWhaleResult());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Structure ───────────────────────────────────────────

  it('renders the container + all four sub-sections with correct labels', () => {
    renderDefault();

    expect(screen.getByText('Market Flow')).toBeInTheDocument();
    expect(screen.getByText('Flow Aggression')).toBeInTheDocument();
    expect(screen.getByText(/Retail.*Whale Confluence/i)).toBeInTheDocument();
    expect(screen.getByText('Options Flow')).toBeInTheDocument();
    expect(screen.getByText('Whale Positioning')).toBeInTheDocument();

    // Each sub-section body is mounted
    expect(screen.getByTestId('flow-rollup')).toBeInTheDocument();
    expect(screen.getByTestId('flow-confluence')).toBeInTheDocument();
    expect(screen.getByTestId('flow-table')).toBeInTheDocument();
    expect(screen.getByTestId('whale-table')).toBeInTheDocument();
  });

  it('passes todayET as selectedDate to both hooks on mount', () => {
    renderDefault();

    expect(mockUseOptionsFlow).toHaveBeenCalledWith({
      marketOpen: true,
      selectedDate: TODAY_ET,
      asOf: null,
    });
    expect(mockUseWhalePositioning).toHaveBeenCalledWith({
      marketOpen: true,
      selectedDate: TODAY_ET,
      asOf: null,
    });
  });

  // ── Flow aggression badge ───────────────────────────────

  it('renders CALL-HEAVY badge when aggressive call premium dominates', () => {
    const strikes = [
      makeStrike({
        type: 'call',
        ask_side_ratio: 0.9,
        total_premium: 1_000_000,
      }),
      makeStrike({
        type: 'call',
        ask_side_ratio: 0.88,
        total_premium: 500_000,
      }),
      makeStrike({ type: 'put', ask_side_ratio: 0.9, total_premium: 200_000 }),
    ];
    mockUseOptionsFlow.mockReturnValue(makeOptionsFlow({ strikes }));

    renderDefault();
    expect(screen.getByText('CALL-HEAVY')).toBeInTheDocument();
  });

  it('renders PUT-HEAVY badge when aggressive put premium dominates', () => {
    const strikes = [
      makeStrike({
        type: 'put',
        ask_side_ratio: 0.9,
        total_premium: 1_500_000,
      }),
      makeStrike({ type: 'call', ask_side_ratio: 0.9, total_premium: 300_000 }),
    ];
    mockUseOptionsFlow.mockReturnValue(makeOptionsFlow({ strikes }));

    renderDefault();
    expect(screen.getByText('PUT-HEAVY')).toBeInTheDocument();
  });

  it('renders BALANCED badge when aggressive premium is roughly even', () => {
    const strikes = [
      makeStrike({
        type: 'call',
        ask_side_ratio: 0.9,
        total_premium: 1_000_000,
      }),
      makeStrike({
        type: 'put',
        ask_side_ratio: 0.9,
        total_premium: 1_000_000,
      }),
    ];
    mockUseOptionsFlow.mockReturnValue(makeOptionsFlow({ strikes }));

    renderDefault();
    expect(screen.getByText('BALANCED')).toBeInTheDocument();
  });

  it('renders no aggression badge when no strikes are aggressive', () => {
    const strikes = [
      // ask_side_ratio below aggressive threshold
      makeStrike({ type: 'call', ask_side_ratio: 0.2 }),
      makeStrike({ type: 'put', ask_side_ratio: 0.3 }),
    ];
    mockUseOptionsFlow.mockReturnValue(makeOptionsFlow({ strikes }));

    renderDefault();
    expect(screen.queryByText(/CALL-HEAVY|PUT-HEAVY|BALANCED/)).toBeNull();
  });

  it('renders no aggression badge when strikes list is empty', () => {
    renderDefault();
    expect(screen.queryByText(/CALL-HEAVY|PUT-HEAVY|BALANCED/)).toBeNull();
  });

  // ── Confluence match-count badge ────────────────────────

  it('shows "N matches" badge when retail+whale lists overlap', () => {
    const retail = [
      makeStrike({ strike: 6500, type: 'put' }),
      makeStrike({ strike: 6700, type: 'call' }),
    ];
    const whales = [
      makeWhale({ strike: 6500, type: 'put' }),
      makeWhale({ strike: 6700, type: 'call' }),
    ];
    mockUseOptionsFlow.mockReturnValue(makeOptionsFlow({ strikes: retail }));
    mockUseWhalePositioning.mockReturnValue(
      makeWhaleResult({ strikes: whales }),
    );

    renderDefault();
    // findConfluences returns at least 1 entry; badge is either "1 match"
    // or "N matches" depending on the utility's output — either is fine
    // here, we just need to assert the badge renders.
    expect(screen.getByText(/\d+\s+(match|matches)/)).toBeInTheDocument();
  });

  it('hides confluence badge when either list is empty', () => {
    mockUseOptionsFlow.mockReturnValue(makeOptionsFlow({ strikes: [] }));
    mockUseWhalePositioning.mockReturnValue(
      makeWhaleResult({ strikes: [makeWhale()] }),
    );

    renderDefault();
    expect(screen.queryByText(/\d+\s+(match|matches)/)).toBeNull();
  });

  // ── MetaRow rendering ───────────────────────────────────

  it('renders spot + alert count + updated time on the Options Flow meta row', () => {
    mockUseOptionsFlow.mockReturnValue(
      makeOptionsFlow({
        spot: 7001.25,
        alertCount: 3,
        lastUpdated: '2026-04-15T15:32:00.000Z',
      }),
    );

    renderDefault();
    expect(screen.getByText(/7001\.25/)).toBeInTheDocument();
    expect(screen.getByText(/3 alerts/)).toBeInTheDocument();
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
  });

  it('renders "1 alert" (singular) when alertCount === 1', () => {
    mockUseOptionsFlow.mockReturnValue(
      makeOptionsFlow({ alertCount: 1, spot: 7001 }),
    );

    renderDefault();
    expect(screen.getByText(/^1 alert$/)).toBeInTheDocument();
  });

  it('skips MetaRow entirely when spot, count, and updated are all absent', () => {
    // Default makeOptionsFlow returns spot=null, alertCount=0, lastUpdated=null
    // — but alertCount=0 is a number, so it still renders "0 alerts".
    // Use a shape that forces every field to be nullish.
    mockUseOptionsFlow.mockReturnValue({
      ...makeOptionsFlow(),
      data: null,
    });

    renderDefault();
    expect(screen.queryByText(/Updated/)).toBeNull();
  });

  // ── Sub-section collapse ────────────────────────────────

  it('toggles a sub-section closed/open when its header is clicked', () => {
    renderDefault();

    expect(screen.getByTestId('flow-rollup')).toBeInTheDocument();

    const toggle = screen.getByRole('button', {
      name: /Toggle Flow Aggression/i,
    });
    fireEvent.click(toggle);
    expect(screen.queryByTestId('flow-rollup')).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByTestId('flow-rollup')).toBeInTheDocument();
  });

  // ── Refresh handler ─────────────────────────────────────

  it('fires both hooks refresh() when the container refresh button is clicked', () => {
    const flowResult = makeOptionsFlow();
    const whaleResult = makeWhaleResult();
    mockUseOptionsFlow.mockReturnValue(flowResult);
    mockUseWhalePositioning.mockReturnValue(whaleResult);

    renderDefault();

    const refreshBtn = screen.getByLabelText(/Refresh Market Flow/i);
    fireEvent.click(refreshBtn);

    expect(flowResult.refresh).toHaveBeenCalledTimes(1);
    expect(whaleResult.refresh).toHaveBeenCalledTimes(1);
  });

  // ── Scrub state: LIVE badge ─────────────────────────────

  it('shows the LIVE status badge when market is open and not scrubbed', () => {
    renderDefault({ marketOpen: true });
    // The LIVE status span only renders when isLive (not the resume-live button).
    const liveBadges = screen.getAllByText(/^LIVE$/);
    expect(liveBadges.length).toBeGreaterThan(0);
  });

  it('does not render LIVE badge when market is closed', () => {
    renderDefault({ marketOpen: false });
    expect(screen.queryByText(/^LIVE$/)).toBeNull();
  });

  // ── Scrub navigation ────────────────────────────────────

  it('disables prev/next when timestamps list is empty', () => {
    renderDefault();
    expect(screen.getByLabelText(/Previous snapshot/i)).toBeDisabled();
    expect(screen.getByLabelText(/Next snapshot/i)).toBeDisabled();
  });

  it('prev button is disabled in live state (scrubIndex = -1)', () => {
    const timestamps = [
      '2026-04-15T14:30:00.000Z',
      '2026-04-15T14:31:00.000Z',
      '2026-04-15T14:32:00.000Z',
    ];
    mockUseOptionsFlow.mockReturnValue(makeOptionsFlow({ timestamps }));

    renderDefault();
    // In live state (no scrubTimestamp), scrubIndex = -1 → Prev is
    // disabled because canScrubPrev requires scrubIndex > 0. Next is
    // enabled because canScrubNext allows scrubIndex === -1.
    expect(screen.getByLabelText(/Previous snapshot/i)).toBeDisabled();
    expect(screen.getByLabelText(/Next snapshot/i)).not.toBeDisabled();
  });

  it('scrubbing via the snapshot <select> flips to SCRUBBED', () => {
    const timestamps = [
      '2026-04-15T14:30:00.000Z',
      '2026-04-15T14:31:00.000Z',
      '2026-04-15T14:32:00.000Z',
    ];
    mockUseOptionsFlow.mockReturnValue(makeOptionsFlow({ timestamps }));

    renderDefault({ marketOpen: true });
    const select = screen.getByLabelText(
      /Jump to snapshot time/i,
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: timestamps[0] } });

    expect(screen.getByText(/SCRUBBED/)).toBeInTheDocument();
  });

  it('resume-live button clears scrub state and returns to LIVE', () => {
    const timestamps = [
      '2026-04-15T14:30:00.000Z',
      '2026-04-15T14:31:00.000Z',
      '2026-04-15T14:32:00.000Z',
    ];
    mockUseOptionsFlow.mockReturnValue(makeOptionsFlow({ timestamps }));

    renderDefault({ marketOpen: true });
    // Enter scrub via the snapshot <select>.
    const select = screen.getByLabelText(
      /Jump to snapshot time/i,
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: timestamps[0] } });
    expect(screen.getByText(/SCRUBBED/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Resume live/i));
    expect(screen.queryByText(/SCRUBBED/)).toBeNull();
    expect(screen.getAllByText(/^LIVE$/).length).toBeGreaterThan(0);
  });

  it('prev button becomes enabled and steps backward once scrubbing', () => {
    const timestamps = [
      '2026-04-15T14:30:00.000Z',
      '2026-04-15T14:31:00.000Z',
      '2026-04-15T14:32:00.000Z',
    ];
    mockUseOptionsFlow.mockReturnValue(makeOptionsFlow({ timestamps }));

    renderDefault({ marketOpen: true });
    // Enter scrub on the middle bucket (index 1) so Prev is enabled
    // (scrubIndex > 0).
    const select = screen.getByLabelText(
      /Jump to snapshot time/i,
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: timestamps[1] } });

    const prev = screen.getByLabelText(/Previous snapshot/i);
    expect(prev).not.toBeDisabled();
    fireEvent.click(prev);
    // Still SCRUBBED after Prev moves to index 0.
    expect(screen.getByText(/SCRUBBED/)).toBeInTheDocument();
  });

  it('selecting the latest timestamp on today resumes live', () => {
    const timestamps = [
      '2026-04-15T14:30:00.000Z',
      '2026-04-15T14:31:00.000Z',
      '2026-04-15T14:32:00.000Z',
    ];
    mockUseOptionsFlow.mockReturnValue(makeOptionsFlow({ timestamps }));

    renderDefault({ marketOpen: true });
    const select = screen.getByLabelText(
      /Jump to snapshot time/i,
    ) as HTMLSelectElement;
    // Pick past → enters SCRUBBED.
    fireEvent.change(select, { target: { value: timestamps[0] } });
    expect(screen.getByText(/SCRUBBED/)).toBeInTheDocument();

    // Pick latest on today → scrubTo guard resumes live.
    fireEvent.change(select, { target: { value: timestamps.at(-1) } });
    expect(screen.queryByText(/SCRUBBED/)).toBeNull();
  });

  // ── Date change ─────────────────────────────────────────

  it('selecting a new date resets scrubTimestamp and re-calls hooks with it', () => {
    renderDefault();

    mockUseOptionsFlow.mockClear();
    mockUseWhalePositioning.mockClear();

    // <input type="date"> doesn't support user.type reliably — fire a
    // change event directly with the target value.
    const dateInput = screen.getByLabelText(/Select date/i) as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-04-10' } });

    const lastFlowCall = mockUseOptionsFlow.mock.calls.at(-1);
    expect(lastFlowCall?.[0]).toMatchObject({
      selectedDate: '2026-04-10',
      asOf: null,
    });

    const lastWhaleCall = mockUseWhalePositioning.mock.calls.at(-1);
    expect(lastWhaleCall?.[0]).toMatchObject({
      selectedDate: '2026-04-10',
      asOf: null,
    });
  });

  // ── Pass-through of child props ─────────────────────────

  it('passes the hook strikes/alerts/totalPremium through to children', () => {
    const retail = [makeStrike(), makeStrike({ strike: 6850 })];
    const whales = [makeWhale(), makeWhale({ strike: 6600 })];
    mockUseOptionsFlow.mockReturnValue(
      makeOptionsFlow({ strikes: retail, alertCount: 2 }),
    );
    mockUseWhalePositioning.mockReturnValue(
      makeWhaleResult({ strikes: whales, totalPremium: 4_000_000 }),
    );

    renderDefault();

    expect(screen.getByTestId('flow-rollup')).toHaveTextContent('rollup:2');
    expect(screen.getByTestId('flow-table')).toHaveTextContent('table:2');
    expect(screen.getByTestId('whale-table')).toHaveTextContent(
      'whales:2/4000000',
    );
    expect(screen.getByTestId('flow-confluence')).toHaveTextContent(
      'confluence:2/2',
    );
  });

  // ── Meta row doesn't render when all fields missing ─────

  it('MetaRow omits the spot span when spot is null', () => {
    mockUseWhalePositioning.mockReturnValue(
      makeWhaleResult({
        spot: null,
        alertCount: 1,
        lastUpdated: '2026-04-15T14:40:00.000Z',
      }),
    );

    renderDefault();
    // The whale meta row should render but without a "Spot" label.
    const whaleSection = screen.getByText('Whale Positioning').closest('div')
      ?.parentElement?.parentElement;
    if (whaleSection) {
      expect(within(whaleSection).queryByText(/Spot/)).toBeNull();
    }
  });
});
