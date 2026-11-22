import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import GexLandscape from '../../components/GexLandscape';
import { CollapseAllContext } from '../../components/collapse-context';
import type { CollapseSignal } from '../../components/collapse-context';
import type { GexStrikeLevel } from '../../components/GexLandscape/types';
import { dealerClaims } from '../helpers/dealer-claims';
import { BiasPanel } from '../../components/GexLandscape/BiasPanel';
import {
  CLASS_META,
  GAMMA_SIGN_HEX,
  VERDICT_META,
  VERDICT_TOOLTIP,
  trendColor,
} from '../../components/GexLandscape/constants';
import { StrikeTable } from '../../components/GexLandscape/StrikeTable';
import type {
  BiasMetrics,
  DriftTarget,
} from '../../components/GexLandscape/types';
import type { GexLandscapeFreshness } from '../../hooks/useGexLandscapeData';
import {
  genericElementsWithAriaLabel,
  srHintText,
  titledGenericsWithoutHint,
} from '../helpers/aria';

// ── Mocks ──────────────────────────────────────────────────────────────────────
//
// GexLandscape was rewired in Phase 3c (gex-landscape-ws-upgrade-2026-05-03)
// to own its scrub + ticker state internally. The component now drives its
// data via `useGexLandscapeData` and `useScrubController` instead of taking
// the previous 17-prop bag from App.tsx. We mock those hooks so each test
// can express the panel's display state declaratively (matching the
// pre-rewrite behaviour where the same fields were just props).

vi.mock('../../utils/auth', () => ({ checkIsOwner: () => true }));

