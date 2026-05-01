/**
 * GammaSqueezeFeed orchestration tests.
 *
 * Mocks `useGammaSqueezes` to control the data flowing into the feed,
 * and stubs `SqueezeRow` to a marker component so we only verify this
 * file's concerns: empty / loading / error states, scrubber wiring,
 * and per-squeeze row rendering. SqueezeRow internals are covered by
 * `src/__tests__/components/GammaSqueezes/SqueezeRow.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Mock } from 'vitest';

vi.mock('../../../hooks/useGammaSqueezes', () => ({
  useGammaSqueezes: vi.fn(),
}));
vi.mock('../SqueezeRow', () => ({
  SqueezeRow: ({
    squeeze,
  }: {
    squeeze: { compoundKey: string; ticker: string; strike: number };
  }) => (
    <div data-testid={`squeeze-row-${squeeze.compoundKey}`}>
      {squeeze.ticker} {squeeze.strike}
    </div>
  ),
}));

import { GammaSqueezeFeed } from '../GammaSqueezeFeed';
import { useGammaSqueezes } from '../../../hooks/useGammaSqueezes';
import {
  squeezeCompoundKey,
  type ActiveSqueeze,
  type GammaSqueezeRow,
} from '../types';

const mockedSqueezes = useGammaSqueezes as unknown as Mock;

// ── Factories ──────────────────────────────────────────────

function makeSqueeze(
  overrides: Partial<
    Pick<ActiveSqueeze, 'ticker' | 'strike' | 'side' | 'expiry'>
  > = {},
): ActiveSqueeze {
  const base = {
    ticker: 'NVDA' as ActiveSqueeze['ticker'],
    strike: 212.5,
    side: 'call' as const,
    expiry: '2026-04-28',
    ...overrides,
  };
  const latest: GammaSqueezeRow = {
    id: 1,
    ticker: base.ticker,
    strike: base.strike,
    side: base.side,
    expiry: base.expiry,
    ts: '2026-04-28T15:35:00Z',
    spotAtDetect: 211.4,
    pctFromStrike: -0.0052,
    spotTrend5m: 0.0012,
    volOi15m: 8.4,
    volOi15mPrior: 3.1,
    volOiAcceleration: 5.3,
    volOiTotal: 11.5,
    netGammaSign: 'unknown',
    squeezePhase: 'forming',
    contextSnapshot: null,
    spotAtClose: null,
    reachedStrike: null,
    maxCallPnlPct: null,
    freshnessMin: 0,
    progressPct: null,
    isStale: false,
    hhiNeighborhood: null,
    ivMorningVolCorr: null,
    precisionStackPass: false,
  };
  return {
    compoundKey: squeezeCompoundKey(base),
    ...base,
    latest,
    firstSeenTs: latest.ts,
    lastFiredTs: latest.ts,
    firingCount: 1,
  };
}

function defaultHookReturn(overrides: Record<string, unknown> = {}) {
  return {
    active: [] as ActiveSqueeze[],
    loading: false,
    error: null,
    refresh: vi.fn(),
    selectedDate: '2026-04-28',
    setSelectedDate: vi.fn(),
    scrubTime: null,
    isLive: true,
    isScrubbed: false,
    canScrubPrev: true,
    canScrubNext: false,
    scrubPrev: vi.fn(),
    scrubNext: vi.fn(),
    scrubTo: vi.fn(),
    scrubLive: vi.fn(),
    timeGrid: [],
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('GammaSqueezeFeed', () => {
  beforeEach(() => {
    mockedSqueezes.mockReset();
  });

  it('exposes the section with an accessible name', () => {
    mockedSqueezes.mockReturnValue(defaultHookReturn());
    render(<GammaSqueezeFeed marketOpen />);
    expect(
      screen.getByRole('region', { name: /Gamma Squeezes/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('toolbar', { name: /Replay date and time controls/ }),
    ).toBeInTheDocument();
  });

  it('renders the empty-state copy when there are no active squeezes', () => {
    mockedSqueezes.mockReturnValue(defaultHookReturn());
    render(<GammaSqueezeFeed marketOpen />);
    const empty = screen.getByTestId('squeeze-empty');
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveTextContent(/No active gamma squeezes/);
  });

  it('renders the loading copy when loading is true and there are no squeezes yet', () => {
    mockedSqueezes.mockReturnValue(defaultHookReturn({ loading: true }));
    render(<GammaSqueezeFeed marketOpen />);
    expect(screen.getByText(/loading…/)).toBeInTheDocument();
    // Empty-state copy must not double-render alongside the loader.
    expect(screen.queryByTestId('squeeze-empty')).not.toBeInTheDocument();
  });

  it('renders the error pill when error is set', () => {
    mockedSqueezes.mockReturnValue(
      defaultHookReturn({ error: 'connection refused' }),
    );
    render(<GammaSqueezeFeed marketOpen />);
    const err = screen.getByTestId('squeeze-error');
    expect(err).toBeInTheDocument();
    expect(err).toHaveTextContent(/error: connection refused/);
  });

  it('renders one SqueezeRow per active squeeze', () => {
    const squeezes = [
      makeSqueeze({ ticker: 'NVDA', strike: 212.5 }),
      makeSqueeze({ ticker: 'NVDA', strike: 215, side: 'put' }),
      makeSqueeze({ ticker: 'TSLA', strike: 280 }),
    ];
    mockedSqueezes.mockReturnValue(defaultHookReturn({ active: squeezes }));
    render(<GammaSqueezeFeed marketOpen />);
    for (const sq of squeezes) {
      expect(
        screen.getByTestId(`squeeze-row-${sq.compoundKey}`),
      ).toBeInTheDocument();
    }
    // Empty-state must NOT appear when rows are rendered.
    expect(screen.queryByTestId('squeeze-empty')).not.toBeInTheDocument();
  });

  it('disables scrub-prev when canScrubPrev is false and Live when already live', () => {
    mockedSqueezes.mockReturnValue(
      defaultHookReturn({ canScrubPrev: false, isLive: true }),
    );
    render(<GammaSqueezeFeed marketOpen />);
    expect(
      screen.getByRole('button', { name: 'Step scrubber back 5 minutes' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Return to live' }),
    ).toBeDisabled();
  });

  it('invokes scrubPrev / scrubNext / scrubLive when their buttons are clicked', () => {
    const scrubPrev = vi.fn();
    const scrubNext = vi.fn();
    const scrubLive = vi.fn();
    mockedSqueezes.mockReturnValue(
      defaultHookReturn({
        scrubPrev,
        scrubNext,
        scrubLive,
        isLive: false,
        canScrubPrev: true,
        canScrubNext: true,
      }),
    );
    render(<GammaSqueezeFeed marketOpen />);
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
    mockedSqueezes.mockReturnValue(
      defaultHookReturn({
        isLive: false,
        isScrubbed: true,
        scrubTime: '14:30',
        selectedDate: '2026-04-25',
        active: [makeSqueeze()],
      }),
    );
    render(<GammaSqueezeFeed marketOpen />);
    expect(
      screen.getByText(/showing squeezes active at 14:30 CT on 2026-04-25/),
    ).toBeInTheDocument();
  });

  it('shows the close-mode caption when isLive=false and isScrubbed=false', () => {
    mockedSqueezes.mockReturnValue(
      defaultHookReturn({
        isLive: false,
        isScrubbed: false,
        active: [makeSqueeze()],
        selectedDate: '2026-04-25',
      }),
    );
    render(<GammaSqueezeFeed marketOpen />);
    expect(
      screen.getByText(
        /showing squeezes active at session close \(2026-04-25\)/,
      ),
    ).toBeInTheDocument();
  });
});
