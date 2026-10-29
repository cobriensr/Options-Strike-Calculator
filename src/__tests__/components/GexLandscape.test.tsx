import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import GexLandscape from '../../components/GexLandscape';
import { CollapseAllContext } from '../../components/collapse-context';
import type { CollapseSignal } from '../../components/collapse-context';
import type { GexStrikeLevel } from '../../components/GexLandscape/types';
import { dealerClaims } from '../helpers/dealer-claims';
import { BiasPanel } from '../../components/GexLandscape/BiasPanel';
import {
  CLASS_META,
  GAMMA_SIGN_HEX,
  trendColor,
} from '../../components/GexLandscape/constants';
import { StrikeTable } from '../../components/GexLandscape/StrikeTable';
import type { BiasMetrics } from '../../components/GexLandscape/types';

// ── Mocks ──────────────────────────────────────────────────────────────────────
//
// GexLandscape was rewired in Phase 3c (gex-landscape-ws-upgrade-2026-05-03)
// to own its scrub + ticker state internally. The component now drives its
// data via `useGexLandscapeData` and `useScrubController` instead of taking
// the previous 17-prop bag from App.tsx. We mock those hooks so each test
// can express the panel's display state declaratively (matching the
// pre-rewrite behaviour where the same fields were just props).

vi.mock('../../utils/auth', () => ({ checkIsOwner: () => true }));

const dataMock = vi.hoisted(() =>
  vi.fn(() => ({
    strikes: [] as GexStrikeLevel[],
    timestamps: [] as string[],
    // Δ% maps are computed inline by the hook from the endpoint's
    // pre-baked `gammaPrevNm` fields. Empty maps by default so the
    // consumer's `.get()` calls return undefined (rendered as `—`).
    gexDelta5mMap: new Map<number, number | null>(),
    gexDelta15mMap: new Map<number, number | null>(),
    gexDelta30mMap: new Map<number, number | null>(),
    loading: false,
    error: null as string | null,
    refresh: vi.fn(),
  })),
);

const scrubMock = vi.hoisted(() =>
  vi.fn(() => ({
    scrubTimestamp: null as string | null,
    isScrubbed: false,
    canScrubPrev: false,
    canScrubNext: false,
    scrubPrev: vi.fn(),
    scrubNext: vi.fn(),
    scrubTo: vi.fn(),
    scrubLive: vi.fn(),
  })),
);

vi.mock('../../hooks/useGexLandscapeData', () => ({
  useGexLandscapeData: () => dataMock(),
}));

