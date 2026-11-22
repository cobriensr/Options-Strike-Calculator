// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { FireRow } from '../components/GammaNodeDetector/FireRow';
import { DayConfidenceBanner } from '../components/GammaNodeDetector/DayConfidenceBanner';
import type {
  GammaSetupFire,
  GammaSetupsResponse,
  SignalType,
} from '../hooks/useGammaSetups';
import {
  srHintText,
  titledElementsNeedingHint,
  titledGenericsWithoutHint,
} from './helpers/aria';

// ── Fixture builders ───────────────────────────────────────────

function makeFire(overrides: Partial<GammaSetupFire> = {}): GammaSetupFire {
  return {
    id: 1,
    fired_at: '2026-05-21T14:30:00Z',
    signal_type: 'e1_long_call',
    dow_label: 'Thursday',
    confidence_tier: 'MEDIUM',
    spot_at_fire: 7401,
    node_strike: 7400,
    node_gex: 300_000,
    bar_open: 7395,
    bar_high: 7402,
    bar_low: 7394,
    bar_close: 7401,
    bar_range: 8,
    es_basis_change_5m: 0.5,
    ret_15m: null,
    ret_30m: null,
    ret_60m: null,
    ret_eod: null,
    trade_taken: false,
    trade_pnl_dollars: null,
    ...overrides,
  };
}

function makeResponse(
  overrides: Partial<GammaSetupsResponse> = {},
): GammaSetupsResponse {
  return {
    today: '2026-05-21',
    paused: false,
    paused_reason: null,
    dow_label: 'Thursday',
    confidence_tier: 'MEDIUM',
    pre_day_filter_fires: false,
    prior_5d_ret: 0.005,
    prior_iv_rank: 22,
    open_gap_pct: 0.15,
    anti_filters: {
      is_fomc_day: false,
      is_dom_1_5: false,
      is_dom_16_20: false,
    },
    nearest_floor: { strike: 7390, gex: 250_000 },
    nearest_ceiling: { strike: 7415, gex: 400_000 },
    fires: [],
    ...overrides,
  };
}

// ── FireRow ───────────────────────────────────────────────────

