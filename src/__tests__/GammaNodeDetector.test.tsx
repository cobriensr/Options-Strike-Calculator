// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { FireRow } from '../components/GammaNodeDetector/FireRow';
import { DayConfidenceBanner } from '../components/GammaNodeDetector/DayConfidenceBanner';
import type {
  GammaSetupFire,
  GammaSetupsResponse,
} from '../hooks/useGammaSetups';

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
});

// ── DayConfidenceBanner ─────────────────────────────────────────

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
});
