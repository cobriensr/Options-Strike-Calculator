import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockUsePinSetupStatus = vi.fn();
vi.mock('../../hooks/usePinSetupStatus', () => ({
  usePinSetupStatus: () => mockUsePinSetupStatus(),
}));

import PinSetupTile from '../../components/PinSetupTile';
import type { PinSetupStatus } from '../../hooks/usePinSetupStatus';

const SETDATE = vi.fn();
const REFRESH = vi.fn();

function makeStatus(overrides: Partial<PinSetupStatus> = {}): PinSetupStatus {
  return {
    evaluatedAt: '2026-05-14T20:30:00.000Z',
    date: null,
    mode: 'live',
    snapshotTs: '2026-05-14T20:29:00.000Z',
    staleMinutes: 1,
    state: 'ARMED',
    conditions: {
      netGammaAtMagnetM: 41751,
      netGammaThresholdM: 20000,
      netGammaMet: true,
      magnetStrike: 7500,
      isRound50: true,
      distanceToMagnet: -0.9,
      distanceThreshold: 15,
      distanceMet: true,
    },
    spot: 7499.1,
    bias: 'full-pin',
    recommendedTradeTypes: [
      'iron_condor',
      'iron_butterfly',
      'broken_wing_butterfly',
    ],
    avoidedTradeTypes: ['directional_long_call'],
    trajectory: [
      { ts: '13:31', gammaDirM: 1000, spot: 7460 },
      { ts: '14:00', gammaDirM: 5000, spot: 7480 },
      { ts: '14:30', gammaDirM: 9000, spot: 7500 },
    ],
    outcome: null,
    asOf: '2026-05-14T20:30:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  SETDATE.mockReset();
  REFRESH.mockReset();
  mockUsePinSetupStatus.mockReset();
});

function mockHook(
  data: PinSetupStatus | null,
  overrides: Partial<{
    loading: boolean;
    error: string | null;
    date: string | null;
  }> = {},
) {
  mockUsePinSetupStatus.mockReturnValue({
    data,
    loading: overrides.loading ?? false,
    error: overrides.error ?? null,
    date: overrides.date ?? null,
    setDate: SETDATE,
    refresh: REFRESH,
  });
}