// The mock takes (marketOpen, date, at) so a test can read what the panel
// asks for; the typed signature keeps the unused parameters honest.
interface LandscapeData {
  /** Absent = null, as the real hook before its first response. */
  freshness?: GexLandscapeFreshness | null;
  strikes: GexStrikeLevel[];
  timestamps: string[];
  gexDelta5mMap: Map<number, number | null>;
  gexDelta15mMap: Map<number, number | null>;
  gexDelta30mMap: Map<number, number | null>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const dataMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => LandscapeData>(() => ({
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
  // Forward the arguments so a test can read the date and pin the panel asks
  // for: (marketOpen, date, at).
  useGexLandscapeData: (...args: unknown[]) => dataMock(...args),
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
  freshness?: GexLandscapeFreshness | null;
}

/** Point the mocked data and scrub hooks at one display state. */
function mockLandscape(opts: RenderOptions = {}) {
  const {
    strikes = baseStrikes,
    timestamps = ['2026-04-13T19:40:00.000Z', '2026-04-13T19:45:00.000Z'],
    loading = false,
    error = null,
    isScrubbed = false,
    canScrubPrev = false,
    canScrubNext = false,
    freshness = null,
  } = opts;

  dataMock.mockReturnValue({
    freshness,
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
}

function renderLandscape(opts: RenderOptions = {}) {
  mockLandscape(opts);
  return render(
    <CollapseAllContext.Provider value={collapseSignal}>
      <GexLandscape marketOpen={opts.marketOpen ?? true} />
    </CollapseAllContext.Provider>,
  );
}

/**
 * Re-render a mounted panel against a new display state. The panel is
 * memoized, so a new `onBiasChange` each call is what makes React re-render
 * it and read the mocked hooks again.
 */
function rerenderLandscape(
  view: ReturnType<typeof renderLandscape>,
  opts: RenderOptions = {},
) {
  mockLandscape(opts);
  view.rerender(
    <CollapseAllContext.Provider value={collapseSignal}>
      <GexLandscape
        marketOpen={opts.marketOpen ?? true}
        onBiasChange={() => undefined}
      />
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

  describe('hover text for screen readers', () => {
    // The whole panel, both tabs: every titled bare span or div carries the
    // meaning of its title in a hidden hint (BiasPanel and StrikeTable sites
    // are pinned one by one below).
    it('gives every titled generic element a hint on the Landscape tab', () => {
      const { container } = renderLandscape();
      expect(titledGenericsWithoutHint(container)).toEqual([]);
    });

    it('gives every titled generic element a hint on the Top 5 tab', () => {
      const { container } = renderLandscape();
      fireEvent.click(screen.getByRole('tab', { name: 'Top 5 GEX' }));
      expect(titledGenericsWithoutHint(container)).toEqual([]);
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
    // The bias panel above the table has ↑↑ / ↓↓ marks of its own, named the
    // same way, so these two look in the strike table only.
    it('shows ↑↑ for reinforcing strikes', () => {
      renderLandscape();
      const table = within(
        screen.getByRole('list', { name: 'GEX strike landscape' }),
      );
      const reinforcing = table.getAllByRole('img', {
        name: /^Reinforcing —/,
      });
      expect(reinforcing.length).toBeGreaterThan(0);
    });

    it('shows ↓↓ for opposing strikes', () => {
      renderLandscape();
      const table = within(
        screen.getByRole('list', { name: 'GEX strike landscape' }),
      );
      const opposing = table.getAllByRole('img', { name: /^Opposing —/ });
      expect(opposing.length).toBeGreaterThan(0);
    });

    it('shows — for neutral strikes', () => {
      renderLandscape();
      const neutral = screen.getAllByRole('img', { name: /^Neutral —/ });
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
    const up = screen.getByRole('img', { name: /^Reinforcing —/ });
    const down = screen.getByRole('img', { name: /^Opposing —/ });
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

// ── StrikeTable badge and mark names ──────────────────────────────────
//
// ARIA 1.2 prohibits naming a bare span, so the New / Anchor badges say
// what they mean through a hidden SrHint, and the ↑↑ / ↓↓ / — marks (glyphs
// only) are role="img" with the meaning as their label. Every title stays.

describe('StrikeTable — New / Anchor badges and vol marks name themselves in ways screen readers read', () => {
  const SPOT = 5900;
  const ROWS = [
    makeStrike(5950, SPOT, 5e8, 1e6, 'reinforcing'),
    makeStrike(5900, SPOT, 5e8, 1e6, 'opposing'),
    makeStrike(5850, SPOT, 5e8, 1e6, 'neutral'),
  ];

  function renderBadgeTable() {
    const map = new Map(ROWS.map((r) => [r.strike, 1] as const));
    return render(
      <StrikeTable
        rows={ROWS}
        currentPrice={SPOT}
        spotStrike={ROWS[1] ?? null}
        maxChanged5mStrike={null}
        maxChanged15mStrike={null}
        maxChanged30mStrike={null}
        gexDelta5mMap={map}
        gexDelta15mMap={map}
        gexDelta30mMap={map}
        spotRowRef={{ current: null }}
        justEntered={new Set([5950])}
        oldestStrike={5850}
      />,
    );
  }

  it('says why a strike is New in a hint, not an aria-label, and keeps the title', () => {
    renderBadgeTable();
    const badge = screen.getByText('New');
    expect(srHintText(badge)).toBe('just entered Top 5 on the latest snapshot');
    expect(badge).not.toHaveAttribute('aria-label');
    expect(badge).toHaveAttribute(
      'title',
      'Just entered Top 5 on the latest snapshot',
    );
  });

  it('says why a strike is the Anchor in a hint, not an aria-label, and keeps the title', () => {
    renderBadgeTable();
    const badge = screen.getByText('Anchor');
    expect(srHintText(badge)).toBe(
      'oldest strike in the Top 5 — in the set longest this session',
    );
    expect(badge).not.toHaveAttribute('aria-label');
    expect(badge).toHaveAttribute(
      'title',
      'Oldest strike in the Top 5 — in the set longest this session',
    );
  });

  it.each([
    [
      '↑↑',
      "Reinforcing — all three Δ% windows move with the netGamma sign; the strike's gamma is growing in that sign.",
    ],
    [
      '↓↓',
      "Opposing — all three Δ% windows move against the netGamma sign; the strike's gamma is shrinking toward zero.",
    ],
    [
      '—',
      'Neutral — mixed direction across the three windows, or sparse data (any null / zero prior value).',
    ],
  ])('names the %s mark as an image labelled with its title', (glyph, text) => {
    renderBadgeTable();
    const mark = screen.getByRole('img', { name: text });
    expect(mark).toHaveTextContent(glyph);
    expect(mark).toHaveAttribute('title', text);
  });

  it('leaves no bare span or div with an aria-label', () => {
    const { container } = renderBadgeTable();
    expect(genericElementsWithAriaLabel(container)).toEqual([]);
  });
});

// ── BiasPanel hover text reaches screen readers ───────────────────────
//
// Role-less elements that explained themselves only through `title` (mouse
// hover) now carry the same meaning in a hidden SrHint, as their last direct
// child. The `title` of each stays byte for byte; the three glyph-only marks
// are images labelled with their meaning. A hint never repeats the label the
// element already shows, so some are a trimmed variant of the title.

const REGIME_TITLES = {
  positive:
    "Sum of GEXBot gamma over the strikes within ±50 pts of spot, in GEXBot's taker-side sign: positive, so traders (takers) are net long gamma across the window.",
  negative:
    "Sum of GEXBot gamma over the strikes within ±50 pts of spot, in GEXBot's taker-side sign: negative, so traders (takers) are net short gamma across the window.",
} as const;

const TAIL =
  'Computed from GEXBot gamma in its taker-side sign over the strikes within ±50 pts of spot. It describes taker positioning; it is not a forecast of where price goes.';

const TARGET_UP_REINFORCING: DriftTarget = {
  strike: 5950,
  cls: 'sticky-pin',
  netGamma: 5e8,
  volReinforcement: 'reinforcing',
};
const TARGET_UP_OPPOSING: DriftTarget = {
  strike: 5975,
  cls: 'max-launchpad',
  netGamma: -5e8,
  volReinforcement: 'opposing',
};
const TARGET_DOWN_A: DriftTarget = {
  strike: 5850,
  cls: 'weakening-pin',
  netGamma: 5e8,
  volReinforcement: 'neutral',
};
const TARGET_DOWN_B: DriftTarget = {
  strike: 5825,
  cls: 'fading-launchpad',
  netGamma: -5e8,
  volReinforcement: 'neutral',
};

/** A panel that reaches every site: four target rows, both marks, the ⚡. */
function renderHintPanel(overrides: Partial<BiasMetrics> = {}) {
  return render(
    <BiasPanel
      bias={makeBias({
        upsideTargets: [TARGET_UP_REINFORCING, TARGET_UP_OPPOSING],
        downsideTargets: [TARGET_DOWN_A, TARGET_DOWN_B],
        ...overrides,
      })}
      maxChanged5mStrike={5950}
      maxChanged15mStrike={null}
      maxChanged30mStrike={null}
    />,
  );
}

describe('BiasPanel — verdict badge', () => {
  it.each(Object.keys(VERDICT_META) as Array<keyof typeof VERDICT_META>)(
    '%s: the hint is the shared tail, the title is the whole tooltip',
    (verdict) => {
      renderBias(makeBias({ verdict }));
      const label = screen.getByText(VERDICT_META[verdict].label);
      expect(srHintText(label)).toBe(TAIL);
      expect(label).toHaveAttribute('title', VERDICT_TOOLTIP[verdict]);
    },
  );

  it('keeps the full title of the long-gamma verdict byte for byte', () => {
    renderBias(makeBias());
    expect(screen.getByText('▲ TOP ABOVE · LONG γ')).toHaveAttribute(
      'title',
      `The strike with the largest absolute gamma sits more than 25 pts above spot, and net taker gamma is positive (traders net long gamma). ${TAIL}`,
    );
  });

  it('does not say again what the description beside it already says', () => {
    renderBias(makeBias());
    const hint = srHintText(screen.getByText('▲ TOP ABOVE · LONG γ'));
    expect(hint).not.toContain('Largest |γ| strike');
    expect(hint).not.toContain('net taker gamma is positive');
  });
});

describe('BiasPanel — net-gamma badge', () => {
  it.each([
    ['positive', /NET LONG γ/],
    ['negative', /NET SHORT γ/],
  ] as const)(
    '%s regime: title and hint carry the same sentence',
    (regime, label) => {
      renderBias(
        makeBias({ regime, totalNetGex: regime === 'positive' ? 2.5e9 : -1e9 }),
      );
      const badge = screen.getByText(label);
      expect(badge).toHaveAttribute('title', REGIME_TITLES[regime]);
      expect(srHintText(badge)).toBe(REGIME_TITLES[regime]);
    },
  );

  it('keeps the signed value in the badge text, hint last', () => {
    renderBias(makeBias());
    const badge = screen.getByText(/NET LONG γ/);
    expect(badge.textContent).toContain('+2.5B');
    expect(badge.lastElementChild).toHaveClass('sr-only');
  });
});

describe('BiasPanel — top-gamma block, target columns and target rows', () => {
  it('the top-gamma block carries its title as a hint', () => {
    renderHintPanel();
    const text =
      'The strike with the largest absolute GEXBot gamma within ±50 pts of spot: its distance from spot, strike and taker-side value.';
    const block = screen.getByText('Top |γ| strike')
      .parentElement as HTMLElement;
    expect(block).toHaveAttribute('title', text);
    expect(srHintText(block)).toBe(text);
  });

  it.each([
    [
      '▲ Top |γ| above',
      'The two strikes more than 25 pts above spot with the largest absolute GEXBot gamma, with their taker-side classification.',
    ],
    [
      '▼ Top |γ| below',
      'The two strikes more than 25 pts below spot with the largest absolute GEXBot gamma, with their taker-side classification.',
    ],
  ])('the %s column carries its title as a hint', (label, text) => {
    renderHintPanel();
    const column = screen.getByText(label).parentElement as HTMLElement;
    expect(column).toHaveAttribute('title', text);
    expect(srHintText(column)).toBe(text);
    // The rows come first; the hint is the last child of the column.
    expect(column.lastElementChild).toHaveClass('sr-only');
  });

  it('an empty column still carries its hint', () => {
    renderBias(makeBias());
    const column = screen.getByText('▲ Top |γ| above')
      .parentElement as HTMLElement;
    expect(srHintText(column)).toContain('The two strikes more than 25 pts');
  });

  it.each([
    [
      '5,950',
      "In GEXBot's taker-side sign, traders (takers) are net long gamma and net long charm at this strike.",
    ],
    [
      '5,975',
      "In GEXBot's taker-side sign, traders (takers) are net short gamma and net long charm at this strike.",
    ],
    [
      '5,850',
      "In GEXBot's taker-side sign, traders (takers) are net long gamma and net short charm at this strike.",
    ],
    [
      '5,825',
      "In GEXBot's taker-side sign, traders (takers) are net short gamma and net short charm at this strike.",
    ],
  ])(
    'the %s target row carries its class tooltip as a hint',
    (strike, text) => {
      renderHintPanel();
      const row = screen.getByText(strike).parentElement as HTMLElement;
      expect(row).toHaveAttribute('title', text);
      expect(srHintText(row)).toBe(text);
    },
  );

  it('puts the row hint after the optional marks, as the last child', () => {
    renderHintPanel();
    // 5950 carries the reinforcing mark and the confluence bolt.
    const row = screen.getByText('5,950').parentElement as HTMLElement;
    const marks = within(row).getAllByRole('img');
    expect(marks).toHaveLength(2);
    expect(row.lastElementChild).toHaveClass('sr-only');
    expect(row.lastElementChild).not.toBe(marks.at(-1));
  });
});

describe('BiasPanel — ↑↑ / ↓↓ / ⚡ marks are labelled images', () => {
  it.each([
    [
      '↑↑',
      "Reinforcing — Δ5m, Δ15m and Δ30m all move with this strike's gamma sign, so its gamma is growing in that sign",
    ],
    [
      '↓↓',
      "Opposing — Δ5m, Δ15m and Δ30m all move against this strike's gamma sign, so its gamma is shrinking toward zero",
    ],
    [
      '⚡',
      'Most actively changing gamma strike (largest |Δ| in a 5m, 15m or 30m window)',
    ],
  ])('names the %s mark as an image labelled with its title', (glyph, text) => {
    renderHintPanel();
    const mark = screen.getByRole('img', { name: text });
    expect(mark).toHaveTextContent(glyph);
    expect(mark).toHaveAttribute('title', text);
  });

  it('leaves no bare span or div with an aria-label', () => {
    const { container } = renderHintPanel();
    expect(genericElementsWithAriaLabel(container)).toEqual([]);
  });
});

describe('BiasPanel — trend ladder and its F / C cells', () => {
  it('the ladder carries the F and C key in a hint, and keeps its title', () => {
    renderHintPanel();
    const ladder = screen.getByText('Trend Ladder')
      .parentElement as HTMLElement;
    expect(ladder).toHaveAttribute(
      'title',
      "Average % change in GEXBot dollar gamma (taker-side sign) for the strikes more than 25 pts below spot (F) and above spot (C), vs. the value N min ago. Three rows at GEXBot's priors windows (t-5 / t-15 / t-30 min).",
    );
    expect(srHintText(ladder)).toBe(
      'average % change in GEXBot dollar gamma in taker-side sign. F is the strikes more than 25 pts below spot and C the strikes more than 25 pts above, each against the value 5, 15 and 30 min ago',
    );
  });

  // Distinct values per row so each cell is found by its own text; the 30m
  // row is null, which shows an em dash.
  it.each([
    ['5m', 'F +2.5%', 'C +3.5%'],
    ['15m', 'F −1.2%', 'C −2.2%'],
    ['30m', 'F —', 'C —'],
  ])('the %s row: F and C say which strikes they average', (win, f, c) => {
    renderBias(
      makeBias({
        floorTrend5m: 2.5,
        ceilingTrend5m: 3.5,
        floorTrend15m: -1.2,
        ceilingTrend15m: -2.2,
        floorTrend30m: null,
        ceilingTrend30m: null,
      }),
    );
    const floor = screen.getByText(f);
    const ceil = screen.getByText(c);
    expect(floor).toHaveAttribute(
      'title',
      `F: avg Δ${win} of the strikes below spot`,
    );
    expect(ceil).toHaveAttribute(
      'title',
      `C: avg Δ${win} of the strikes above spot`,
    );
    expect(srHintText(floor)).toBe(`average Δ${win} of the strikes below spot`);
    expect(srHintText(ceil)).toBe(`average Δ${win} of the strikes above spot`);
    // Per-row hints stay short: three rows, two cells each.
    expect(srHintText(floor)?.length).toBeLessThanOrEqual(60);
    expect(srHintText(ceil)?.length).toBeLessThanOrEqual(60);
  });

  it('gives every titled generic element in the whole panel a hint', () => {
    const { container } = renderHintPanel();
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });

  it('keeps the panel free of dealer claims and arrow glyphs in its text', () => {
    renderBias(makeBias());
    expect(document.body.textContent).not.toMatch(/[↑↓]/);
    expect(dealerClaims(document.body.textContent ?? '')).toEqual([]);
  });
});

// ── StrikeTable hover text reaches screen readers ─────────────────────

describe('StrikeTable — column headers', () => {
  const SPOT = 5900;
  const ROWS = [makeStrike(SPOT, SPOT, 5e8, 1e6)];

  function renderHeaders() {
    const map = new Map(ROWS.map((r) => [r.strike, 1] as const));
    return render(
      <StrikeTable
        rows={ROWS}
        currentPrice={SPOT}
        spotStrike={ROWS[0] ?? null}
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

  // The header word is the label, so the hint carries the title's meaning.
  // `not a market-maker position` is the one dealer phrase a title may keep:
  // it denies the claim.
  it.each([
    [
      'Position',
      "Taker side of the strike's GEXBot gamma and where the strike sits relative to spot (25-pt band).",
    ],
    [
      'NetGamma',
      "GEXBot dollar gamma per strike from the 1-min capture, in GEXBot's taker-side sign: positive = traders (takers) are net long gamma at this strike, negative = net short. A taker-flow measure, not a market-maker position.",
    ],
    [
      'NetCharm',
      "GEXBot dollar charm per strike, in GEXBot's taker-side sign: positive = traders (takers) are net long charm at this strike, negative = net short. A taker-flow measure, not a market-maker position.",
    ],
    [
      'NetVanna',
      "GEXBot dollar vanna per strike, in GEXBot's taker-side sign: positive = traders (takers) are net long vanna at this strike, negative = net short. A taker-flow measure, not a market-maker position.",
    ],
    [
      'Δ5m',
      "% change in dollar gamma vs. the slot 5 min ago (GEXBot's shortest priors window) — shows the freshest sign flips and the fastest changes.",
    ],
    [
      'Δ15m',
      '% change in dollar gamma vs. the slot 15 min ago. Smooths the shorter-window noise; useful for setup detection between bigger windows.',
    ],
    [
      'Δ30m',
      '% change in dollar gamma vs. the slot 30 min ago. Catches session-scale build/unwind.',
    ],
  ])('the %s header carries its title as a hint', (header, text) => {
    renderHeaders();
    const cell = screen.getByText(header);
    expect(cell).toHaveAttribute('title', text);
    expect(srHintText(cell)).toBe(text);
  });

  it('the Vol Reinf. header carries a trimmed hint without the glyphs', () => {
    renderHeaders();
    const cell = screen.getByText('Vol Reinf.');
    expect(cell).toHaveAttribute(
      'title',
      "Vol Reinforcement — delta-trend agreement. ↑↑ (reinforcing): all three Δ% windows move with the netGamma sign, so the strike's gamma is growing in that sign. ↓↓ (opposing): all three move against it, so it is shrinking toward zero. — (neutral): mixed / sparse / no data.",
    );
    const hint = srHintText(cell);
    expect(hint).toBe(
      "delta-trend agreement. Reinforcing: all three Δ% windows move with the netGamma sign, so the strike's gamma is growing in that sign. Opposing: all three move against it, so it is shrinking toward zero. Neutral: mixed, sparse or no data",
    );
    expect(hint).not.toMatch(/[↑↓—]/);
  });

  it('gives every titled generic element in the header and row a hint', () => {
    const { container } = renderHeaders();
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });
});

describe('StrikeTable — per-row distance, class, position and charm cells', () => {
  const SPOT = 5900;
  const ROWS = [
    makeStrike(5950, SPOT, -5e8, 1e6), // max-launchpad, above the band
    makeStrike(SPOT, SPOT, 5e8, 1e6), // sticky-pin, the spot row
    makeStrike(5910, SPOT, 5e8, -1e6), // weakening-pin, inside the band
    makeStrike(5850, SPOT, -5e8, -1e6), // fading-launchpad, below the band
  ];

  function renderRows() {
    const map = new Map(ROWS.map((r) => [r.strike, 1] as const));
    return render(
      <StrikeTable
        rows={ROWS}
        currentPrice={SPOT}
        spotStrike={ROWS[1] ?? null}
        maxChanged5mStrike={null}
        maxChanged15mStrike={null}
        maxChanged30mStrike={null}
        gexDelta5mMap={map}
        gexDelta15mMap={map}
        gexDelta30mMap={map}
        spotRowRef={{ current: null }}
        showAtmDistance
      />,
    );
  }

  const CASES = [
    {
      name: 'above the band',
      index: 0,
      distance: ['+50 pts', '50 points above spot', 'above spot'],
      badge: [
        'Takers −γ +charm',
        "In GEXBot's taker-side sign, traders (takers) are net short gamma and net long charm at this strike.",
        'takers net short gamma, net long charm',
      ],
      position: [
        'Taker-short γ above spot',
        "In GEXBot's taker-side sign, traders (takers) are net short gamma and net long charm at this strike, which sits more than 25 pts above spot.",
        'more than 25 pts above spot',
      ],
      charm: [
        '+1.0M',
        'Positive GEXBot charm (taker-side sign): traders are net long charm at this strike.',
        'takers net long charm',
      ],
    },
    {
      name: 'inside the band',
      index: 2,
      distance: ['+10 pts', '10 points above spot', 'above spot'],
      badge: [
        'Takers +γ −charm',
        "In GEXBot's taker-side sign, traders (takers) are net long gamma and net short charm at this strike.",
        'takers net long gamma, net short charm',
      ],
      position: [
        'Taker-long γ at spot',
        "In GEXBot's taker-side sign, traders (takers) are net long gamma and net short charm at this strike, which sits within 25 pts of spot.",
        'within 25 pts of spot',
      ],
      charm: [
        '−1.0M',
        'Negative GEXBot charm (taker-side sign): traders are net short charm at this strike.',
        'takers net short charm',
      ],
    },
    {
      name: 'below the band',
      index: 3,
      distance: ['−50 pts', '50 points below spot', 'below spot'],
      badge: [
        'Takers −γ −charm',
        "In GEXBot's taker-side sign, traders (takers) are net short gamma and net short charm at this strike.",
        'takers net short gamma, net short charm',
      ],
      position: [
        'Taker-short γ below spot',
        "In GEXBot's taker-side sign, traders (takers) are net short gamma and net short charm at this strike, which sits more than 25 pts below spot.",
        'more than 25 pts below spot',
      ],
      charm: [
        '−1.0M',
        'Negative GEXBot charm (taker-side sign): traders are net short charm at this strike.',
        'takers net short charm',
      ],
    },
  ] as const;

  it.each(CASES)(
    'the row $name: distance, class, position and charm each say it in a hint',
    (c) => {
      renderRows();
      const row = within(
        screen.getAllByRole('listitem')[c.index] as HTMLElement,
      );
      for (const [text, title, hint] of [
        c.distance,
        c.badge,
        c.position,
        c.charm,
      ]) {
        const cell = row.getByText(text);
        expect(cell).toHaveAttribute('title', title);
        expect(srHintText(cell)).toBe(hint);
        // Per-row hints stay short: a 20-row table is read through.
        expect(srHintText(cell)?.length).toBeLessThanOrEqual(60);
      }
    },
  );

  it('the spot row has no distance cell, and still names its class and charm', () => {
    renderRows();
    const row = within(screen.getAllByRole('listitem')[1] as HTMLElement);
    expect(row.queryByText(/pts$/)).toBeNull();
    const badge = srHintText(row.getByText('Takers +γ +charm'));
    const position = srHintText(row.getByText('Taker-long γ at spot'));
    const charm = srHintText(row.getByText('+1.0M'));
    expect(badge).toBe('takers net long gamma, net long charm');
    expect(position).toBe('within 25 pts of spot');
    expect(charm).toBe('takers net long charm');
    // Per-row hints stay short, here as in the other rows.
    for (const hint of [badge, position, charm]) {
      expect(hint?.length).toBeLessThanOrEqual(60);
    }
  });

  it('every titled generic element in every row has a hint', () => {
    const { container } = renderRows();
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });
});

// ============================================================
// ET MIDNIGHT WHILE THE APP IS OPEN
//
// The panel follows today. Its date has no picker (the endpoint is today
// only), so it exists to key the local resets: the scrub pin and mirrored
// timestamps, the Top 5 tracker and the price-trend buffer. The panel is
// memoized, so only the shared ET clock moves it. Every case starts 30 s
// before an ET midnight; the clock's timer is armed for 1 s past it, so 31 s
// lands just after. The real getETToday() reads the faked Date. Owner
// decision 2026-11-14.
// ============================================================

describe.each([
  {
    zone: 'EST (winter)',
    start: '2026-11-10T04:59:30Z',
    night: '2026-11-09',
    morning: '2026-11-10',
  },
  {
    zone: 'EDT (summer)',
    start: '2026-07-15T03:59:30Z',
    night: '2026-07-14',
    morning: '2026-07-15',
  },
])('GexLandscape: across the $zone midnight', (m) => {
  const NIGHT_PIN = `${m.night}T19:40:00.000Z`;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(m.start));
    dataMock.mockReturnValue({
      strikes: baseStrikes,
      timestamps: [NIGHT_PIN],
      gexDelta5mMap: new Map<number, number | null>(),
      gexDelta15mMap: new Map<number, number | null>(),
      gexDelta30mMap: new Map<number, number | null>(),
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A scrub controller whose pin the test holds. Once armed, scrubLive clears
   * the pin as the real controller does; before that it only records the call,
   * so a clear on mount does not drop the pin the test starts with.
   */
  function mockScrub(initialPin: string | null) {
    let pin = initialPin;
    let armed = false;
    const scrubLive = vi.fn(() => {
      if (armed) pin = null;
    });
    scrubMock.mockImplementation(() => ({
      scrubTimestamp: pin,
      isScrubbed: pin !== null,
      canScrubPrev: false,
      canScrubNext: false,
      scrubPrev: vi.fn(),
      scrubNext: vi.fn(),
      scrubTo: vi.fn(),
      scrubLive,
    }));
    return {
      scrubLive,
      arm: () => {
        armed = true;
      },
    };
  }

  /** The shared clock's timer fires, just past midnight. */
  function crossMidnight() {
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
  }

  /** The (marketOpen, date, at) of the panel's latest data-hook call. */
  const lastAsk = () => dataMock.mock.calls.at(-1);

  function renderPanel() {
    return render(
      <CollapseAllContext.Provider value={collapseSignal}>
        <GexLandscape marketOpen={true} />
      </CollapseAllContext.Provider>,
    );
  }

  it('follows the new date and clears the scrub it carried', () => {
    const { scrubLive, arm } = mockScrub(NIGHT_PIN);
    renderPanel();
    expect(lastAsk()?.[1]).toBe(m.night);
    scrubLive.mockClear();
    arm();

    crossMidnight();

    expect(lastAsk()?.[1]).toBe(m.morning);
    // The pin and the mirrored timestamps are reset at the roll.
    expect(scrubLive).toHaveBeenCalled();
    expect(lastAsk()?.[2]).toBeNull();
  });

  it('never asks for the new date at the old pin', () => {
    const { arm } = mockScrub(NIGHT_PIN);
    renderPanel();
    dataMock.mockClear();
    arm();

    crossMidnight();

    // Not just the last call: no render, committed or not, may pair the new
    // date with the pin that was set on the old one.
    const stale = dataMock.mock.calls.filter(
      (c) => c[1] === m.morning && c[2] !== null,
    );
    expect(stale).toEqual([]);
    expect(lastAsk()).toEqual([true, m.morning, null]);
  });

  it('rolls with no parent re-render', () => {
    mockScrub(null);
    let parentRenders = 0;
    function Parent() {
      parentRenders += 1;
      return (
        <CollapseAllContext.Provider value={collapseSignal}>
          <GexLandscape marketOpen={true} />
        </CollapseAllContext.Provider>
      );
    }
    render(<Parent />);
    const callsBefore = dataMock.mock.calls.length;

    crossMidnight();

    expect(parentRenders).toBe(1);
    expect(dataMock.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(lastAsk()?.[1]).toBe(m.morning);
  });

  it('keeps following when LIVE is resumed, including just past midnight', () => {
    mockScrub(NIGHT_PIN);
    renderPanel();

    // The wall clock is past midnight; the shared clock has not ticked, so
    // its `today` is still the night's. Resuming live must not pin that string.
    act(() => {
      vi.setSystemTime(new Date(Date.parse(m.start) + 30_500));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Resume live' }));
    crossMidnight();

    expect(lastAsk()?.[1]).toBe(m.morning);
  });

  // -- Resets that live in children and refs, read through what they show.
  // Five feeds, one minute apart: the Top 5 changes membership on the third
  // (so one strike has been in the set longer than the rest and is marked
  // Anchor), and spot climbs 2 pts a feed (a drift, which the bias summary
  // reports). The panel is re-rendered per feed by flipping marketOpen.

  const FEEDS = 5;
  const feedStrikes = (k: number) => {
    const price = 6880 + 2 * k;
    // A..D stay; the fifth place is E for the first two feeds and F from the
    // third on. The tracker stamps a newcomer with the timestamp the panel
    // still holds in the render the data arrives in (it mirrors the feed one
    // render late), so the change needs two feeds of history before it to
    // leave the newcomer later than the rest.
    const shifted = k >= 2;
    const fifth = shifted ? 10_000_000 : 60_000_000;
    const challenger = shifted ? 65_000_000 : 10_000_000;
    return [
      makeStrike(6900, price, 100_000_000, 1_000_000),
      makeStrike(6910, price, 90_000_000, 1_000_000),
      makeStrike(6920, price, 80_000_000, 1_000_000),
      makeStrike(6930, price, 70_000_000, 1_000_000),
      makeStrike(6940, price, fifth, 1_000_000),
      makeStrike(6950, price, challenger, 1_000_000),
    ];
  };

  function feedTheSession(onBiasChange: (summary: string | null) => void) {
    mockScrub(null);
    const panel = (marketOpen: boolean) => (
      <CollapseAllContext.Provider value={collapseSignal}>
        <GexLandscape marketOpen={marketOpen} onBiasChange={onBiasChange} />
      </CollapseAllContext.Provider>
    );
    const view = render(panel(true));
    for (let k = 0; k < FEEDS; k += 1) {
      const timestamp = `${m.night}T19:4${k}:00.000Z`;
      dataMock.mockReturnValue({
        strikes: feedStrikes(k),
        timestamps: [timestamp],
        gexDelta5mMap: new Map<number, number | null>(),
        gexDelta15mMap: new Map<number, number | null>(),
        gexDelta30mMap: new Map<number, number | null>(),
        loading: false,
        error: null,
        refresh: vi.fn(),
      });
      view.rerender(panel(k % 2 === 1));
    }
    fireEvent.click(screen.getByRole('tab', { name: 'Top 5 GEX' }));
  }

  it('clears the Top 5 anchor at the roll', () => {
    feedTheSession(vi.fn());
    expect(screen.queryAllByText('Anchor')).toHaveLength(1);

    crossMidnight();

    // Anchor, not New: New lags one render, which was already so.
    expect(screen.queryAllByText('Anchor')).toHaveLength(0);
  });

  it('clears the price trend at the roll', () => {
    const onBiasChange = vi.fn();
    feedTheSession(onBiasChange);
    expect(onBiasChange.mock.calls.at(-1)?.[0]).toContain(
      'Price trend: DRIFTING UP',
    );

    crossMidnight();

    expect(onBiasChange.mock.calls.at(-1)?.[0]).not.toContain('Price trend');
  });
});

// ============================================================
// A STALLED FEED (site 96)
//
// The badge turns from LIVE to DELAYED once the data on screen is 3 minutes
// old, and an empty panel says why. The age is the server's (`ageSec` plus
// the response's `Age` header, summed in the hook) plus the time since the
// response arrived, so the client clock is never set against `asOf`. The
// panel re-reads the clock every 15 s, only while the age applies: live,
// market open, and the server agreeing it is open. Every case starts at a
// fixed instant on a session morning.
// ============================================================

describe('GexLandscape: a stalled feed', () => {
  const NOW = Date.parse('2026-11-20T15:30:00.000Z'); // 9:30 AM CT, a Friday
  const MIN = 60_000;
  const TICK_MS = 15_000;
  const HINT = 'the upstream feed has not sent new data';
  const GENERIC = 'No strike data available';
  const SOME_PANELS = 'Some GEX panels have no capture in the last 5 minutes';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
      ],
    });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A live response's freshness, received just now. */
  function freshnessOf(
    over: Partial<GexLandscapeFreshness> = {},
  ): GexLandscapeFreshness {
    return {
      serverMarketOpen: true,
      reason: null,
      dataAgeMsAtReceipt: 5_000,
      lastCaptureAgeMsAtReceipt: null,
      receivedAt: Date.now(),
      ...over,
    };
  }

  /**
   * A `no_slot` response: no strikes, the day's capture minutes only.
   * `stampAgeMs` is the last minute stamp's age on the SERVER's clock when
   * the response arrived (the hook's `lastCaptureAgeMsAtReceipt`); the stamps
   * are laid out to match, so the message names the right time. Null = no
   * capture minute today.
   */
  function noSlot(stampAgeMs: number | null, over = {}): RenderOptions {
    return {
      strikes: [],
      timestamps:
        stampAgeMs == null
          ? []
          : [
              new Date(NOW - stampAgeMs - MIN).toISOString(),
              new Date(NOW - stampAgeMs).toISOString(),
            ],
      freshness: freshnessOf({
        reason: 'no_slot',
        dataAgeMsAtReceipt: null,
        lastCaptureAgeMsAtReceipt: stampAgeMs,
      }),
      ...over,
    };
  }

  /** The ids of the 15 s intervals the panel has started so far. */
  function tickIntervals(spy: {
    mock: { calls: unknown[][]; results: Array<{ value: unknown }> };
  }): unknown[] {
    return spy.mock.calls.flatMap((call, i) =>
      call[1] === TICK_MS ? [spy.mock.results[i]?.value] : [],
    );
  }

  const advance = (ms: number) => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };

  describe('data on screen goes stale', () => {
    it('shows LIVE at 2 min 45 s, then DELAYED 3m one 15 s tick later, with no new response', () => {
      const { container } = renderLandscape({
        freshness: freshnessOf({ dataAgeMsAtReceipt: 2 * MIN + 45_000 }),
      });
      expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0);
      expect(screen.queryByText(/^DELAYED/)).toBeNull();

      // Just short of the tick: the age on screen has not been re-read yet.
      advance(TICK_MS - 1);
      expect(screen.queryByText(/^DELAYED/)).toBeNull();

      advance(1);
      const badge = screen.getByText('DELAYED 3m');
      expect(srHintText(badge)).toBe(HINT);
      expect(badge).toHaveAttribute(
        'title',
        'Latest data is 3m old — the upstream feed has not sent new data',
      );
      expect(screen.queryAllByText('LIVE')).toHaveLength(0);
      // The strikes stay on screen: DELAYED labels the data, it doesn't hide it.
      expect(screen.getAllByText('Takers −γ +charm').length).toBeGreaterThan(0);
      expect(titledGenericsWithoutHint(container)).toEqual([]);
    });

    it('counts a response that lands between ticks from its own arrival, not the stale clock', () => {
      // The clock was last read at mount. A response lands 10 s later with a
      // capture already 3 min 5 s old: the age must not be pulled back by the
      // 10 s the clock has not yet caught up with.
      const view = renderLandscape({
        freshness: freshnessOf({ dataAgeMsAtReceipt: 5_000 }),
      });
      advance(10_000);
      rerenderLandscape(view, {
        freshness: freshnessOf({
          dataAgeMsAtReceipt: 3 * MIN + 5_000,
          receivedAt: Date.now(),
        }),
      });
      expect(screen.getByText('DELAYED 3m')).toBeDefined();
    });

    it('reads the clock again when the age starts to apply, not one tick later', () => {
      // Live and fresh, then scrubbed for 5 minutes (no ticks while scrubbed),
      // then back to live while the hook still holds the old live response.
      const stored = freshnessOf({ dataAgeMsAtReceipt: 100_000 });
      const view = renderLandscape({ freshness: stored });
      rerenderLandscape(view, { isScrubbed: true, freshness: stored });
      advance(5 * MIN);
      rerenderLandscape(view, { freshness: stored });
      // 100 s + the 5 minutes that passed = 6 min 40 s, read at once.
      expect(screen.getByText('DELAYED 6m')).toBeDefined();
    });
  });

  describe('an empty panel says why', () => {
    it('shows the stall message and DELAYED when the last capture stamp is 6 minutes old', () => {
      const { container } = renderLandscape(noSlot(6 * MIN));
      // 15:24:00Z is 9:24 AM CT (CST, UTC-6).
      expect(
        screen.getByText('Feed stalled: last capture 9:24 AM CT'),
      ).toBeDefined();
      expect(screen.queryByText(GENERIC)).toBeNull();
      // The badge shows the stamp's age less the 60 s the minute truncation
      // can hide (a lower bound on the true age): 6 min - 1 min = 5 min.
      const badge = screen.getByText('DELAYED 5m');
      expect(srHintText(badge)).toBe(HINT);
      expect(titledGenericsWithoutHint(container)).toEqual([]);
    });

    it.each([6 * MIN, MIN])(
      'makes no dealer claim in the message, badge or tooltip (last capture %i ms old)',
      (lastAgoMs) => {
        renderLandscape(noSlot(lastAgoMs));
        const titles = Array.from(
          document.querySelectorAll<HTMLElement>('[title]'),
        ).map((el) => el.title);
        const text = [document.body.textContent ?? '', ...titles].join('\n');
        expect(text).toMatch(/Feed stalled|Some GEX panels/);
        expect(dealerClaims(text)).toEqual([]);
      },
    );

    it('says only some panels are missing, and stays LIVE, when the last capture is 1 minute old', () => {
      renderLandscape(noSlot(MIN));
      expect(screen.getByText(SOME_PANELS)).toBeDefined();
      expect(screen.queryByText(GENERIC)).toBeNull();
      expect(screen.queryByText(/^DELAYED/)).toBeNull();
      expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0);
    });

    it('turns the same panel from some-panels to stalled when the stamp ages past 4 minutes', () => {
      // Stamp 3 min 50 s old (lower bound 2 min 50 s): some panels. One tick
      // later it is 4 min 5 s old (lower bound 3 min 5 s): stalled.
      renderLandscape(noSlot(3 * MIN + 50_000));
      expect(screen.getByText(SOME_PANELS)).toBeDefined();
      expect(screen.queryByText(/^DELAYED/)).toBeNull();

      advance(TICK_MS);
      expect(
        screen.getByText(/^Feed stalled: last capture \d{1,2}:\d{2} [AP]M CT$/),
      ).toBeDefined();
      expect(screen.getByText('DELAYED 3m')).toBeDefined();
    });

    // The stamp is truncated to the minute, so its age overstates the real
    // capture's by up to 60 s. The split is the threshold plus that 60 s:
    // 3 min + 60 s = 4 min, inclusive.
    it.each([
      [4 * MIN - 1, SOME_PANELS],
      [4 * MIN, 'Feed stalled: last capture 9:26 AM CT'],
    ])(
      'with the last capture stamp %i ms old, the message is "%s"',
      (stampAgeMs, message) => {
        renderLandscape(noSlot(stampAgeMs));
        expect(screen.getByText(message)).toBeDefined();
        expect(screen.queryByText(/^DELAYED/) == null).toBe(
          message === SOME_PANELS,
        );
      },
    );

    it('a healthy gamma feed missing only a charm panel never shows stalled or DELAYED (stamp up to 2 min old)', () => {
      renderLandscape(noSlot(2 * MIN));
      advance(TICK_MS);
      expect(screen.getByText(SOME_PANELS)).toBeDefined();
      expect(screen.queryByText(/^DELAYED/)).toBeNull();
    });

    // The age comes from the server's clock (carried in freshness), never
    // from the client clock against the stamps: a client clock far off the
    // server's must not change the verdict in either direction.
    it('ignores a client clock that disagrees with the stamps: server says fresh, stamps look months old', () => {
      renderLandscape({
        ...noSlot(2 * MIN),
        timestamps: ['2026-04-13T19:40:00.000Z', '2026-04-13T19:45:00.000Z'],
      });
      expect(screen.getByText(SOME_PANELS)).toBeDefined();
      expect(screen.queryByText(/^DELAYED/)).toBeNull();
      expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0);
    });

    it('ignores a client clock that disagrees with the stamps: server says stalled, stamps look fresh', () => {
      renderLandscape({
        ...noSlot(6 * MIN),
        timestamps: [
          new Date(NOW - MIN).toISOString(),
          new Date(NOW).toISOString(),
        ],
      });
      expect(screen.getByText(/^Feed stalled/)).toBeDefined();
      expect(screen.getByText('DELAYED 5m')).toBeDefined();
    });

    it.each([
      [
        'no_spot',
        (): RenderOptions => ({
          ...noSlot(6 * MIN),
          freshness: freshnessOf({
            reason: 'no_spot',
            dataAgeMsAtReceipt: null,
            lastCaptureAgeMsAtReceipt: 6 * MIN,
          }),
        }),
      ],
      ['no captures today', (): RenderOptions => noSlot(null)],
      [
        'an unparseable stamp (the hook yields no age)',
        (): RenderOptions => ({
          ...noSlot(null),
          timestamps: ['garbage'],
        }),
      ],
    ])('keeps the generic text and no DELAYED for %s', (_label, build) => {
      renderLandscape(build());
      expect(screen.getByText(GENERIC)).toBeDefined();
      expect(screen.queryByText(/^DELAYED/)).toBeNull();
      expect(screen.queryByText(SOME_PANELS)).toBeNull();
    });

    it('names no capture time it does not have: the badge still shows the age, the message stays generic', () => {
      // The hook has an age, but the panel has not mirrored any capture
      // minute yet (it lags the hook by one render), so there is no time to
      // print after "last capture".
      renderLandscape({ ...noSlot(6 * MIN), timestamps: [] });
      expect(screen.getByText(GENERIC)).toBeDefined();
      expect(screen.queryByText(/^Feed stalled/)).toBeNull();
      expect(screen.getByText('DELAYED 5m')).toBeDefined();
    });
  });

  describe('where the age does not apply', () => {
    // Each gate on its own, against both a stale data response and a stale
    // `no_slot` one: no DELAYED, and the empty panel keeps its generic text.
    const gates: Array<
      [string, RenderOptions, Partial<GexLandscapeFreshness>]
    > = [
      ['the server says the market is closed', {}, { serverMarketOpen: false }],
      ['the market is closed', { marketOpen: false }, {}],
      ['the panel is scrubbed', { isScrubbed: true }, {}],
    ];

    // Each case first shows the stale panel live, so DELAYED or the message
    // is known to appear, then closes the one gate. (A panel scrubbed from
    // the start never mirrors the day's capture minutes, which would make
    // the no_slot case pass with the gate gone.)
    it.each(gates)('drops DELAYED on stale data when %s', (_l, opts, over) => {
      const stale = { dataAgeMsAtReceipt: 10 * MIN };
      const view = renderLandscape({ freshness: freshnessOf(stale) });
      expect(screen.getByText('DELAYED 10m')).toBeDefined();

      rerenderLandscape(view, {
        ...opts,
        freshness: freshnessOf({ ...stale, ...over }),
      });
      advance(TICK_MS);
      expect(screen.queryByText(/^DELAYED/)).toBeNull();
    });

    it.each(gates)(
      'drops the stalled-feed message on a stale no_slot when %s',
      (_l, opts, over) => {
        const base = noSlot(6 * MIN);
        const view = renderLandscape(base);
        expect(screen.getByText(/^Feed stalled/)).toBeDefined();

        rerenderLandscape(view, {
          ...base,
          ...opts,
          freshness: freshnessOf({
            reason: 'no_slot',
            dataAgeMsAtReceipt: null,
            lastCaptureAgeMsAtReceipt: 6 * MIN,
            ...over,
          }),
        });
        expect(screen.getByText(GENERIC)).toBeDefined();
        expect(screen.queryByText(/^Feed stalled/)).toBeNull();
        expect(screen.queryByText(/^DELAYED/)).toBeNull();
      },
    );

    it('leaving a scrub never shows the scrubbed response age, only the live one once it lands', () => {
      // While scrubbed the hook holds no freshness (the stored response came
      // from a scrub), and after leaving, none until the live one lands.
      const view = renderLandscape({ isScrubbed: true, freshness: null });
      expect(screen.queryByText(/^DELAYED/)).toBeNull();

      rerenderLandscape(view, { freshness: null });
      advance(5 * MIN);
      expect(screen.queryByText(/^DELAYED/)).toBeNull();
      expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0);

      rerenderLandscape(view, {
        freshness: freshnessOf({ dataAgeMsAtReceipt: 20_000 }),
      });
      expect(screen.queryByText(/^DELAYED/)).toBeNull();
      expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0);
    });
  });

  describe('the 15 s clock', () => {
    it('starts one interval while the age applies, and clears that interval on unmount', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      const { unmount } = renderLandscape({ freshness: freshnessOf() });

      const ids = tickIntervals(setIntervalSpy);
      expect(ids).toHaveLength(1);
      expect(clearIntervalSpy).not.toHaveBeenCalledWith(ids[0]);

      unmount();
      expect(clearIntervalSpy).toHaveBeenCalledWith(ids[0]);
    });

    it('clears the interval when the panel is scrubbed and starts none while it is', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      const stored = freshnessOf();
      const view = renderLandscape({ freshness: stored });
      const [first] = tickIntervals(setIntervalSpy);

      rerenderLandscape(view, { isScrubbed: true, freshness: stored });
      expect(clearIntervalSpy).toHaveBeenCalledWith(first);
      advance(10 * MIN);
      expect(tickIntervals(setIntervalSpy)).toHaveLength(1);

      // Leaving the scrub starts a fresh interval.
      rerenderLandscape(view, { freshness: stored });
      expect(tickIntervals(setIntervalSpy)).toHaveLength(2);
    });

    it('clears the interval when the market closes', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      const stored = freshnessOf();
      const view = renderLandscape({ freshness: stored });
      const [first] = tickIntervals(setIntervalSpy);

      rerenderLandscape(view, { marketOpen: false, freshness: stored });
      expect(clearIntervalSpy).toHaveBeenCalledWith(first);
      advance(10 * MIN);
      expect(screen.queryByText(/^DELAYED/)).toBeNull();
      expect(tickIntervals(setIntervalSpy)).toHaveLength(1);
    });

    // Each case builds its freshness inside the test, after the fake clock is
    // set: a table value would call `freshnessOf()` (and so `Date.now()`)
    // while the tests are being collected, on the real clock.
    it.each([
      ['there is no freshness yet', (): RenderOptions => ({ freshness: null })],
      [
        'the server says the market is closed',
        (): RenderOptions => ({
          freshness: freshnessOf({ serverMarketOpen: false }),
        }),
      ],
      [
        'the market is closed',
        (): RenderOptions => ({ marketOpen: false, freshness: freshnessOf() }),
      ],
      [
        'the panel is scrubbed',
        (): RenderOptions => ({ isScrubbed: true, freshness: freshnessOf() }),
      ],
    ])('starts no interval when %s', (_label, build) => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      renderLandscape(build());
      expect(tickIntervals(setIntervalSpy)).toHaveLength(0);
    });
  });
});
