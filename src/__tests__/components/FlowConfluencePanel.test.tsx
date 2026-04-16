import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FlowConfluencePanel } from '../../components/OptionsFlow/FlowConfluencePanel';
import type { RankedStrike, WhaleAlert } from '../../types/flow';
import type { InternalBar } from '../../types/market-internals';

// ============================================================
// MARKET INTERNALS FIXTURES
// ============================================================

function makeTickBar(close: number, minuteOffset = 0): InternalBar {
  const ts = new Date(
    `2026-04-15T14:${String(minuteOffset).padStart(2, '0')}:00Z`,
  ).toISOString();
  return {
    ts,
    symbol: '$TICK',
    open: close - 10,
    high: close + 20,
    low: close - 20,
    close,
  };
}

/** Build a range-day fixture: oscillating TICK, flat ADD. */
function makeRangeDayBars(): InternalBar[] {
  const bars: InternalBar[] = [];
  for (let i = 0; i < 20; i++) {
    // Alternate positive/negative to create high mean-reversion rate
    const sign = i % 2 === 0 ? 1 : -1;
    bars.push(makeTickBar(sign * 200, i));
  }
  // Flat ADD
  bars.push({
    ts: '2026-04-15T14:00:00Z',
    symbol: '$ADD',
    open: 100,
    high: 150,
    low: 50,
    close: 110,
  });
  bars.push({
    ts: '2026-04-15T14:19:00Z',
    symbol: '$ADD',
    open: 110,
    high: 160,
    low: 60,
    close: 120,
  });
  return bars;
}

/** Build a trend-day fixture: TICK pinned extreme, VOLD directional. */
function makeTrendDayBars(): InternalBar[] {
  const bars: InternalBar[] = [];
  for (let i = 0; i < 20; i++) {
    // Always extreme positive — pinned above 600
    bars.push(makeTickBar(650 + i * 5, i));
  }
  // Directional VOLD (starts low, ends high)
  bars.push({
    ts: '2026-04-15T14:00:00Z',
    symbol: '$VOLD',
    open: 10,
    high: 50,
    low: 0,
    close: 10,
  });
  bars.push({
    ts: '2026-04-15T14:19:00Z',
    symbol: '$VOLD',
    open: 400,
    high: 450,
    low: 350,
    close: 450,
  });
  return bars;
}

// ============================================================
// FIXTURES
// ============================================================

function makeRetail(overrides: Partial<RankedStrike> = {}): RankedStrike {
  return {
    strike: 7000,
    type: 'call',
    distance_from_spot: 0,
    distance_pct: 0,
    total_premium: 400_000,
    ask_side_ratio: 0.85,
    volume_oi_ratio: 3.0,
    hit_count: 4,
    has_ascending_fill: false,
    has_descending_fill: false,
    has_multileg: false,
    is_itm: false,
    score: 0.8,
    first_seen_at: '2026-04-15T14:30:00Z',
    last_seen_at: '2026-04-15T15:05:00Z',
    ...overrides,
  };
}

function makeWhale(overrides: Partial<WhaleAlert> = {}): WhaleAlert {
  return {
    option_chain: 'SPXW 2026-04-20 P7000',
    strike: 7000,
    type: 'put',
    expiry: '2026-04-20',
    dte_at_alert: 5,
    created_at: '2026-04-15T14:00:00Z',
    age_minutes: 30,
    total_premium: 2_000_000,
    total_ask_side_prem: 1_800_000,
    total_bid_side_prem: 200_000,
    ask_side_ratio: 0.9,
    total_size: 3000,
    volume: 3500,
    open_interest: 900,
    volume_oi_ratio: 3.9,
    has_sweep: false,
    has_floor: false,
    has_multileg: false,
    alert_rule: 'RepeatedHits',
    underlying_price: 7001,
    distance_from_spot: -1,
    distance_pct: -0.00014,
    is_itm: false,
    ...overrides,
  };
}

// ============================================================
// TESTS
// ============================================================

