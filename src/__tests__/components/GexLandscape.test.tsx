import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import GexLandscape from '../../components/GexLandscape';
import type { GexLandscapeProps } from '../../components/GexLandscape';
import { CollapseAllContext } from '../../components/collapse-context';
import type { CollapseSignal } from '../../components/collapse-context';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../../hooks/useIsOwner', () => ({ useIsOwner: () => true }));

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
  isToday: true,
  isScrubbed: false,
  canScrubPrev: false,
  canScrubNext: false,
  onScrubPrev: vi.fn(),
  onScrubNext: vi.fn(),
  onScrubLive: vi.fn(),
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
    it('marks the nearest strike to current price with SPOT label', () => {
      renderLandscape();
      expect(screen.getByText('← SPOT')).toBeDefined();
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
});