describe('FireRow', () => {
  it('renders E1 signal type with strike + setup description', () => {
    render(<FireRow fire={makeFire({ signal_type: 'e1_long_call' })} />);
    expect(screen.getByText('E1')).toBeDefined();
    expect(screen.getByText(/Strike 7400/)).toBeDefined();
    expect(screen.getByText(/breakthrough confirmed/)).toBeDefined();
  });

  it('renders E5 signal with failed-bounce description', () => {
    render(<FireRow fire={makeFire({ signal_type: 'e5_long_put' })} />);
    expect(screen.getByText('E5')).toBeDefined();
    expect(screen.getByText(/failed-bounce breakdown/)).toBeDefined();
  });

  it('renders PCS signal with ES basis when present', () => {
    render(
      <FireRow
        fire={makeFire({ signal_type: 'pcs_monday', es_basis_change_5m: 0.8 })}
      />,
    );
    expect(screen.getByText('PCS')).toBeDefined();
    expect(screen.getByText(/ES basis \+0\.8/)).toBeDefined();
  });

  it('renders PCS signal without ES basis when null', () => {
    render(
      <FireRow
        fire={makeFire({ signal_type: 'pcs_monday', es_basis_change_5m: null })}
      />,
    );
    expect(screen.getByText(/ES basis n\/a/)).toBeDefined();
  });

  it('shows realized return when ret_30m is set', () => {
    render(<FireRow fire={makeFire({ ret_30m: 5.4 })} />);
    expect(screen.getByText(/\+5\.4 pts/)).toBeDefined();
  });

  it('omits realized return when ret_30m is null (pending outcome)', () => {
    render(<FireRow fire={makeFire({ ret_30m: null })} />);
    expect(screen.queryByText(/pts @/)).toBeNull();
  });

  it('renders the fired_at in America/Chicago HH:MM format', () => {
    // 14:30 UTC = 09:30 CT (CDT in May)
    render(<FireRow fire={makeFire({ fired_at: '2026-05-21T14:30:00Z' })} />);
    expect(screen.getByText(/09:30 CT/)).toBeDefined();
  });

  it('tags a fire from the GEXBot era with a data-source chip', () => {
    render(<FireRow fire={makeFire({ fired_at: '2026-06-02T14:30:00Z' })} />);
    expect(screen.getByText('GEXBot data')).toBeInTheDocument();
  });

  it('does not tag a scraper-era fire', () => {
    render(<FireRow fire={makeFire({ fired_at: '2026-05-21T14:30:00Z' })} />);
    expect(screen.queryByText('GEXBot data')).toBeNull();
  });

  // A hint is read in every row of the fire list, so each stays short.
  const ROW_HINT_MAX = 60;

  describe('hover text for screen readers', () => {
    it.each<[SignalType, string, string, string]>([
      [
        'e1_long_call',
        'E1',
        'long call on +γ ceiling breakthrough + 3-bar hold',
        'E1 — Long call on +γ ceiling breakthrough + 3-bar hold',
      ],
      [
        'e5_long_put',
        'E5',
        'long put on failed-reversal breakdown of +γ floor',
        'E5 — Long put on failed-reversal breakdown of +γ floor',
      ],
      [
        'pcs_monday',
        'PCS',
        'put credit spread on Monday +γ floor rejection',
        'PCS — Put credit spread on Monday +γ floor rejection',
      ],
    ])(
      'gives the %s badge a hint and keeps its title',
      (signal, label, hint, title) => {
        render(<FireRow fire={makeFire({ signal_type: signal })} />);
        const badge = screen.getByText(label);
        expect(srHintText(badge)).toBe(hint);
        expect(srHintText(badge)!.length).toBeLessThanOrEqual(ROW_HINT_MAX);
        expect(badge).toHaveAttribute('title', title);
        // The row's own text must not pick up the hint as a second match.
        expect(screen.getAllByText(label)).toHaveLength(1);
      },
    );

    it('gives the GEXBot data badge a hint and keeps its title', () => {
      render(<FireRow fire={makeFire({ fired_at: '2026-06-02T14:30:00Z' })} />);
      const chip = screen.getByText('GEXBot data');
      expect(srHintText(chip)).toBe(
        'GEXBot taker flow; rules were tuned on UW Periscope data',
      );
      expect(srHintText(chip)!.length).toBeLessThanOrEqual(ROW_HINT_MAX);
      expect(chip).toHaveAttribute(
        'title',
        'Fired on GEXBot taker-flow data; the E1/E5/PCS rules were tuned on UW Periscope data.',
      );
    });

    it('gives the realized-return text a hint and keeps its title', () => {
      render(<FireRow fire={makeFire({ ret_30m: 5.4 })} />);
      const outcome = screen.getByText('+5.4 pts @ +30m');
      expect(srHintText(outcome)).toBe(
        'direction-adjusted return from the fire bar close',
      );
      expect(srHintText(outcome)!.length).toBeLessThanOrEqual(ROW_HINT_MAX);
      expect(outcome).toHaveAttribute(
        'title',
        'Realized direction-adjusted return at +30m vs fire bar close',
      );
    });

    it('leaves no titled generic element without a hint when the badge, the data-source chip and the outcome all show', () => {
      const { container } = render(
        <FireRow
          fire={makeFire({ fired_at: '2026-06-02T14:30:00Z', ret_30m: -2.5 })}
        />,
      );
      // The badge, the data-source chip and the outcome: all three reached.
      expect(titledElementsNeedingHint(container)).toHaveLength(3);
      expect(titledGenericsWithoutHint(container)).toEqual([]);
    });
  });
});