describe('FlowConfluencePanel', () => {
  it('renders "waiting" empty state when both retail and whale are empty', () => {
    render(<FlowConfluencePanel intradayStrikes={[]} whaleAlerts={[]} />);
    expect(
      screen.getByText(/waiting on retail and whale flow/i),
    ).toBeInTheDocument();
  });

  it('renders "loading retail" when retail empty but whale present', () => {
    render(
      <FlowConfluencePanel intradayStrikes={[]} whaleAlerts={[makeWhale()]} />,
    );
    expect(screen.getByText(/loading retail flow/i)).toBeInTheDocument();
    expect(screen.queryByText(/no whale data yet/i)).not.toBeInTheDocument();
  });

  it('renders "no whale data" when whale empty but retail present', () => {
    render(
      <FlowConfluencePanel intradayStrikes={[makeRetail()]} whaleAlerts={[]} />,
    );
    expect(screen.getByText(/no whale data yet/i)).toBeInTheDocument();
  });

  it('renders 3 match rows for a fixture with 3 known confluences', () => {
    // Use widely-separated retail strikes so each only matches one whale
    // within the 50-pt proximity window.
    const retail = [
      makeRetail({ strike: 7000, type: 'call', total_premium: 467_000 }),
      makeRetail({ strike: 6800, type: 'call', total_premium: 102_000 }),
      makeRetail({ strike: 6600, type: 'call', total_premium: 115_000 }),
    ];
    const whales = [
      makeWhale({
        option_chain: 'W-agree',
        strike: 7030,
        type: 'call',
        total_premium: 2_100_000,
      }),
      makeWhale({
        option_chain: 'W-hedge-1',
        strike: 6810,
        type: 'put',
        total_premium: 3_000_000,
      }),
      makeWhale({
        option_chain: 'W-hedge-2',
        strike: 6610,
        type: 'put',
        total_premium: 4_000_000,
      }),
    ];
    render(
      <FlowConfluencePanel intradayStrikes={retail} whaleAlerts={whales} />,
    );
    const rows = screen.getAllByTestId('confluence-row');
    expect(rows).toHaveLength(3);
    const count = screen.getByTestId('confluence-match-count');
    expect(count.textContent).toMatch(/3 matches/);
  });

  it('uses distinct color classes for AGREE vs HEDGE badges', () => {
    const retail = [
      makeRetail({ strike: 7000, type: 'call', total_premium: 500_000 }),
      makeRetail({ strike: 7100, type: 'call', total_premium: 400_000 }),
    ];
    const whales = [
      makeWhale({
        option_chain: 'W-agree',
        strike: 7000,
        type: 'call',
        total_premium: 2_000_000,
      }),
      makeWhale({
        option_chain: 'W-hedge',
        strike: 7100,
        type: 'put',
        total_premium: 2_000_000,
      }),
    ];
    render(
      <FlowConfluencePanel intradayStrikes={retail} whaleAlerts={whales} />,
    );

    const badges = screen.getAllByTestId('confluence-badge');
    expect(badges).toHaveLength(2);
    const agreeBadge = badges.find(
      (b) => b.getAttribute('data-kind') === 'AGREE',
    );
    const hedgeBadge = badges.find(
      (b) => b.getAttribute('data-kind') === 'HEDGE',
    );
    expect(agreeBadge).toBeDefined();
    expect(hedgeBadge).toBeDefined();
    expect(agreeBadge!.className).toMatch(/emerald/);
    expect(hedgeBadge!.className).toMatch(/amber/);
    expect(agreeBadge!.className).not.toMatch(/amber/);
    expect(hedgeBadge!.className).not.toMatch(/emerald/);
  });

  it('renders retail 7000C + whale 6500P as HEDGE when in range', () => {
    // With default proximity=50 this is actually outside range (|delta|=500)
    // so nothing should match. But with a tightened fixture it demonstrates
    // the HEDGE classification for the spec example.
    const retail = [
      makeRetail({ strike: 7000, type: 'call', total_premium: 467_000 }),
    ];
    const whales = [
      makeWhale({
        option_chain: 'W-hedge-near',
        strike: 6990, // within 50-pt window
        type: 'put',
        total_premium: 2_500_000,
      }),
    ];
    render(
      <FlowConfluencePanel intradayStrikes={retail} whaleAlerts={whales} />,
    );
    const badges = screen.getAllByTestId('confluence-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]!.getAttribute('data-kind')).toBe('HEDGE');
    const row = screen.getByTestId('confluence-row');
    expect(row.getAttribute('data-relationship')).toBe('retail-call-whale-put');
  });

  it('renders empty "no confluence" message when no pairs match', () => {
    // Retail and whale both present, but strike distance is beyond proximity.
    const retail = [makeRetail({ strike: 7000 })];
    const whales = [makeWhale({ strike: 6500 })]; // |delta|=500 > 50
    render(
      <FlowConfluencePanel intradayStrikes={retail} whaleAlerts={whales} />,
    );
    expect(
      screen.getByText(/no confluence matches in current window/i),
    ).toBeInTheDocument();
    expect(screen.queryAllByTestId('confluence-row')).toHaveLength(0);
  });

  it('renders at most 10 matches even when more exist', () => {
    const retail: RankedStrike[] = [];
    const whales: WhaleAlert[] = [];
    for (let i = 0; i < 15; i++) {
      const strike = 7000 + i * 10;
      retail.push(
        makeRetail({
          strike,
          type: 'call',
          total_premium: 100_000 + i * 10_000,
        }),
      );
      whales.push(
        makeWhale({
          option_chain: `W-${i}`,
          strike,
          type: 'put',
          total_premium: 2_000_000,
        }),
      );
    }
    render(
      <FlowConfluencePanel intradayStrikes={retail} whaleAlerts={whales} />,
    );
    const rows = screen.getAllByTestId('confluence-row');
    expect(rows).toHaveLength(10);
    const count = screen.getByTestId('confluence-match-count');
    expect(count.textContent).toMatch(/10 matches/);
  });

  it('renders CONTRARIAN badge for retail-put + whale-call pairing', () => {
    const retail = [
      makeRetail({ strike: 7000, type: 'put', total_premium: 400_000 }),
    ];
    const whales = [
      makeWhale({
        option_chain: 'W-contra',
        strike: 7000,
        type: 'call',
        total_premium: 2_000_000,
      }),
    ];
    render(
      <FlowConfluencePanel intradayStrikes={retail} whaleAlerts={whales} />,
    );
    const badge = screen.getByTestId('confluence-badge');
    expect(badge.getAttribute('data-kind')).toBe('CONTRARIAN');
    expect(badge.className).toMatch(/indigo/);
  });

  // ============================================================
  // REGIME ANNOTATION TESTS
  // ============================================================

  it('does not render regime annotation when bars are empty', () => {
    render(<FlowConfluencePanel intradayStrikes={[]} whaleAlerts={[]} />);
    expect(screen.queryByTestId('regime-annotation')).not.toBeInTheDocument();
  });

  it('renders range-day annotation with cyan styling', () => {
    render(
      <FlowConfluencePanel
        intradayStrikes={[]}
        whaleAlerts={[]}
        bars={makeRangeDayBars()}
      />,
    );
    const annotation = screen.getByTestId('regime-annotation');
    expect(annotation).toBeInTheDocument();
    expect(annotation.getAttribute('data-regime')).toBe('range');
    expect(annotation.textContent).toMatch(/range day/i);
    expect(annotation.className).toMatch(/cyan/);
  });

  it('renders trend-day annotation with violet styling', () => {
    render(
      <FlowConfluencePanel
        intradayStrikes={[]}
        whaleAlerts={[]}
        bars={makeTrendDayBars()}
      />,
    );
    const annotation = screen.getByTestId('regime-annotation');
    expect(annotation).toBeInTheDocument();
    expect(annotation.getAttribute('data-regime')).toBe('trend');
    expect(annotation.textContent).toMatch(/trend day/i);
    expect(annotation.className).toMatch(/violet/);
  });

  it('renders neutral annotation when data is insufficient', () => {
    // Only 3 TICK bars — not enough for regime classification
    render(
      <FlowConfluencePanel
        intradayStrikes={[]}
        whaleAlerts={[]}
        bars={[
          makeTickBar(100, 0),
          makeTickBar(-50, 1),
          makeTickBar(200, 2),
        ]}
      />,
    );
    const annotation = screen.getByTestId('regime-annotation');
    expect(annotation).toBeInTheDocument();
    expect(annotation.getAttribute('data-regime')).toBe('neutral');
    expect(annotation.textContent).toMatch(/no clear regime/i);
    expect(annotation.className).toMatch(/zinc/);
  });
});