describe('PinSetupTile', () => {
  // ── Loading / error ────────────────────────────────────────

  it('shows loading state when no data and loading=true', () => {
    mockHook(null, { loading: true });
    render(<PinSetupTile marketOpen={false} />);
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it('shows error message when fetch fails and no data', () => {
    mockHook(null, { error: 'HTTP 500' });
    render(<PinSetupTile marketOpen={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500');
  });

  // ── ARMED full-pin (today's example) ────────────────────────

  it('renders ARMED state with magnet, γ, spot, distance, bias', () => {
    mockHook(makeStatus());
    render(<PinSetupTile marketOpen={true} />);
    expect(screen.getByTestId('pin-setup-state-badge')).toHaveTextContent(
      'ARMED',
    );
    expect(screen.getByText('7500')).toBeInTheDocument();
    const detail = screen.getByTestId('pin-setup-detail');
    expect(detail).toHaveTextContent('41.8B γ');
    expect(detail).toHaveTextContent('spot 7499.1');
    expect(detail).toHaveTextContent('-0.9 from magnet');
    expect(screen.getByText('FULL PIN')).toBeInTheDocument();
    expect(screen.getByText(/Iron condors and BWBs/)).toBeInTheDocument();
  });

  it('shows recommended trade-type chips (max 3)', () => {
    mockHook(makeStatus());
    render(<PinSetupTile marketOpen={true} />);
    expect(screen.getByText(/iron condor/)).toBeInTheDocument();
    expect(screen.getByText(/iron butterfly/)).toBeInTheDocument();
    expect(screen.getByText(/broken wing butterfly/)).toBeInTheDocument();
  });

  // ── WATCH ──────────────────────────────────────────────────

  it('renders WATCH state with caution color and fade bias', () => {
    mockHook(
      makeStatus({
        state: 'WATCH',
        bias: 'fade-rips',
        conditions: {
          netGammaAtMagnetM: 25000,
          netGammaThresholdM: 20000,
          netGammaMet: true,
          magnetStrike: 7415,
          isRound50: false,
          distanceToMagnet: 4,
          distanceThreshold: 15,
          distanceMet: true,
        },
        spot: 7419,
      }),
    );
    render(<PinSetupTile marketOpen={true} />);
    expect(screen.getByTestId('pin-setup-state-badge')).toHaveTextContent(
      'WATCH',
    );
    expect(screen.getByText('FADE RIPS')).toBeInTheDocument();
    expect(screen.getByText('7415')).toBeInTheDocument();
  });

  // ── NOT_TRIGGERED ──────────────────────────────────────────

  it('renders NOT_TRIGGERED with no-signal explanation', () => {
    mockHook(
      makeStatus({
        state: 'NOT_TRIGGERED',
        bias: 'no-signal',
        conditions: {
          netGammaAtMagnetM: 0,
          netGammaThresholdM: 20000,
          netGammaMet: false,
          magnetStrike: null,
          isRound50: false,
          distanceToMagnet: null,
          distanceThreshold: 15,
          distanceMet: false,
        },
        recommendedTradeTypes: [
          'directional_long_call',
          'directional_long_put',
        ],
      }),
    );
    render(<PinSetupTile marketOpen={true} />);
    expect(screen.getByTestId('pin-setup-state-badge')).toHaveTextContent(
      'NOT TRIGGERED',
    );
    expect(screen.getByText('NO SIGNAL')).toBeInTheDocument();
    expect(screen.getByText(/No structural wall today/)).toBeInTheDocument();
  });

  // ── Stale indicator ────────────────────────────────────────

  it('shows STALE badge when staleMinutes > 30 during market', () => {
    mockHook(makeStatus({ staleMinutes: 45 }));
    render(<PinSetupTile marketOpen={true} />);
    expect(screen.getByText(/stale 45m/i)).toBeInTheDocument();
  });

  it('does NOT show STALE badge when market is closed', () => {
    mockHook(makeStatus({ staleMinutes: 999 }));
    render(<PinSetupTile marketOpen={false} />);
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument();
  });

  it('does NOT show STALE badge in historical mode even with market open', () => {
    mockHook(
      makeStatus({
        mode: 'historical',
        date: '2026-05-14',
        staleMinutes: 9999,
        outcome: { settle: 7499.1, settleVsMagnet: -0.9 },
      }),
      { date: '2026-05-14' },
    );
    render(<PinSetupTile marketOpen={true} />);
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument();
  });

  // ── Historical mode ────────────────────────────────────────

  it('renders outcome row in historical mode', () => {
    mockHook(
      makeStatus({
        mode: 'historical',
        date: '2026-05-14',
        outcome: { settle: 7499.1, settleVsMagnet: -0.9 },
      }),
      { date: '2026-05-14' },
    );
    render(<PinSetupTile marketOpen={false} />);
    expect(screen.getByText(/settled/i)).toBeInTheDocument();
    expect(screen.getByText('7499.10')).toBeInTheDocument();
    expect(screen.getByText(/-0.90 from magnet/)).toBeInTheDocument();
  });

  it('shows Live button only when a historical date is set', () => {
    mockHook(makeStatus(), { date: null });
    const { rerender } = render(<PinSetupTile marketOpen={true} />);
    expect(screen.queryByRole('button', { name: /^Live$/i })).toBeNull();

    mockHook(makeStatus({ date: '2026-05-14', mode: 'historical' }), {
      date: '2026-05-14',
    });
    rerender(<PinSetupTile marketOpen={false} />);
    expect(screen.getByRole('button', { name: /^Live$/i })).toBeInTheDocument();
  });

  // ── Date picker interactions ───────────────────────────────

  it('invokes setDate when the user picks a date', async () => {
    mockHook(makeStatus());
    render(<PinSetupTile marketOpen={false} />);
    const input = screen.getByLabelText(/^Date$/i) as HTMLInputElement;
    await userEvent.type(input, '2026-05-14');
    // userEvent.type fires per-char; the final call should be the full string
    expect(SETDATE).toHaveBeenCalled();
  });

  it('invokes setDate(null) when Live button is clicked', async () => {
    mockHook(makeStatus({ date: '2026-05-14', mode: 'historical' }), {
      date: '2026-05-14',
    });
    render(<PinSetupTile marketOpen={false} />);
    await userEvent.click(screen.getByRole('button', { name: /^Live$/i }));
    expect(SETDATE).toHaveBeenCalledWith(null);
  });

  it('invokes refresh when refresh button is clicked', async () => {
    mockHook(makeStatus());
    render(<PinSetupTile marketOpen={true} />);
    await userEvent.click(
      screen.getByRole('button', { name: /Refresh pin setup data/i }),
    );
    expect(REFRESH).toHaveBeenCalled();
  });
});