describe('DayConfidenceBanner', () => {
  it('renders DOW + MEDIUM tier on a non-filter day', () => {
    render(<DayConfidenceBanner data={makeResponse()} />);
    expect(screen.getByText('Thursday')).toBeDefined();
    expect(screen.getByText('MEDIUM')).toBeDefined();
    expect(screen.getByText(/pre-day filter inactive/)).toBeDefined();
  });

  it('shows MAXIMUM tier when filter is active', () => {
    render(
      <DayConfidenceBanner
        data={makeResponse({
          dow_label: 'Monday',
          confidence_tier: 'MAXIMUM',
          pre_day_filter_fires: true,
          prior_5d_ret: -0.018,
          prior_iv_rank: 32,
        })}
      />,
    );
    expect(screen.getByText('Monday')).toBeDefined();
    expect(screen.getByText('MAXIMUM')).toBeDefined();
    expect(screen.getByText(/pre-day filter active/)).toBeDefined();
    expect(screen.getByText(/prior 5d: -1\.80%/)).toBeDefined();
    expect(screen.getByText(/iv rank: 32/)).toBeDefined();
  });

  it('renders FOMC anti-filter chip', () => {
    render(
      <DayConfidenceBanner
        data={makeResponse({
          anti_filters: {
            is_fomc_day: true,
            is_dom_1_5: false,
            is_dom_16_20: false,
          },
        })}
      />,
    );
    expect(screen.getByText('FOMC DAY')).toBeDefined();
  });

  it('renders DOM 1-5 and DOM 16-20 chips when active', () => {
    render(
      <DayConfidenceBanner
        data={makeResponse({
          anti_filters: {
            is_fomc_day: false,
            is_dom_1_5: true,
            is_dom_16_20: true,
          },
        })}
      />,
    );
    expect(screen.getByText('DOM 1-5')).toBeDefined();
    expect(screen.getByText('DOM 16-20')).toBeDefined();
  });

  it('renders the nearest floor + ceiling strike context', () => {
    render(<DayConfidenceBanner data={makeResponse()} />);
    expect(screen.getByText(/ceiling 7415/)).toBeDefined();
    expect(screen.getByText(/floor 7390/)).toBeDefined();
  });

  it('renders "Weekend" placeholder when DOW is null', () => {
    render(
      <DayConfidenceBanner
        data={makeResponse({ dow_label: null, confidence_tier: null })}
      />,
    );
    expect(screen.getByText('Weekend')).toBeDefined();
  });

  describe('hover text for screen readers', () => {
    const firingData = (): GammaSetupsResponse =>
      makeResponse({
        dow_label: 'Monday',
        confidence_tier: 'MAXIMUM',
        pre_day_filter_fires: true,
        prior_5d_ret: -0.018,
        prior_iv_rank: 32,
        anti_filters: {
          is_fomc_day: true,
          is_dom_1_5: true,
          is_dom_16_20: true,
        },
      });

    it('explains the firing pre-day filter without repeating its label', () => {
      render(<DayConfidenceBanner data={firingData()} />);
      const line = screen.getByText(/pre-day filter active/);
      expect(srHintText(line)).toBe(
        'fires when the prior 5-day return is below -1% and the prior IV rank is above 25',
      );
      expect(line).toHaveAttribute(
        'title',
        'Pre-day filter is firing: prior 5d return < -1% AND prior IV rank > 25',
      );
    });

    it('explains the inactive pre-day filter without repeating its label', () => {
      render(<DayConfidenceBanner data={makeResponse()} />);
      const line = screen.getByText('pre-day filter inactive');
      expect(srHintText(line)).toBe(
        'needs the prior 5-day return below -1% and the prior IV rank above 25 to fire',
      );
      expect(line).toHaveAttribute(
        'title',
        'Pre-day filter inactive — requires prior 5d return < -1% AND prior IV rank > 25',
      );
    });

    it.each([
      [
        'FOMC DAY',
        'FOMC days historically destroy the E1 long-call edge (-13.75 Δ in backtest, n=4)',
      ],
      [
        'DOM 1-5',
        'Early-month days break E5 long-put edge (-18.82 Δ in backtest, n=12)',
      ],
      [
        'DOM 16-20',
        'Mid-month gamma void weakens E1 long-call edge (-1.43 Δ in backtest, n=24)',
      ],
    ])('gives the %s chip its explanation as a hint', (label, text) => {
      render(<DayConfidenceBanner data={firingData()} />);
      const chip = screen.getByText(label);
      expect(srHintText(chip)).toBe(text);
      expect(chip).toHaveAttribute('title', text);
    });

    it('explains the ceiling and the floor', () => {
      render(<DayConfidenceBanner data={makeResponse()} />);
      const ceiling = screen.getByText(/ceiling 7415/);
      const floor = screen.getByText(/floor 7390/);
      expect(srHintText(ceiling)).toBe(
        'nearest positive-gamma strike above current spot',
      );
      expect(srHintText(floor)).toBe(
        'nearest positive-gamma strike below current spot',
      );
      expect(ceiling).toHaveAttribute(
        'title',
        'Nearest positive-γ ceiling above current spot',
      );
      expect(floor).toHaveAttribute(
        'title',
        'Nearest positive-γ floor below current spot',
      );
    });

    it('names the no-tier dash and says it is a weekend case', () => {
      render(
        <DayConfidenceBanner
          data={makeResponse({ dow_label: null, confidence_tier: null })}
        />,
      );
      const dash = screen.getByRole('img', {
        name: 'no confidence tier on weekends',
      });
      expect(dash).toHaveTextContent('—');
      expect(dash).toHaveAttribute('title', 'No confidence tier on weekends');
    });

    it('shows no no-tier dash when the day has a tier', () => {
      render(<DayConfidenceBanner data={makeResponse()} />);
      expect(screen.queryByRole('img')).toBeNull();
    });

    it.each([
      [
        'a firing filter with every anti-filter chip and a floor and ceiling',
        firingData,
      ],
      [
        'an inactive filter with no tier, no chips and no floor or ceiling',
        () =>
          makeResponse({
            dow_label: null,
            confidence_tier: null,
            nearest_floor: null,
            nearest_ceiling: null,
          }),
      ],
    ])('leaves no titled generic element without a hint: %s', (_n, build) => {
      const { container } = render(<DayConfidenceBanner data={build()} />);
      expect(titledGenericsWithoutHint(container)).toEqual([]);
    });

    it('reaches every hinted element when everything shows', () => {
      const { container } = render(<DayConfidenceBanner data={firingData()} />);
      // pre-day line, three chips, ceiling and floor.
      expect(titledElementsNeedingHint(container)).toHaveLength(6);
    });
  });
});