vi.mock('../../hooks/useScrubController', () => ({
  useScrubController: () => scrubMock(),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeStrike(
  strike: number,
  price: number,
  netGamma: number,
  netCharm: number,
  volReinforcement: 'reinforcing' | 'opposing' | 'neutral' = 'neutral',
): GexStrikeLevel {
  return {
    strike,
    price,
    callGammaOi: Math.abs(netGamma),
    putGammaOi: 0,
    netGamma,
    callGammaVol: 10,
    putGammaVol: 5,
    netGammaVol: 5,
    volReinforcement,
    callGammaAsk: 5,
    callGammaBid: 4,
    putGammaAsk: 3,
    putGammaBid: 2,
    callCharmOi: Math.abs(netCharm),
    putCharmOi: 0,
    netCharm,
    callCharmVol: 2,
    putCharmVol: 1,
    netCharmVol: 1,
    callDeltaOi: 50,
    putDeltaOi: 30,
    netDelta: 20,
    callVannaOi: 5,
    putVannaOi: 3,
    netVanna: 2,
    callVannaVol: 1,
    putVannaVol: 0,
    netVannaVol: 1,
  };
}

const PRICE = 6880;

const baseStrikes: GexStrikeLevel[] = [
  // Ceiling: neg gamma + pos charm → Max Launchpad
  makeStrike(6910, PRICE, -50_000_000, 20_000_000, 'reinforcing'),
  // Spot area: pos gamma + pos charm → Sticky Pin
  makeStrike(PRICE, PRICE, 80_000_000, 30_000_000, 'neutral'),
  // Floor: pos gamma + neg charm → Weakening Pin
  makeStrike(6850, PRICE, 60_000_000, -15_000_000, 'opposing'),
  // Far floor: neg gamma + neg charm → Fading Launchpad
  makeStrike(6820, PRICE, -40_000_000, -10_000_000, 'neutral'),
];

const collapseSignal: CollapseSignal = { version: 0, collapsed: false };

interface RenderOptions {
  strikes?: GexStrikeLevel[];
  timestamps?: string[];
  loading?: boolean;
  error?: string | null;
  isScrubbed?: boolean;
  canScrubPrev?: boolean;
  canScrubNext?: boolean;
  marketOpen?: boolean;
}

function renderLandscape(opts: RenderOptions = {}) {
  const {
    strikes = baseStrikes,
    timestamps = ['2026-04-13T19:40:00.000Z', '2026-04-13T19:45:00.000Z'],
    loading = false,
    error = null,
    isScrubbed = false,
    canScrubPrev = false,
    canScrubNext = false,
    marketOpen = true,
  } = opts;

  dataMock.mockReturnValue({
    strikes,
    timestamps,
    gexDelta5mMap: new Map<number, number | null>(),
    gexDelta15mMap: new Map<number, number | null>(),
    gexDelta30mMap: new Map<number, number | null>(),
    loading,
    error,
    refresh: vi.fn(),
  });

  scrubMock.mockReturnValue({
    scrubTimestamp: isScrubbed ? (timestamps[0] ?? null) : null,
    isScrubbed,
    canScrubPrev,
    canScrubNext,
    scrubPrev: vi.fn(),
    scrubNext: vi.fn(),
    scrubTo: vi.fn(),
    scrubLive: vi.fn(),
  });

  return render(
    <CollapseAllContext.Provider value={collapseSignal}>
      <GexLandscape marketOpen={marketOpen} />
    </CollapseAllContext.Provider>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GexLandscape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear persisted Top 5 preferences so each test starts from the
    // documented defaults (MM ranking, unmuted alert). Without this,
    // a test that writes 'naive' to localStorage can break a later
    // "default is MM" assertion if anyone re-orders the file.
    try {
      window.localStorage.removeItem('gex-landscape-top5-rank-by-v1');
      window.localStorage.removeItem('gex-landscape-top5-muted-v1');
    } catch {
      /* jsdom always has localStorage; the try/catch mirrors prod */
    }
  });

  describe('classification labels (taker-side gamma × charm signs)', () => {
    it('labels negative gamma + positive charm as Takers −γ +charm', () => {
      renderLandscape();
      expect(screen.getAllByText('Takers −γ +charm').length).toBeGreaterThan(0);
    });

    it('labels positive gamma + positive charm as Takers +γ +charm', () => {
      renderLandscape();
      expect(screen.getAllByText('Takers +γ +charm').length).toBeGreaterThan(0);
    });

    it('labels positive gamma + negative charm as Takers +γ −charm', () => {
      renderLandscape();
      expect(screen.getAllByText('Takers +γ −charm').length).toBeGreaterThan(0);
    });

    it('labels negative gamma + negative charm as Takers −γ −charm', () => {
      renderLandscape();
      expect(screen.getAllByText('Takers −γ −charm').length).toBeGreaterThan(0);
    });
  });

  describe('position column', () => {
    it('describes a ceiling strike with negative gamma by taker side', () => {
      renderLandscape();
      expect(screen.getByText('Position')).toBeDefined();
      expect(
        screen.getAllByText('Taker-short γ above spot').length,
      ).toBeGreaterThan(0);
    });

    it('describes a floor strike with positive gamma by taker side', () => {
      renderLandscape();
      expect(
        screen.getAllByText('Taker-long γ below spot').length,
      ).toBeGreaterThan(0);
    });
  });

  describe('no dealer or market-maker claims (owner decision D1 revised)', () => {
    // GEX Landscape reads GEXBot taker flow; nothing on the panel may
    // predict market-maker hedging. Checks the visible text and every
    // tooltip, in both tabs.

    /**
     * Visible text plus every tooltip, minus the Greek column headers'
     * explicit disclaimer ("…, not a market-maker position"), which denies
     * a claim rather than making one.
     */
    function panelText(): string {
      const titles = Array.from(
        document.querySelectorAll<HTMLElement>('[title]'),
      ).map((el) => el.title);
      return [document.body.textContent ?? '', ...titles]
        .join('\n')
        .replaceAll('not a market-maker position', '');
    }

    it('the strike grid and bias panel make no dealer claim', () => {
      renderLandscape();
      expect(screen.getByText('Top |γ| strike')).toBeDefined();
      expect(dealerClaims(panelText())).toEqual([]);
    });

    it('the Top 5 tab makes no dealer claim', () => {
      renderLandscape();
      fireEvent.click(screen.getByRole('tab', { name: 'Top 5 GEX' }));
      expect(dealerClaims(panelText())).toEqual([]);
    });
  });

  describe('spot indicator', () => {
    it('marks the nearest strike to current price with ATM label', () => {
      renderLandscape();
      // "ATM" may appear in both the spot row and the Top |γ| strike panel
      // (when the gravity strike is at spot). At least one must exist.
      expect(screen.getAllByText('ATM').length).toBeGreaterThan(0);
    });
  });

  describe('column layout', () => {
    it('renders NetGamma / NetCharm / NetVanna as separate column headers', () => {
      renderLandscape();
      expect(screen.getByText('NetGamma')).toBeDefined();
      expect(screen.getByText('NetCharm')).toBeDefined();
      expect(screen.getByText('NetVanna')).toBeDefined();
    });

    it('renders "—" placeholder in the NetVanna cell when netVanna is 0', () => {
      const strikes: GexStrikeLevel[] = [
        {
          ...makeStrike(PRICE, PRICE, 50_000_000, 10_000_000, 'neutral'),
          netVanna: 0,
        },
      ];
      renderLandscape({ strikes });
      const cell = screen.getByTestId(`net-vanna-cell-${PRICE}`);
      expect(cell.textContent).toBe('—');
    });

    it('renders the formatted netVanna value when present', () => {
      const strikes: GexStrikeLevel[] = [
        {
          ...makeStrike(PRICE, PRICE, 50_000_000, 10_000_000, 'neutral'),
          netVanna: 9_000_000,
        },
      ];
      renderLandscape({ strikes });
      const cell = screen.getByTestId(`net-vanna-cell-${PRICE}`);
      expect(cell.textContent).toBe('+9.0M');
    });
  });

  describe('vol reinforcement', () => {
    it('shows ↑↑ for reinforcing strikes', () => {
      renderLandscape();
      const reinforcing = screen.getAllByLabelText('Vol reinforcing');
      expect(reinforcing.length).toBeGreaterThan(0);
    });

    it('shows ↓↓ for opposing strikes', () => {
      renderLandscape();
      const opposing = screen.getAllByLabelText('Vol opposing');
      expect(opposing.length).toBeGreaterThan(0);
    });

    it('shows — for neutral strikes', () => {
      renderLandscape();
      const neutral = screen.getAllByLabelText('Vol neutral');
      expect(neutral.length).toBeGreaterThan(0);
    });
  });

  describe('loading state', () => {
    it('shows loading message when loading with no strikes', () => {
      renderLandscape({ loading: true, strikes: [] });
      expect(screen.getByText('Loading GEX landscape…')).toBeDefined();
    });

    it('shows data rows while loading if strikes exist', () => {
      renderLandscape({ loading: true });
      // Should still render table rows when data is already present
      expect(screen.getAllByText('Takers −γ +charm').length).toBeGreaterThan(0);
    });
  });

  describe('error state', () => {
    it('displays error message', () => {
      renderLandscape({ error: 'Failed to load', strikes: [] });
      expect(screen.getByText('Failed to load')).toBeDefined();
    });
  });

  describe('empty state', () => {
    it('shows empty message when no strikes', () => {
      renderLandscape({ strikes: [] });
      expect(screen.getByText('No strike data available')).toBeDefined();
    });
  });

  describe('header controls', () => {
    it('renders LIVE badge when isLive', () => {
      renderLandscape({ marketOpen: true });
      // SectionBox label + LIVE badge — at least one LIVE text
      const live = screen.getAllByText('LIVE');
      expect(live.length).toBeGreaterThan(0);
    });

    it('renders SCRUBBED badge when isScrubbed', () => {
      renderLandscape({ marketOpen: false, isScrubbed: true });
      expect(screen.getByText('SCRUBBED')).toBeDefined();
    });

    it('disables prev button when canScrubPrev is false', () => {
      renderLandscape({ canScrubPrev: false });
      const prevBtn = screen.getByLabelText('Previous snapshot');
      expect((prevBtn as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables next button when canScrubNext is true', () => {
      renderLandscape({ canScrubNext: true });
      const nextBtn = screen.getByLabelText('Next snapshot');
      expect((nextBtn as HTMLButtonElement).disabled).toBe(false);
    });
  });

  describe('PRICE_WINDOW filter', () => {
    it('excludes strikes beyond 200 pts from spot', () => {
      const farStrike = makeStrike(PRICE + 250, PRICE, -10_000_000, 5_000_000);
      renderLandscape({ strikes: [...baseStrikes, farStrike] });
      // 6880 + 250 = 7130 — should not appear in the table
      expect(screen.queryByText('7,130')).toBeNull();
    });
  });

  describe('view tabs', () => {
    it('renders both tabs and defaults to All strikes', () => {
      renderLandscape();
      const allTab = screen.getByRole('tab', { name: 'All strikes' });
      const topTab = screen.getByRole('tab', { name: 'Top 5 GEX' });
      expect(allTab.getAttribute('aria-selected')).toBe('true');
      expect(topTab.getAttribute('aria-selected')).toBe('false');
    });

    it('switches to the Top 5 panel when the Top 5 tab is clicked', () => {
      renderLandscape();
      const topTab = screen.getByRole('tab', { name: 'Top 5 GEX' });
      fireEvent.click(topTab);
      expect(topTab.getAttribute('aria-selected')).toBe('true');
      expect(
        screen
          .getByRole('tab', { name: 'All strikes' })
          .getAttribute('aria-selected'),
      ).toBe('false');
    });

    it('ArrowRight on the active tab moves selection to the next tab', () => {
      renderLandscape();
      const allTab = screen.getByRole('tab', { name: 'All strikes' });
      fireEvent.keyDown(allTab, { key: 'ArrowRight' });
      expect(
        screen
          .getByRole('tab', { name: 'Top 5 GEX' })
          .getAttribute('aria-selected'),
      ).toBe('true');
    });

    it('ArrowDown behaves like ArrowRight (vertical alias)', () => {
      renderLandscape();
      fireEvent.keyDown(screen.getByRole('tab', { name: 'All strikes' }), {
        key: 'ArrowDown',
      });
      expect(
        screen
          .getByRole('tab', { name: 'Top 5 GEX' })
          .getAttribute('aria-selected'),
      ).toBe('true');
    });

    it('ArrowLeft wraps from first tab to last tab', () => {
      renderLandscape();
      fireEvent.keyDown(screen.getByRole('tab', { name: 'All strikes' }), {
        key: 'ArrowLeft',
      });
      // Wraps (idx -1 + 2) % 2 = 1 → Top 5 GEX
      expect(
        screen
          .getByRole('tab', { name: 'Top 5 GEX' })
          .getAttribute('aria-selected'),
      ).toBe('true');
    });

    it('ArrowUp behaves like ArrowLeft (vertical alias)', () => {
      renderLandscape();
      fireEvent.click(screen.getByRole('tab', { name: 'Top 5 GEX' }));
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Top 5 GEX' }), {
        key: 'ArrowUp',
      });
      expect(
        screen
          .getByRole('tab', { name: 'All strikes' })
          .getAttribute('aria-selected'),
      ).toBe('true');
    });

    it('Home selects the first tab', () => {
      renderLandscape();
      const topTab = screen.getByRole('tab', { name: 'Top 5 GEX' });
      fireEvent.click(topTab);
      fireEvent.keyDown(topTab, { key: 'Home' });
      expect(
        screen
          .getByRole('tab', { name: 'All strikes' })
          .getAttribute('aria-selected'),
      ).toBe('true');
    });

    it('End selects the last tab', () => {
      renderLandscape();
      fireEvent.keyDown(screen.getByRole('tab', { name: 'All strikes' }), {
        key: 'End',
      });
      expect(
        screen
          .getByRole('tab', { name: 'Top 5 GEX' })
          .getAttribute('aria-selected'),
      ).toBe('true');
    });

    it('ignores keys that do not map to a nav action', () => {
      renderLandscape();
      const allTab = screen.getByRole('tab', { name: 'All strikes' });
      fireEvent.keyDown(allTab, { key: 'Enter' });
      fireEvent.keyDown(allTab, { key: 'a' });
      expect(allTab.getAttribute('aria-selected')).toBe('true');
    });

    it('is a no-op when Home is pressed on the already-first tab', () => {
      renderLandscape();
      const allTab = screen.getByRole('tab', { name: 'All strikes' });
      fireEvent.keyDown(allTab, { key: 'Home' });
      expect(allTab.getAttribute('aria-selected')).toBe('true');
    });
  });

  describe('Top 5 GEX tab', () => {
    // Mix of in-window and out-of-window strikes with deliberately spread
    // magnitudes so the top-5 ordering is unambiguous regardless of spot/ATM.
    const rankStrikes = [
      makeStrike(PRICE, PRICE, 10_000_000, 1_000_000), // |1e7|  rank 6
      makeStrike(PRICE + 10, PRICE, 900_000_000, 1_000_000), // |9e8| rank 1
      makeStrike(PRICE - 20, PRICE, -800_000_000, 0), // |8e8| rank 2
      makeStrike(PRICE + 30, PRICE, 700_000_000, 0), // |7e8| rank 3
      makeStrike(PRICE + 250, PRICE, -600_000_000, 0), // |6e8| rank 4 (out of window)
      makeStrike(PRICE - 40, PRICE, 500_000_000, 0), // |5e8| rank 5
      makeStrike(PRICE + 5, PRICE, 40_000_000, 0), // |4e7| rank 7
    ];

    function openTop5(strikes = rankStrikes) {
      renderLandscape({ strikes });
      fireEvent.click(screen.getByRole('tab', { name: 'Top 5 GEX' }));
      return screen.getByRole('tabpanel', { name: 'Top 5 GEX' });
    }

    it('shows exactly 5 rows ordered by absolute netGamma', () => {
      const panel = openTop5();
      const rows = within(panel).getAllByRole('listitem');
      expect(rows).toHaveLength(5);
      // Row 0 should contain the top strike (PRICE + 10 → 6890) and not the
      // two lowest-magnitude strikes (PRICE and PRICE + 5).
      expect(within(rows[0]!).getByText('6,890')).toBeDefined();
      expect(within(panel).queryByText('6,880')).toBeNull(); // rank 6 excluded
      expect(within(panel).queryByText('6,885')).toBeNull(); // rank 7 excluded
    });

    it('includes distant walls outside the ±50 pt price window', () => {
      const panel = openTop5();
      // PRICE + 250 = 7130 is outside PRICE_WINDOW but has big |netGamma|.
      expect(within(panel).getByText('7,130')).toBeDefined();
    });

    it('renders a signed ATM offset for non-ATM top rows', () => {
      const panel = openTop5();
      // PRICE + 10 is +10 above spot; PRICE - 20 is 20 below spot.
      expect(within(panel).getByText('+10 pts')).toBeDefined();
      expect(within(panel).getByText('−20 pts')).toBeDefined();
    });

    it('renders the ATM label (not "+0 pts") when the ATM strike is in top 5', () => {
      // ATM (PRICE) has the biggest |netGamma| so it ranks #1.
      const strikes = [
        makeStrike(PRICE, PRICE, 1_000_000_000, 0), // ATM — biggest wall
        makeStrike(PRICE + 10, PRICE, 500_000_000, 0),
        makeStrike(PRICE - 20, PRICE, 400_000_000, 0),
      ];
      renderLandscape({ strikes });
      fireEvent.click(screen.getByRole('tab', { name: 'Top 5 GEX' }));
      const panel = screen.getByRole('tabpanel', { name: 'Top 5 GEX' });
      // Inside the top-5 panel, ATM row shows "ATM" badge and no "+0 pts" / "−0 pts".
      expect(within(panel).getByText('ATM')).toBeDefined();
      expect(within(panel).queryByText('+0 pts')).toBeNull();
      expect(within(panel).queryByText('−0 pts')).toBeNull();
    });

    it('renders only the available rows when the chain has fewer than 5 strikes', () => {
      const strikes = [
        makeStrike(PRICE + 10, PRICE, 900_000_000, 0),
        makeStrike(PRICE - 20, PRICE, 800_000_000, 0),
      ];
      renderLandscape({ strikes });
      fireEvent.click(screen.getByRole('tab', { name: 'Top 5 GEX' }));
      const panel = screen.getByRole('tabpanel', { name: 'Top 5 GEX' });
      expect(within(panel).getAllByRole('listitem')).toHaveLength(2);
    });

    it('does not render any rank-by toggle (Naive Γ removed with WS feed)', () => {
      const panel = openTop5();
      expect(within(panel).queryByRole('radiogroup')).toBeNull();
      expect(within(panel).queryByRole('radio', { name: 'MM Γ' })).toBeNull();
      expect(
        within(panel).queryByRole('radio', { name: 'Naive Γ' }),
      ).toBeNull();
    });
  });

  describe('Greek column tooltips: GEXBot, taker-side sign (owner decision D1 revised)', () => {
    it.each([
      ['NetGamma', 'gamma'],
      ['NetCharm', 'charm'],
      ['NetVanna', 'vanna'],
    ])(
      '%s says GEXBot taker-side sign, with no MM, dealer or UW claim',
      (header, greek) => {
        renderLandscape();
        const title = screen.getByText(header).getAttribute('title') ?? '';
        expect(title).toMatch(/GEXBot/);
        expect(title).toContain(
          `in GEXBot's taker-side sign: positive = traders (takers) are net long ${greek} at this strike`,
        );
        expect(title).not.toMatch(/MM-|dealer|UW|negated|proprietary/);
      },
    );

    it('the per-cell charm tooltip reads charm in the taker-side sign', () => {
      renderLandscape();
      const charmCells = Array.from(
        document.querySelectorAll<HTMLElement>('[title]'),
      ).filter((el) => /GEXBot charm/.test(el.title));
      expect(charmCells.length).toBeGreaterThan(0);
      for (const el of charmCells) {
        expect(el.title).toMatch(
          /taker-side sign\): traders are net (long|short) charm/,
        );
        expect(el.title).not.toMatch(/market.maker|dealer/i);
      }
    });
  });

  describe('GexBot priors Δ% surface (5m / 15m / 30m)', () => {
    it('renders Δ5m / Δ15m / Δ30m column headers (GexBot priors windows)', () => {
      renderLandscape();
      expect(screen.getByText('Δ5m')).toBeDefined();
      expect(screen.getByText('Δ15m')).toBeDefined();
      expect(screen.getByText('Δ30m')).toBeDefined();
      // Old mislabelled windows are gone.
      expect(screen.queryByText('Δ1m')).toBeNull();
      expect(screen.queryByText('Δ10m')).toBeNull();
      // Legacy MM / Naive split is gone.
      expect(screen.queryByText('MM 10m')).toBeNull();
      expect(screen.queryByText('MM 30m')).toBeNull();
      expect(screen.queryByText('N 1m')).toBeNull();
      expect(screen.queryByText('N 5m')).toBeNull();
      expect(screen.queryByText('N 10m')).toBeNull();
    });

    it('renders the Vol Reinf. column header', () => {
      renderLandscape();
      expect(screen.getByText('Vol Reinf.')).toBeDefined();
    });
  });
});

