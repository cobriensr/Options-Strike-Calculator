/**
 * IVAnomaliesSection orchestration tests.
 *
 * Mocks both data hooks (useIVAnomalies, useAnomalyCrossAsset) and the
 * AnomalyRow child to a marker component. The point is to verify the
 * section's own concerns: tab switching, empty/loading/error states,
 * scrubber wiring. Row internals get their own tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Mock } from 'vitest';

vi.mock('../hooks/useIVAnomalies', () => ({
  useIVAnomalies: vi.fn(),
}));
vi.mock('../hooks/useAnomalyCrossAsset', () => ({
  useAnomalyCrossAsset: vi.fn(() => ({ contexts: {} })),
}));
vi.mock('../components/IVAnomalies/AnomalyRow', () => ({
  AnomalyRow: ({
    anomaly,
  }: {
    anomaly: { compoundKey: string; ticker: string; strike: number };
  }) => (
    <div data-testid={`anomaly-row-${anomaly.compoundKey}`}>
      {anomaly.ticker} {anomaly.strike}
    </div>
  ),
}));

import { IVAnomaliesSection } from '../components/IVAnomalies/IVAnomaliesSection';
import { useIVAnomalies } from '../hooks/useIVAnomalies';
import { anomalyCompoundKey } from '../components/IVAnomalies/types';
import type { ActiveAnomaly } from '../components/IVAnomalies/types';

const mockedAnomalies = useIVAnomalies as unknown as Mock;

// ── Factories ──────────────────────────────────────────────

function makeAnomaly(
  overrides: Partial<
    Pick<ActiveAnomaly, 'ticker' | 'strike' | 'side' | 'expiry'>
  > = {},
): ActiveAnomaly {
  const base = {
    ticker: 'SPXW' as const,
    strike: 5800,
    side: 'call' as const,
    expiry: '2026-04-30',
    ...overrides,
  };
  return {
    compoundKey: anomalyCompoundKey(base),
    ...base,
    latest: {} as ActiveAnomaly['latest'],
    firstSeenTs: '2026-04-27T13:00:00Z',
    lastFiredTs: '2026-04-27T13:05:00Z',
    firingCount: 1,
    phase: 'active',
    exitReason: null,
    entryIv: 0.2,
    peakIv: 0.22,
    peakTs: '2026-04-27T13:05:00Z',
    entryAskMidDiv: null,
    askMidPeakTs: null,
    ivHistory: [],
    firingHistory: [],
    tapeVolumeHistory: [],
    accumulatedAskSideVol: 0,
    accumulatedBidSideVol: 0,
  };
}

function defaultHookReturn(overrides: Record<string, unknown> = {}) {
  return {
    anomalies: [] as ActiveAnomaly[],
    loading: false,
    error: null,
    selectedDate: '2026-04-27',
    setSelectedDate: vi.fn(),
    scrubTime: null,
    isLive: true,
    isScrubbed: false,
    canScrubPrev: true,
    canScrubNext: false,
    scrubPrev: vi.fn(),
    scrubNext: vi.fn(),
    scrubLive: vi.fn(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('IVAnomaliesSection', () => {
  beforeEach(() => {
    mockedAnomalies.mockReset();
  });

  it('renders loading copy when loading is true and there are no anomalies', () => {
    mockedAnomalies.mockReturnValue(defaultHookReturn({ loading: true }));
    render(<IVAnomaliesSection marketOpen />);
    expect(screen.getByText(/Loading IV anomaly feed/)).toBeInTheDocument();
  });

  it('renders error copy when error is set and there are no anomalies', () => {
    mockedAnomalies.mockReturnValue(
      defaultHookReturn({ error: 'connection refused' }),
    );
    render(<IVAnomaliesSection marketOpen />);
    expect(
      screen.getByText(/IV anomaly feed unavailable \(connection refused\)/),
    ).toBeInTheDocument();
  });

  it('renders the live empty-state when there are no anomalies for the active tab and isLive is true', () => {
    mockedAnomalies.mockReturnValue(defaultHookReturn());
    render(<IVAnomaliesSection marketOpen />);
    expect(
      screen.getByText(/No active IV anomalies for SPXW right now/),
    ).toBeInTheDocument();
  });

  it('renders the scrubbed empty-state when not in live mode', () => {
    mockedAnomalies.mockReturnValue(
      defaultHookReturn({
        isLive: false,
        scrubTime: '13:30',
        selectedDate: '2026-04-25',
      }),
    );
    render(<IVAnomaliesSection marketOpen />);
    expect(screen.getByText(/at 13:30 CT on 2026-04-25/)).toBeInTheDocument();
  });

  it('renders a row for every anomaly on the active tab', () => {
    const anomalies = [
      makeAnomaly({ ticker: 'SPXW', strike: 5800 }),
      makeAnomaly({ ticker: 'SPXW', strike: 5810 }),
      makeAnomaly({ ticker: 'SPY', strike: 580 }),
    ];
    mockedAnomalies.mockReturnValue(defaultHookReturn({ anomalies }));
    render(<IVAnomaliesSection marketOpen />);
    expect(
      screen.getByTestId('anomaly-row-SPXW:5800:call:2026-04-30'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('anomaly-row-SPXW:5810:call:2026-04-30'),
    ).toBeInTheDocument();
    // SPY is on a different tab — should NOT render until tab is switched.
    expect(
      screen.queryByTestId('anomaly-row-SPY:580:call:2026-04-30'),
    ).not.toBeInTheDocument();
  });

  it('switches to the SPY tab and renders SPY rows when its tab is clicked', () => {
    const anomalies = [
      makeAnomaly({ ticker: 'SPXW', strike: 5800 }),
      makeAnomaly({ ticker: 'SPY', strike: 580 }),
    ];
    mockedAnomalies.mockReturnValue(defaultHookReturn({ anomalies }));
    render(<IVAnomaliesSection marketOpen />);
    fireEvent.click(screen.getByRole('tab', { name: /SPY/ }));
    expect(
      screen.getByTestId('anomaly-row-SPY:580:call:2026-04-30'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('anomaly-row-SPXW:5800:call:2026-04-30'),
    ).not.toBeInTheDocument();
  });

  it('renders a count badge per tab equal to the number of anomalies for that ticker', () => {
    const anomalies = [
      makeAnomaly({ ticker: 'SPXW', strike: 5800 }),
      makeAnomaly({ ticker: 'SPXW', strike: 5810 }),
      makeAnomaly({ ticker: 'SPY', strike: 580 }),
    ];
    mockedAnomalies.mockReturnValue(defaultHookReturn({ anomalies }));
    render(<IVAnomaliesSection marketOpen />);
    const spxwTab = screen.getByRole('tab', { name: /SPXW/ });
    expect(spxwTab).toHaveTextContent('2');
    const spyTab = screen.getByRole('tab', { name: /SPY/ });
    expect(spyTab).toHaveTextContent('1');
  });

  it('disables the prev scrub button when canScrubPrev is false', () => {
    mockedAnomalies.mockReturnValue(defaultHookReturn({ canScrubPrev: false }));
    render(<IVAnomaliesSection marketOpen />);
    expect(
      screen.getByRole('button', { name: 'Step scrubber back 5 minutes' }),
    ).toBeDisabled();
  });

  it('disables the Live button when already in live mode', () => {
    mockedAnomalies.mockReturnValue(defaultHookReturn({ isLive: true }));
    render(<IVAnomaliesSection marketOpen />);
    expect(
      screen.getByRole('button', { name: 'Return to live' }),
    ).toBeDisabled();
  });

  it('invokes scrubPrev/scrubNext/scrubLive when their buttons are clicked', () => {
    const scrubPrev = vi.fn();
    const scrubNext = vi.fn();
    const scrubLive = vi.fn();
    mockedAnomalies.mockReturnValue(
      defaultHookReturn({
        scrubPrev,
        scrubNext,
        scrubLive,
        isLive: false,
        canScrubPrev: true,
        canScrubNext: true,
      }),
    );
    render(<IVAnomaliesSection marketOpen />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Step scrubber back 5 minutes' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Step scrubber forward 5 minutes' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Return to live' }));
    expect(scrubPrev).toHaveBeenCalledOnce();
    expect(scrubNext).toHaveBeenCalledOnce();
    expect(scrubLive).toHaveBeenCalledOnce();
  });

  it('shows the scrubbed-mode caption when isScrubbed is true', () => {
    mockedAnomalies.mockReturnValue(
      defaultHookReturn({
        isLive: false,
        isScrubbed: true,
        scrubTime: '14:30',
        selectedDate: '2026-04-25',
        anomalies: [makeAnomaly()],
      }),
    );
    render(<IVAnomaliesSection marketOpen />);
    expect(
      screen.getByText(/showing alerts active at 14:30 CT on 2026-04-25/),
    ).toBeInTheDocument();
  });

  it('shows the close-mode caption when isLive=false and isScrubbed=false', () => {
    mockedAnomalies.mockReturnValue(
      defaultHookReturn({
        isLive: false,
        isScrubbed: false,
        anomalies: [makeAnomaly()],
        selectedDate: '2026-04-25',
      }),
    );
    render(<IVAnomaliesSection marketOpen />);
    expect(
      screen.getByText(/showing alerts active at session close/),
    ).toBeInTheDocument();
  });

  it('renders the small inline error pill alongside data when there are anomalies AND an error', () => {
    mockedAnomalies.mockReturnValue(
      defaultHookReturn({
        anomalies: [makeAnomaly()],
        error: 'stale poll',
      }),
    );
    render(<IVAnomaliesSection marketOpen />);
    expect(screen.getByText('stale poll')).toBeInTheDocument();
    // Row should still render — the error must NOT replace the body when
    // we already have anomalies on the board.
    expect(
      screen.getByTestId('anomaly-row-SPXW:5800:call:2026-04-30'),
    ).toBeInTheDocument();
  });
});
