import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ZeroGammaPanel } from '../index';
import type {
  UseZeroGammaReturn,
  ZeroGammaRow,
} from '../../../hooks/useZeroGamma';

// The panel orchestrates four per-ticker hook calls and renders four
// TickerCards plus a date scrubber. We mock the hook so the panel never
// hits the real /api/zero-gamma endpoint and we can drive each scenario
// (loading, error, data, empty) deterministically.
const useZeroGammaMock = vi.fn();
vi.mock('../../../hooks/useZeroGamma', () => ({
  useZeroGamma: (...args: unknown[]) => useZeroGammaMock(...args),
}));

// Pin "today" in ET so the LIVE button visibility logic is deterministic
// regardless of when the test runs. The panel reads getETToday() once on
// mount and compares the date input value to it to decide isLive.
vi.mock('../../../utils/timezone', async () => {
  const actual = await vi.importActual<
    typeof import('../../../utils/timezone')
  >('../../../utils/timezone');
  return {
    ...actual,
    getETToday: () => '2026-04-28',
  };
});

function row(overrides: Partial<ZeroGammaRow> = {}): ZeroGammaRow {
  return {
    ticker: 'SPX',
    spot: 7100,
    zeroGamma: 7050,
    confidence: 0.7,
    netGammaAtSpot: -1e9,
    gammaCurve: null,
    ts: '2026-04-28T20:10:00.000Z',
    ...overrides,
  };
}

function makeReturn(
  overrides: Partial<UseZeroGammaReturn> = {},
): UseZeroGammaReturn {
  return {
    latest: null,
    history: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  useZeroGammaMock.mockReset();
});

describe('ZeroGammaPanel orchestration', () => {
  it('renders the section with an accessible name', () => {
    useZeroGammaMock.mockReturnValue(makeReturn({ loading: true }));
    render(<ZeroGammaPanel marketOpen={true} />);
    // SectionBox renders <section aria-label="Zero Gamma">.
    expect(
      screen.getByRole('region', { name: /zero gamma/i }),
    ).toBeInTheDocument();
  });

  it('renders a TickerCard for each of the four tickers', () => {
    // Drive every per-ticker hook call into the loading branch so each
    // card prints its own header and we can count them by ticker label.
    useZeroGammaMock.mockReturnValue(makeReturn({ loading: true }));
    render(<ZeroGammaPanel marketOpen={true} />);
    // Four mock hook calls — one per TickerCardContainer.
    expect(useZeroGammaMock).toHaveBeenCalledTimes(4);
    for (const ticker of ['SPX', 'NDX', 'SPY', 'QQQ']) {
      expect(screen.getByText(ticker)).toBeInTheDocument();
    }
    // Loading is the per-card placeholder; should appear four times.
    expect(screen.getAllByText('Loading…')).toHaveLength(4);
  });

  it('surfaces per-ticker errors via TickerCard alert role', () => {
    useZeroGammaMock.mockReturnValue(
      makeReturn({ loading: false, error: 'Failed to load zero-gamma data' }),
    );
    render(<ZeroGammaPanel marketOpen={true} />);
    // Each card renders its own alert when error is set.
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(4);
    expect(alerts[0]).toHaveTextContent(/failed to load/i);
  });

  it('renders a TickerCard with data when the hook returns a snapshot', () => {
    const snapshot = row({ spot: 7100, zeroGamma: 7050 });
    useZeroGammaMock.mockReturnValue(
      makeReturn({ latest: snapshot, history: [snapshot], loading: false }),
    );
    render(<ZeroGammaPanel marketOpen={true} />);
    // At least one regime label means a data card actually rendered. All
    // four cards share the same mock return so we expect four labels.
    expect(screen.getAllByText('SUPPRESSION')).toHaveLength(4);
  });

  it('renders the empty "No data yet" state when latest is null without error/loading', () => {
    // This is the deserted-dashboard branch — easy to silently regress
    // into a blank panel or a crash if the hook ever returns latest=null
    // with loading=false and no error (e.g. archived day with no rows).
    useZeroGammaMock.mockReturnValue(
      makeReturn({ latest: null, history: [], loading: false, error: null }),
    );
    render(<ZeroGammaPanel marketOpen={true} />);
    expect(screen.getAllByText('No data yet')).toHaveLength(4);
  });

  it('starts with the LIVE button hidden when the date input is today', () => {
    useZeroGammaMock.mockReturnValue(makeReturn({ loading: true }));
    render(<ZeroGammaPanel marketOpen={true} />);
    // isLive=true by default → no LIVE reset button shown.
    expect(
      screen.queryByRole('button', { name: /^live$/i }),
    ).not.toBeInTheDocument();
    // Calls pass `null` for date when live (omits ?date=... in the hook).
    for (const call of useZeroGammaMock.mock.calls) {
      expect(call[2]).toBeNull();
    }
  });

  it('switches the date scrubber and reveals a LIVE button that snaps back', async () => {
    const user = userEvent.setup();
    useZeroGammaMock.mockReturnValue(makeReturn({ loading: true }));
    render(<ZeroGammaPanel marketOpen={true} />);

    const region = screen.getByRole('region', { name: /zero gamma/i });
    const dateInput = within(region).getByLabelText(/zero gamma date/i);

    // Scrub to a past date — LIVE button appears, hooks re-call with date.
    useZeroGammaMock.mockClear();
    await user.clear(dateInput);
    await user.type(dateInput, '2026-04-21');

    const liveBtn = await screen.findByRole('button', { name: /^live$/i });
    expect(liveBtn).toBeInTheDocument();

    // After scrubbing, the per-ticker hook calls should pass the date arg
    // and force marketOpen=false (no polling on a frozen historical day).
    const lastCall = useZeroGammaMock.mock.calls.at(-1);
    expect(lastCall?.[1]).toBe(false);
    expect(lastCall?.[2]).toBe('2026-04-21');

    // LIVE click resets to today and removes itself.
    await user.click(liveBtn);
    expect(
      screen.queryByRole('button', { name: /^live$/i }),
    ).not.toBeInTheDocument();
  });
});
