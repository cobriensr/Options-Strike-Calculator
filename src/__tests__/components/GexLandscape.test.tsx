import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import GexLandscape from '../../components/GexLandscape';
import type { GexLandscapeProps } from '../../components/GexLandscape';
import { CollapseAllContext } from '../../components/collapse-context';
import type { CollapseSignal } from '../../components/collapse-context';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../../utils/auth', () => ({ checkIsOwner: () => true }));

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeStrike(
  strike: number,
  price: number,
  netGamma: number,
  netCharm: number,
  volReinforcement: 'reinforcing' | 'opposing' | 'neutral' = 'neutral',
) {
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

const baseStrikes = [
  // Ceiling: neg gamma + pos charm → Max Launchpad
  makeStrike(6910, PRICE, -50_000_000, 20_000_000, 'reinforcing'),
  // Spot area: pos gamma + pos charm → Sticky Pin
  makeStrike(PRICE, PRICE, 80_000_000, 30_000_000, 'neutral'),
  // Floor: pos gamma + neg charm → Weakening Pin
  makeStrike(6850, PRICE, 60_000_000, -15_000_000, 'opposing'),
  // Far floor: neg gamma + neg charm → Fading Launchpad
  makeStrike(6820, PRICE, -40_000_000, -10_000_000, 'neutral'),
];

const defaultProps: GexLandscapeProps = {
  strikes: baseStrikes,
  loading: false,
  error: null,
  timestamp: '2026-04-13T19:45:00.000Z',
  onRefresh: vi.fn(),
  selectedDate: '2026-04-13',
  onDateChange: vi.fn(),
  isLive: true,
  isScrubbed: false,
  canScrubPrev: false,
  canScrubNext: false,
  onScrubPrev: vi.fn(),
  onScrubNext: vi.fn(),
  onScrubTo: vi.fn(),
  onScrubLive: vi.fn(),
  timestamps: ['2026-04-13T19:40:00.000Z', '2026-04-13T19:45:00.000Z'],
};

const collapseSignal: CollapseSignal = { version: 0, collapsed: false };

function renderLandscape(overrides: Partial<GexLandscapeProps> = {}) {
  return render(
    <CollapseAllContext.Provider value={collapseSignal}>
      <GexLandscape {...defaultProps} {...overrides} />
    </CollapseAllContext.Provider>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GexLandscape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('classification labels', () => {
    it('shows Max Launchpad for negative gamma + positive charm', () => {
      renderLandscape();
      expect(screen.getAllByText('Max Launchpad').length).toBeGreaterThan(0);
    });

    it('shows Sticky Pin for positive gamma + positive charm', () => {
      renderLandscape();
      expect(screen.getAllByText('Sticky Pin').length).toBeGreaterThan(0);
    });

    it('shows Weakening Pin for positive gamma + negative charm', () => {
      renderLandscape();
      expect(screen.getAllByText('Weakening Pin').length).toBeGreaterThan(0);
    });

    it('shows Fading Launchpad for negative gamma + negative charm', () => {
      renderLandscape();
      expect(screen.getAllByText('Fading Launchpad').length).toBeGreaterThan(0);
    });
  });

  describe('direction signals', () => {
    it('labels ceiling strikes as Ceiling Breakout Risk for Max Launchpad', () => {
      renderLandscape();
      expect(screen.getByText('Ceiling Breakout Risk')).toBeDefined();
    });

    it('labels floor strikes as Softening Floor for Weakening Pin', () => {
      renderLandscape();
      expect(screen.getByText('Softening Floor')).toBeDefined();
    });
  });

  describe('spot indicator', () => {
    it('marks the nearest strike to current price with ATM label', () => {
      renderLandscape();
      // "ATM" may appear in both the spot row and the GEX Gravity panel
      // (when the gravity strike is at spot). At least one must exist.
      expect(screen.getAllByText('ATM').length).toBeGreaterThan(0);
    });
  });

  describe('vol reinforcement', () => {
    it('shows checkmark for reinforcing vol', () => {
      renderLandscape();
      const checkmarks = screen.getAllByLabelText('Volume reinforcing');
      expect(checkmarks.length).toBeGreaterThan(0);
    });

    it('shows X for opposing vol', () => {
      renderLandscape();
      const opposing = screen.getAllByLabelText('Volume opposing');
      expect(opposing.length).toBeGreaterThan(0);
    });

    it('shows circle for neutral vol', () => {
      renderLandscape();
      const neutral = screen.getAllByLabelText('Volume neutral');
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
      expect(screen.getAllByText('Max Launchpad').length).toBeGreaterThan(0);
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
      renderLandscape({ isLive: true });
      // SectionBox label + LIVE badge — at least one LIVE text
      const live = screen.getAllByText('LIVE');
      expect(live.length).toBeGreaterThan(0);
    });

    it('renders SCRUBBED badge when isScrubbed', () => {
      renderLandscape({ isLive: false, isScrubbed: true });
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
  });
});