// ── BiasPanel palette and glyphs (owner decision D1 revised) ──────────

function makeBias(overrides: Partial<BiasMetrics> = {}): BiasMetrics {
  return {
    verdict: 'gex-pull-up',
    regime: 'positive',
    totalNetGex: 2.5e9,
    gravityStrike: 5900,
    gravityOffset: 40,
    gravityGex: 1.8e9,
    upsideTargets: [],
    downsideTargets: [],
    floorTrend5m: 2.5,
    ceilingTrend5m: 2.5,
    floorTrend15m: -1.2,
    ceilingTrend15m: -1.2,
    floorTrend30m: null,
    ceilingTrend30m: null,
    priceTrend: null,
    ...overrides,
  };
}

function renderBias(bias: BiasMetrics) {
  return render(
    <BiasPanel
      bias={bias}
      maxChanged5mStrike={null}
      maxChanged15mStrike={null}
      maxChanged30mStrike={null}
    />,
  );
}

/** jsdom normalizes hex to rgb(); compare through the same normalizer. */
function cssColor(hex: string): string {
  const el = document.createElement('span');
  el.style.color = hex;
  return el.style.color;
}

describe('BiasPanel — sign-only colours, same rule above and below spot', () => {
  it('colours F and C the same for the same trend value', () => {
    renderBias(makeBias());
    const f = screen.getByText('F +2.5%') as HTMLElement;
    const c = screen.getByText('C +2.5%') as HTMLElement;
    expect(f.style.color).toBe(c.style.color);
    expect(f.style.color).toBe(cssColor(GAMMA_SIGN_HEX.long));
    const fNeg = screen.getByText('F −1.2%') as HTMLElement;
    const cNeg = screen.getByText('C −1.2%') as HTMLElement;
    expect(fNeg.style.color).toBe(cNeg.style.color);
    expect(fNeg.style.color).toBe(cssColor(GAMMA_SIGN_HEX.short));
  });

  it('colours the net-gamma badge by sign with the gamma-sign hues', () => {
    const { unmount } = renderBias(makeBias());
    expect(screen.getByText(/NET LONG γ/).className).toContain('sky');
    unmount();
    renderBias(
      makeBias({
        verdict: 'breakout-risk-up',
        regime: 'negative',
        totalNetGex: -1e9,
      }),
    );
    expect(screen.getByText(/NET SHORT γ/).className).toContain('violet');
  });

  it('marks strike position with ▲ / ▼ and keeps ↑ / ↓ for price moves', () => {
    const { unmount } = renderBias(makeBias());
    expect(screen.getByText('▲ TOP ABOVE · LONG γ')).toBeDefined();
    expect(screen.getByText('▲ 40pts')).toBeDefined();
    expect(screen.getByText('▲ Top |γ| above')).toBeDefined();
    expect(screen.getByText('▼ Top |γ| below')).toBeDefined();
    expect(document.body.textContent).not.toMatch(/[↑↓]/);
    unmount();
    renderBias(
      makeBias({
        verdict: 'drifting-up',
        gravityOffset: 10,
        priceTrend: {
          direction: 'up',
          changePct: 0.1,
          changePts: 6,
          consistency: 0.8,
        },
      }),
    );
    expect(screen.getByText('↑ DRIFTING UP')).toBeDefined();
  });
});

