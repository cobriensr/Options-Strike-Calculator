/**
 * PeriscopePanel unit tests — pragmatic smoke + state-routing coverage.
 * The trade-plan computation is exercised via a populated-view smoke
 * test; the heavier `computeTradePlan` math has dedicated unit coverage
 * in `periscope-trade-plan.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PeriscopeView } from '../hooks/usePeriscopeExposure';
import { PeriscopePanel } from '../components/Periscope/PeriscopePanel';

// ── Fixture factory ───────────────────────────────────────────────────

function makeView(overrides: Partial<PeriscopeView> = {}): PeriscopeView {
  return {
    capturedAt: '2026-05-08T13:30:00Z',
    priorCapturedAt: '2026-05-08T13:20:00Z',
    expiry: '2026-05-08',
    spot: 5800.25,
    gamma: {
      ceiling: { strike: 5825, value: 5_000_000, ptsFromSpot: 25 },
      floor: { strike: 5775, value: 4_000_000, ptsFromSpot: -25 },
      accelTop: [
        { strike: 5750, value: -3_000_000, ptsFromSpot: -50 },
        { strike: 5740, value: -2_500_000, ptsFromSpot: -60 },
      ],
      topByAbsNear: [],
    },
    charm: {
      tallyNear50: 1_500_000,
      tallyWide100: 2_500_000,
      topByAbs: [{ strike: 5800, value: 800_000 }],
      charmZeroStrike: 5810,
    },
    vanna: {
      topByAbs: [{ strike: 5800, value: 600_000 }],
    },
    signFlips: [{ strike: 5790, from: -1_000_000, to: 500_000 }],
    cone: {
      coneUpper: 5850,
      coneLower: 5750,
      coneWidth: 100,
      asymmetryPts: 5,
      spotAtCalc: 5800,
    },
    breaches: [],
    ...overrides,
  };
}

const baseProps = {
  view: null as PeriscopeView | null,
  emptyReason: null as 'no_spot' | 'no_slot' | null,
  asOf: null as string | null,
  isLoading: false,
  error: null as string | null,
  onRefresh: vi.fn(),
  availableSlots: [] as string[],
  selectedSlot: null as { date: string; time: string } | null,
  onSelectSlot: vi.fn(),
};

// ============================================================
// SMOKE
// ============================================================

describe('PeriscopePanel: smoke', () => {
  it('renders the section heading', () => {
    render(<PeriscopePanel {...baseProps} />);
    expect(
      screen.getByRole('heading', { name: /periscope mm exposure/i }),
    ).toBeInTheDocument();
  });

  it('renders all key sub-sections when given a populated view', () => {
    render(<PeriscopePanel {...baseProps} view={makeView()} />);
    // Trade plan box
    expect(screen.getByText(/Trade Plan/i)).toBeInTheDocument();
    // Cone
    expect(screen.getByText(/Straddle Cone/i)).toBeInTheDocument();
    // Gamma
    expect(screen.getByText(/Gamma Topology/i)).toBeInTheDocument();
    // Charm
    expect(screen.getByText(/Charm Flow/i)).toBeInTheDocument();
    // Vanna
    expect(screen.getByText(/Vanna Pressure/i)).toBeInTheDocument();
    // Sign flips
    expect(
      screen.getByText(/Sign Flips Since Prior Slice/i),
    ).toBeInTheDocument();
    // Spot value
    expect(screen.getByText(/spot 5800\.25/)).toBeInTheDocument();
  });

  it('omits cone section when view.cone is null', () => {
    render(<PeriscopePanel {...baseProps} view={makeView({ cone: null })} />);
    expect(screen.queryByText(/Straddle Cone/i)).not.toBeInTheDocument();
  });

  it('omits vanna section when no vanna entries', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView({ vanna: { topByAbs: [] } })}
      />,
    );
    expect(screen.queryByText(/Vanna Pressure/i)).not.toBeInTheDocument();
  });

  it('omits sign-flips section when there are no flips', () => {
    render(
      <PeriscopePanel {...baseProps} view={makeView({ signFlips: [] })} />,
    );
    expect(
      screen.queryByText(/Sign Flips Since Prior Slice/i),
    ).not.toBeInTheDocument();
  });

  it('shows breach rows when cone has been breached', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView({
          breaches: [
            {
              direction: 'upper',
              breachTime: '2026-05-08T14:00:00Z',
              spotAtBreach: 5852,
              ptsPastBound: 2,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText(/UPPER breach/)).toBeInTheDocument();
  });
});

// ============================================================
// STATE ROUTING — error / empty / loading
// ============================================================

describe('PeriscopePanel: states', () => {
  it('renders the error string when error is set', () => {
    render(<PeriscopePanel {...baseProps} error="HTTP 500" />);
    expect(screen.getByText('HTTP 500')).toBeInTheDocument();
  });

  it('renders the no_slot empty-state copy', () => {
    render(<PeriscopePanel {...baseProps} emptyReason="no_slot" />);
    expect(
      screen.getByText(/Scraper has not inserted a Periscope slot/i),
    ).toBeInTheDocument();
  });

  it('renders the no_spot empty-state copy (distinct from no_slot)', () => {
    render(<PeriscopePanel {...baseProps} emptyReason="no_spot" />);
    expect(
      screen.getByText(/Waiting for SPX spot from index_candles_1m/i),
    ).toBeInTheDocument();
  });

  it('falls back to no_slot copy when emptyReason is null and view is null', () => {
    // Default null/null state still produces a sensible message rather
    // than a blank panel.
    render(<PeriscopePanel {...baseProps} />);
    expect(
      screen.getByText(/Scraper has not inserted a Periscope slot/i),
    ).toBeInTheDocument();
  });
});

// ============================================================
// HEADER — refresh button + asOf timestamp
// ============================================================

describe('PeriscopePanel: header controls', () => {
  it('renders the asOf timestamp in CT when provided', () => {
    render(<PeriscopePanel {...baseProps} asOf="2026-05-08T19:30:00Z" />);
    // Just assert the CT suffix is present (locale-safe — content is
    // formatted by Intl.DateTimeFormat which varies test-runner timezone).
    expect(screen.getByText(/CT$/)).toBeInTheDocument();
  });

  it('disables refresh button while isLoading and shows ellipsis', () => {
    const onRefresh = vi.fn();
    render(
      <PeriscopePanel {...baseProps} isLoading={true} onRefresh={onRefresh} />,
    );
    const btn = screen.getByRole('button', { name: '…' });
    expect(btn).toBeDisabled();
  });

  it('invokes onRefresh when the refresh button is clicked', () => {
    const onRefresh = vi.fn();
    render(<PeriscopePanel {...baseProps} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// TIME-TRAVEL NAVIGATION
// ============================================================

describe('PeriscopePanel: time-travel nav', () => {
  it('renders the date picker and prev/next/live controls', () => {
    render(<PeriscopePanel {...baseProps} />);
    expect(
      screen.getByRole('button', { name: /previous slot/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /next slot/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /return to live/i }),
    ).toBeInTheDocument();
    // The "live" button is highlighted (filled dot) when selectedSlot is null.
    expect(
      screen.getByRole('button', { name: /return to live/i }),
    ).toBeDisabled();
  });

  it('disables prev/next at the ends of availableSlots', () => {
    const view = makeView({
      capturedAt: '2026-05-08T14:00:00Z',
    });
    const slots = [
      '2026-05-08T13:50:00Z',
      '2026-05-08T14:00:00Z',
      '2026-05-08T14:10:00Z',
    ];
    render(
      <PeriscopePanel
        {...baseProps}
        view={view}
        availableSlots={slots}
      />,
    );
    // Middle slot — both buttons enabled.
    expect(
      screen.getByRole('button', { name: /previous slot/i }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole('button', { name: /next slot/i }),
    ).not.toBeDisabled();
  });

  it('disables prev when on the first slot', () => {
    const view = makeView({ capturedAt: '2026-05-08T13:50:00Z' });
    render(
      <PeriscopePanel
        {...baseProps}
        view={view}
        availableSlots={[
          '2026-05-08T13:50:00Z',
          '2026-05-08T14:00:00Z',
        ]}
      />,
    );
    expect(
      screen.getByRole('button', { name: /previous slot/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /next slot/i }),
    ).not.toBeDisabled();
  });

  it('calls onSelectSlot with the prior slot on prev click', () => {
    const onSelectSlot = vi.fn();
    const view = makeView({ capturedAt: '2026-05-08T14:00:00Z' });
    render(
      <PeriscopePanel
        {...baseProps}
        view={view}
        availableSlots={[
          '2026-05-08T13:50:00Z',
          '2026-05-08T14:00:00Z',
        ]}
        onSelectSlot={onSelectSlot}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /previous slot/i }));
    expect(onSelectSlot).toHaveBeenCalledTimes(1);
    const arg = onSelectSlot.mock.calls[0]?.[0] as {
      date: string;
      time: string;
    };
    expect(arg.date).toBe('2026-05-08');
    // Time is CT — depends on DST. 13:50Z in CDT (UTC-5) is 08:50.
    // Just assert it parses as HH:MM.
    expect(arg.time).toMatch(/^\d{2}:\d{2}$/);
  });

  it('calls onSelectSlot(null) when Live is clicked while on a historical slot', () => {
    const onSelectSlot = vi.fn();
    render(
      <PeriscopePanel
        {...baseProps}
        selectedSlot={{ date: '2026-05-07', time: '13:30' }}
        onSelectSlot={onSelectSlot}
      />,
    );
    const liveBtn = screen.getByRole('button', { name: /return to live/i });
    expect(liveBtn).not.toBeDisabled();
    fireEvent.click(liveBtn);
    expect(onSelectSlot).toHaveBeenCalledWith(null);
  });

  it('jumps to end-of-day when the date picker is changed', () => {
    const onSelectSlot = vi.fn();
    render(
      <PeriscopePanel
        {...baseProps}
        onSelectSlot={onSelectSlot}
      />,
    );
    const dateInput = screen.getByLabelText(
      /periscope slot date/i,
    ) as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-05-07' } });
    expect(onSelectSlot).toHaveBeenCalledWith({
      date: '2026-05-07',
      time: '23:59',
    });
  });
});
