/**
 * FuturesGammaPlaybook container + Phase 1B panel tests.
 *
 * We mock `useFuturesGammaPlaybook` at the module level so the container's
 * render logic is exercised against deterministic fixtures. The underlying
 * hook composition is covered by `useFuturesGammaPlaybook.test.ts` — tests
 * here assert what the UI actually renders for a given hook return.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CollapseAllContext } from '../../../components/collapse-context';
import type { CollapseSignal } from '../../../components/collapse-context';
import type { UseFuturesGammaPlaybookReturn } from '../../../hooks/useFuturesGammaPlaybook';
import type {
  PlaybookBias,
  PlaybookRule,
} from '../../../components/FuturesGammaPlaybook/types';

// ── Mocks ────────────────────────────────────────────────────

vi.mock('../../../hooks/useFuturesGammaPlaybook', () => ({
  useFuturesGammaPlaybook: vi.fn(),
}));

// ServerEventsStrip + AlertConfigPanel pull in `usePushSubscription` and
// `useRegimeEventsHistory`, which fire real `fetch` calls. Stub them
// here so the container tests focus on layout rather than network.
vi.mock('../../../hooks/usePushSubscription', () => ({
  usePushSubscription: vi.fn(() => ({
    permission: 'default',
    isSubscribed: false,
    isSubscribing: false,
    error: null,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    requestPermission: vi.fn(),
  })),
}));

vi.mock('../../../hooks/useRegimeEventsHistory', () => ({
  useRegimeEventsHistory: vi.fn(() => ({
    events: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

import { useFuturesGammaPlaybook } from '../../../hooks/useFuturesGammaPlaybook';
import FuturesGammaPlaybook from '../../../components/FuturesGammaPlaybook';

// ── Helpers ──────────────────────────────────────────────────

function makeBias(overrides: Partial<PlaybookBias> = {}): PlaybookBias {
  return {
    regime: 'POSITIVE',
    verdict: 'MEAN_REVERT',
    esZeroGamma: 5805,
    esCallWall: 5820,
    esPutWall: 5790,
    sessionPhase: 'MORNING',
    firedTriggers: [],
    ...overrides,
  };
}

function makeRule(overrides: Partial<PlaybookRule> = {}): PlaybookRule {
  return {
    id: 'pos-fade-call-wall',
    condition: 'Fade rallies into call wall at 5820.00',
    direction: 'SHORT',
    entryEs: 5820,
    targetEs: 5805,
    stopEs: 5820.25,
    sizingNote:
      'Tight stops — one ES tick above the wall invalidates the fade.',
    distanceEsPoints: 8,
    status: 'ARMED',
    conviction: 'standard',
    ...overrides,
  };
}

function hookReturn(
  overrides: Partial<UseFuturesGammaPlaybookReturn> = {},
): UseFuturesGammaPlaybookReturn {
  const bias = overrides.bias ?? makeBias();
  return {
    regime: bias.regime,
    verdict: bias.verdict,
    phase: bias.sessionPhase,
    levels: [],
    rules: [makeRule()],
    bias,
    esPrice: 5812,
    esSpxBasis: 12,
    esZeroGamma: bias.esZeroGamma,
    esCallWall: bias.esCallWall,
    esPutWall: bias.esPutWall,
    esGammaPin: null,
    flowSignals: {
      upsideTargetCls: null,
      downsideTargetCls: null,
      ceilingTrend5m: null,
      floorTrend5m: null,
      priceTrend: null,
    },
    tradeBias: {
      direction: 'NEUTRAL',
      conviction: 'neutral',
      entryEs: null,
      reason: 'all setups distant',
    },
    regimeTimeline: [],
    sessionPhaseBoundaries: {
      open: '2026-04-20T09:30:00-04:00',
      lunch: '2026-04-20T12:30:00-04:00',
      power: '2026-04-20T15:30:00-04:00',
      close: '2026-04-20T16:30:00-04:00',
    },
    loading: false,
    maxPainLoading: false,
    error: null,
    timestamp: '2026-04-20T14:30:00Z',
    timestamps: [
      '2026-04-20T14:00:00Z',
      '2026-04-20T14:15:00Z',
      '2026-04-20T14:30:00Z',
    ],
    selectedDate: '2026-04-20',
    setSelectedDate: vi.fn(),
    isLive: true,
    isScrubbed: false,
    canScrubPrev: true,
    canScrubNext: false,
    scrubPrev: vi.fn(),
    scrubNext: vi.fn(),
    scrubTo: vi.fn(),
    scrubLive: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  };
}

const collapseSignal: CollapseSignal = { version: 0, collapsed: false };

function renderPanel(
  hookOverrides: Partial<UseFuturesGammaPlaybookReturn> = {},
  props: {
    marketOpen?: boolean;
    onBiasChange?: (b: PlaybookBias) => void;
  } = {},
) {
  vi.mocked(useFuturesGammaPlaybook).mockReturnValue(hookReturn(hookOverrides));
  return render(
    <CollapseAllContext.Provider value={collapseSignal}>
      <FuturesGammaPlaybook
        marketOpen={props.marketOpen ?? true}
        onBiasChange={props.onBiasChange}
      />
    </CollapseAllContext.Provider>,
  );
}

// ── Tests ────────────────────────────────────────────────────

describe('FuturesGammaPlaybook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the SectionBox with the playbook label', () => {
    renderPanel();
    // The SectionBox renders the label uppercased in the title.
    expect(
      screen.getByRole('region', { name: 'FUTURES GAMMA PLAYBOOK' }),
    ).toBeInTheDocument();
  });

  it('renders the MEAN-REVERT verdict for POSITIVE regime', () => {
    renderPanel({
      bias: makeBias({ verdict: 'MEAN_REVERT', regime: 'POSITIVE' }),
    });
    expect(screen.getByText('MEAN-REVERT')).toBeInTheDocument();
    expect(screen.getByText('+GEX dampened')).toBeInTheDocument();
  });

  it('renders the TREND-FOLLOW verdict for NEGATIVE regime', () => {
    renderPanel({
      bias: makeBias({ verdict: 'TREND_FOLLOW', regime: 'NEGATIVE' }),
      rules: [makeRule({ id: 'neg-break-call-wall', direction: 'LONG' })],
    });
    expect(screen.getByText('TREND-FOLLOW')).toBeInTheDocument();
    expect(screen.getByText('−GEX trending')).toBeInTheDocument();
  });

  it('renders the STAND ASIDE verdict + stand-aside copy when rules empty', () => {
    renderPanel({
      bias: makeBias({ verdict: 'STAND_ASIDE', regime: 'TRANSITIONING' }),
      rules: [],
    });
    expect(screen.getByText('STAND ASIDE')).toBeInTheDocument();
    expect(screen.getByText('TRANSITIONING')).toBeInTheDocument();
    expect(
      screen.getByText(/Stand aside — no setups active/i),
    ).toBeInTheDocument();
  });

  it('renders stand-aside reason for POST_CLOSE phase', () => {
    renderPanel({
      bias: makeBias({
        verdict: 'STAND_ASIDE',
        regime: 'POSITIVE',
        sessionPhase: 'POST_CLOSE',
      }),
      rules: [],
    });
    expect(screen.getByText(/Outside RTH/i)).toBeInTheDocument();
  });

  it('renders rule rows with direction badges and entry/target/stop', () => {
    const rules: PlaybookRule[] = [
      makeRule({ id: 'r1', direction: 'SHORT', entryEs: 5820, targetEs: 5805 }),
      makeRule({
        id: 'r2',
        direction: 'LONG',
        condition: 'Buy dips into put wall at 5790.00',
        entryEs: 5790,
        targetEs: 5805,
      }),
    ];
    renderPanel({ rules });
    expect(
      screen.getByText(/Fade rallies into call wall/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Buy dips into put wall/i)).toBeInTheDocument();
    expect(screen.getByText('SHORT')).toBeInTheDocument();
    expect(screen.getByText('LONG')).toBeInTheDocument();
  });

  it('renders the ScrubControls (prev/next + date picker + refresh)', () => {
    renderPanel();
    expect(
      screen.getByRole('button', { name: 'Previous snapshot' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Next snapshot' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Select date')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Refresh Futures Gamma Playbook/i }),
    ).toBeInTheDocument();
  });

  it('fires onBiasChange once on mount and on bias change', async () => {
    const onBiasChange = vi.fn();
    const { rerender } = renderPanel({}, { onBiasChange });
    // useEffect fires after render.
    await Promise.resolve();
    expect(onBiasChange).toHaveBeenCalledTimes(1);
    expect(onBiasChange.mock.calls[0]?.[0]?.regime).toBe('POSITIVE');

    // Change the bias → callback fires again.
    vi.mocked(useFuturesGammaPlaybook).mockReturnValue(
      hookReturn({
        bias: makeBias({ regime: 'NEGATIVE', verdict: 'TREND_FOLLOW' }),
      }),
    );
    rerender(
      <CollapseAllContext.Provider value={collapseSignal}>
        <FuturesGammaPlaybook marketOpen onBiasChange={onBiasChange} />
      </CollapseAllContext.Provider>,
    );
    await Promise.resolve();
    expect(onBiasChange).toHaveBeenCalledTimes(2);
    expect(onBiasChange.mock.calls[1]?.[0]?.regime).toBe('NEGATIVE');
  });

  it('does not fire onBiasChange on re-render when bias is unchanged', async () => {
    const onBiasChange = vi.fn();
    const { rerender } = renderPanel({}, { onBiasChange });
    await Promise.resolve();
    expect(onBiasChange).toHaveBeenCalledTimes(1);

    // Re-render with the same bias object shape (new reference, same fields).
    vi.mocked(useFuturesGammaPlaybook).mockReturnValue(hookReturn());
    rerender(
      <CollapseAllContext.Provider value={collapseSignal}>
        <FuturesGammaPlaybook marketOpen onBiasChange={onBiasChange} />
      </CollapseAllContext.Provider>,
    );
    await Promise.resolve();
    expect(onBiasChange).toHaveBeenCalledTimes(1);
  });

  it('renders loading state when loading with no data yet', () => {
    renderPanel({
      loading: true,
      rules: [],
      bias: makeBias({ esZeroGamma: null }),
    });
    expect(
      screen.getByText(/Loading futures gamma playbook/i),
    ).toBeInTheDocument();
  });

  it('renders error state via role=alert', () => {
    renderPanel({ error: new Error('ES feed offline') });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('ES feed offline');
  });

  it('shows ES price and basis in the header', () => {
    renderPanel({ esPrice: 5812.25, esSpxBasis: 12.5 });
    expect(screen.getByText('5812.25')).toBeInTheDocument();
    expect(screen.getByText(/basis \+12\.50/)).toBeInTheDocument();
  });

  it('shows em-dash when ES price or basis is unavailable', () => {
    renderPanel({ esPrice: null, esSpxBasis: null });
    expect(screen.getByText(/basis —/)).toBeInTheDocument();
  });
});