// ── StrikeTable colours (fix round 2: U9–U11) ─────────────────────────

describe('StrikeTable — Δ%, ATM row and reinforcement marks carry no gamma or safe/danger meaning', () => {
  const SPOT = 5900;

  function renderTable(rows: GexStrikeLevel[], pct: number) {
    const map = new Map(rows.map((r) => [r.strike, pct] as const));
    return render(
      <StrikeTable
        rows={rows}
        currentPrice={SPOT}
        spotStrike={rows.find((r) => r.strike === SPOT) ?? null}
        maxChanged5mStrike={null}
        maxChanged15mStrike={null}
        maxChanged30mStrike={null}
        gexDelta5mMap={map}
        gexDelta15mMap={map}
        gexDelta30mMap={map}
        spotRowRef={{ current: null }}
      />,
    );
  }

  it('colours a Δ% cell exactly like the BiasPanel trend for the same value', () => {
    const { unmount } = renderTable([makeStrike(5950, SPOT, -5e8, 1e6)], 2.5);
    const tableColor = (screen.getAllByText('+2.5%')[0] as HTMLElement).style
      .color;
    unmount();
    renderBias(makeBias({ floorTrend5m: 2.5, ceilingTrend5m: 2.5 }));
    const panelColor = (screen.getByText('F +2.5%') as HTMLElement).style.color;
    expect(tableColor).toBe(panelColor);
    expect(tableColor).toBe(cssColor(trendColor(2.5)));
  });

  it('colours a negative Δ% with the short hue, not red', () => {
    renderTable([makeStrike(5950, SPOT, 5e8, 1e6)], -3);
    const cell = screen.getAllByText('−3.0%')[0] as HTMLElement;
    expect(cell.style.color).toBe(cssColor(trendColor(-3)));
  });

  it('marks the ATM row with a neutral ring and keeps its gamma tint', () => {
    renderTable([makeStrike(SPOT, SPOT, 5e8, 1e6)], 1);
    const row = screen.getAllByRole('listitem')[0] as HTMLElement;
    expect(row.className).toContain('ring-edge-strong');
    // Long γ, positive charm → the sticky-pin row tint stays on the ATM row.
    expect(row.className).toContain(CLASS_META['sticky-pin'].rowBg);
    expect(row.className).not.toMatch(/bg-sky-500\/10|border-l-sky/);
  });

  it('draws ↑↑ / ↓↓ in neutral text, with the gamma growth stated in the title', () => {
    renderTable(
      [
        makeStrike(5950, SPOT, 5e8, 1e6, 'reinforcing'),
        makeStrike(5850, SPOT, 5e8, 1e6, 'opposing'),
      ],
      1,
    );
    const up = screen.getByLabelText('Vol reinforcing');
    const down = screen.getByLabelText('Vol opposing');
    for (const el of [up, down]) {
      expect(el.className).not.toMatch(/emerald|green|red|amber/);
    }
    expect(up.title).toMatch(/gamma is growing/);
    expect(down.title).toMatch(/gamma is shrinking toward zero/);
  });

  it('draws the BiasPanel ↑↑ / ↓↓ marks in neutral text too', () => {
    renderBias(
      makeBias({
        upsideTargets: [
          {
            strike: 5950,
            cls: 'sticky-pin',
            netGamma: 5e8,
            volReinforcement: 'reinforcing',
          },
        ],
        downsideTargets: [
          {
            strike: 5850,
            cls: 'sticky-pin',
            netGamma: 5e8,
            volReinforcement: 'opposing',
          },
        ],
      }),
    );
    const up = screen.getByText('↑↑');
    const down = screen.getByText('↓↓');
    for (const el of [up, down]) {
      expect(el.className).not.toMatch(/emerald|green|red|amber/);
    }
    expect(up.title).toMatch(/growing/);
    expect(down.title).toMatch(/shrinking/);
  });
});
